/**
 * The delivery calls from a process that is not the sessions API: over HTTP,
 * and honest when the API cannot be reached.
 *
 * The failure half is the one that matters. These calls answer "will this
 * message wake anyone" and "is this wake within budget", and an unreachable
 * API must never read as "no listeners" or "allowed" — the second would wave a
 * session-to-session loop straight through its only guard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { useTestInstance } from "@barry-rocks/sdk/services";
import { getListeners, recordWake, registerListener, unregisterListener, waitForPrompts } from "./delivery.js";

interface Received { path: string; authorization?: string; body: unknown }
const received: Received[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let server: Server;
let apiUrl: string;

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}

beforeAll(async () => {
  process.env.BARRY_SECRET = "delivery-test-secret";
  server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
      received.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a TCP address");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  delete process.env.BARRY_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("asking the sessions API", () => {
  it("sends each call to its route with the instance secret, and reads the answer", async () => {
    useTestInstance({ "sessions.api": apiUrl });
    received.length = 0;

    answer = { status: 200, body: { guarantees: { s1: { guarantee: "wake", listeners: [] } } } };
    expect(await getListeners(["s1"])).toEqual({ s1: { guarantee: "wake", listeners: [] } });
    answer = { status: 200, body: { allowed: false, reason: "sender-burst", retryAt: 5 } };
    expect(await recordWake("s1", "s2")).toEqual({ allowed: false, reason: "sender-burst", retryAt: 5 });
    answer = { status: 200, body: { ready: ["s1"] } };
    expect(await waitForPrompts(["s1"], 1_000)).toEqual(["s1"]);
    answer = { status: 200, body: { ok: true, guarantee: "wake" } };
    await registerListener("s1", "terminal", "wake");
    await unregisterListener("s1", "terminal");

    expect(received.map((r) => r.path)).toEqual([
      "/api/v1/prompts/guarantee",
      "/api/v1/prompts/wake-budget",
      "/api/v1/prompts/wait",
      "/api/v1/prompts/listeners",
      "/api/v1/prompts/listeners",
    ]);
    expect(received.every((r) => r.authorization === "Bearer delivery-test-secret")).toBe(true);
    expect(received.map((r) => r.body)).toEqual([
      { sessionIds: ["s1"] },
      { sessionId: "s1", fromSession: "s2" },
      { sessionIds: ["s1"], timeoutMs: 1_000 },
      { sessionId: "s1", kind: "terminal", guarantee: "wake" },
      { sessionId: "s1", kind: "terminal", active: false },
    ]);
  });

  it("reports a refusal as an error, not as an answer", async () => {
    useTestInstance({ "sessions.api": apiUrl });
    answer = { status: 500, body: { ok: false, error: "boom" } };

    await expect(recordWake("s1", "s2")).rejects.toThrow(/HTTP 500/);
    await expect(getListeners(["s1"])).rejects.toThrow(/HTTP 500/);
  });

  it("reports an API it cannot reach as unreachable, never as `none` or `allowed`", async () => {
    // The scratch registry's own sessions.api: a port nothing listens on.
    useTestInstance();

    await expect(getListeners(["s1"])).rejects.toThrow(/unreachable/);
    await expect(recordWake("s1", "s2")).rejects.toThrow(/unreachable/);
    await expect(registerListener("s1", "terminal", "wake")).rejects.toThrow(/unreachable/);
    await expect(waitForPrompts(["s1"], 100)).rejects.toThrow(/unreachable/);
  });
});
