/**
 * The hook's hold at turn-end: what it hands the vendor, and that it takes the
 * message out of the inbox so it is delivered once.
 *
 * Against a real store (a scratch database, reached directly) and over HTTP to
 * the delivery routes, because the defect this replaced was the address: it
 * asked for a route nothing there served, and every hold came back empty.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestInstance } from "@barry-rocks/sdk/services";

let api: Server;

async function bodyOf(request: IncomingMessage): Promise<{ sessionIds?: string[]; timeoutMs?: number }> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}

/**
 * The sessions API's delivery routes, as far as a hold uses them: a wait that
 * answers once the real store holds a prompt for a watched session, and the
 * listener calls. A hook is not the delivery host, so it asks over HTTP, as it
 * does in production.
 */
async function deliveryApi(): Promise<Server> {
  const { getPrompts } = await import("@barry-rocks/sessions-bag/client");
  const server = createServer((request, response) => {
    void (async () => {
      const body = await bodyOf(request);
      let answer: unknown = { ok: true, guarantee: "wake" };
      if (request.url === "/api/v1/prompts/wait") {
        const deadline = Date.now() + (body.timeoutMs ?? 0);
        const ready: string[] = [];
        while (ready.length === 0 && Date.now() < deadline) {
          for (const id of body.sessionIds ?? []) if ((await getPrompts(id)).length > 0) ready.push(id);
          if (ready.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        answer = { ready };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

beforeAll(async () => {
  process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-hook-")), "sessions.db");
  api = await deliveryApi();
  const address = api.address();
  if (typeof address === "string" || address === null) throw new Error("expected a TCP address");
  useTestInstance({ "sessions.api": `http://127.0.0.1:${address.port}` });
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

describe("holding at turn-end for a queued message", () => {
  it("hands over what was queued, phrased as the inbox phrases it, and takes it out", async () => {
    const { queuePrompt, getPrompts } = await import("@barry-rocks/sessions-bag/client");
    const { getSessionsSqlite } = await import("@barry-rocks/sessions-bag/store/sessions-db");
    const { waitForQueuedMessage } = await import("./hook-record.js");
    // A tracked session's row, as `barry hook` creates on its first event.
    getSessionsSqlite()
      .prepare("INSERT INTO sessions (id, active, state, status, metadata) VALUES ('sess-tracked', 1, 'open', 'running', '{}')")
      .run();
    await queuePrompt("sess-tracked", "check the deploy", { source: "web_prompt" });

    const message = await waitForQueuedMessage("sess-tracked");

    expect(message).toContain("check the deploy");
    expect(await getPrompts("sess-tracked")).toEqual([]);
  });
});

describe("a TUI Barry launched", () => {
  it("is served under its own session id, not filed as a foreign guest", async () => {
    const { launchedSessionId } = await import("./hook-record.js");
    expect(launchedSessionId({ BARRY_SESSION_ID: "sess-own" })).toBe("sess-own");
    expect(launchedSessionId({})).toBeNull();
  });

  it("hands over a message that lands while its stop hook holds", async () => {
    const { queuePrompt } = await import("@barry-rocks/sessions-bag/client");
    const { getSessionsSqlite } = await import("@barry-rocks/sessions-bag/store/sessions-db");
    const { holdForLaunchedSession } = await import("./hook-record.js");
    getSessionsSqlite()
      .prepare("INSERT INTO sessions (id, active, state, status, metadata) VALUES ('sess-launched', 1, 'open', 'running', '{}')")
      .run();

    const held = holdForLaunchedSession("sess-launched");
    // Lands after the hold began, as a phone message into a quiet TUI does.
    setTimeout(() => void queuePrompt("sess-launched", "from the phone", { source: "web_prompt" }), 300);

    await expect(held).resolves.toContain("from the phone");
  });
});

describe("holds that should let go", () => {
  const open = async (id: string) => {
    const { getSessionsSqlite } = await import("@barry-rocks/sessions-bag/store/sessions-db");
    getSessionsSqlite().prepare("INSERT INTO sessions (id, active, state, status, metadata) VALUES (?, 1, 'open', 'running', '{}')").run(id);
  };

  it("an older turn's hold yields to a newer one, leaving the message for it", async () => {
    const { queuePrompt } = await import("@barry-rocks/sessions-bag/client");
    const { holdForLaunchedSession } = await import("./hook-record.js");
    await open("sess-two-holds");
    const older = holdForLaunchedSession("sess-two-holds", { generationId: "gen-1" });
    const newer = holdForLaunchedSession("sess-two-holds", { generationId: "gen-2" });
    setTimeout(() => void queuePrompt("sess-two-holds", "for the latest turn", { source: "web_prompt" }), 300);

    await expect(newer).resolves.toContain("for the latest turn");
    await expect(older).resolves.toBeNull();
  });

  it("a hold whose TUI has exited gives up, leaving the message queued", async () => {
    const { queuePrompt, getPrompts } = await import("@barry-rocks/sessions-bag/client");
    const { holdForLaunchedSession } = await import("./hook-record.js");
    await open("sess-orphaned");
    await queuePrompt("sess-orphaned", "nobody to start a turn", { source: "web_prompt" });

    await expect(holdForLaunchedSession("sess-orphaned", { parentGone: () => true })).resolves.toBeNull();
    expect((await getPrompts("sess-orphaned")).map((prompt) => prompt.content)).toEqual(["nobody to start a turn"]);
  });
});
