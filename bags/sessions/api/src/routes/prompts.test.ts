/**
 * The delivery routes, over real HTTP against a real store.
 *
 * Every process but this API reaches delivery through these routes, so the
 * thing being tested IS the transport: a wait that works when called as a
 * function and hangs over HTTP has failed at the only layer they use.
 *
 * The latency assertion is the load-bearing one. A wait would still "work"
 * with the notifier gone — the store recheck finds the prompt within a second
 * — so a test that only asserted "the message arrives" would pass against the
 * broken build. It asserts the deadline instead.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { servedRoutes } from "@barry-rocks/sdk/services/http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-prompts-")), "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("@barry-rocks/sessions-bag/store/sessions-db");
const store = await import("@barry-rocks/sessions-bag/store/sessions-store-api");
const client = await import("@barry-rocks/sessions-bag/client");
const { createDelivery } = await import("../delivery.js");
const { promptsRouter } = await import("./prompts.js");

// Installed as the API does, so a prompt queued through the client in this
// process wakes the waiters at once.
const delivery = createDelivery();
client.hostDelivery(delivery);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/prompts", promptsRouter(delivery));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("expected a TCP address");
  baseUrl = `http://127.0.0.1:${address.port}/api/v1/prompts`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeSessionsDb();
});

function seedSession(id: string): void {
  getSessionsSqlite()
    .prepare("INSERT INTO sessions (id, user_id, active, state, status, metadata) VALUES (?,1,1,'open','running','{}')")
    .run(id);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

const queue = (sessionId: string, content: string, fromSession?: string) =>
  client.queuePrompt(sessionId, content, { source: "session", fromSession });

describe("waiting for a prompt", () => {
  it("returns at once when one is already pending", async () => {
    seedSession("already-pending");
    await queue("already-pending", "hello");

    const started = Date.now();
    const body = await post("wait", { sessionIds: ["already-pending"], timeoutMs: 5_000 });

    expect(body.ready).toEqual(["already-pending"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("peeks — waiting does not consume the prompt", async () => {
    seedSession("peek-only");
    await queue("peek-only", "still here");

    await post("wait", { sessionIds: ["peek-only"], timeoutMs: 5_000 });

    // A wait that drained would lose the message when its caller died in
    // flight. Only popPrompts consumes.
    expect(await client.popPrompts("peek-only")).toHaveLength(1);
  });

  it("times out with an empty ready list when nothing arrives", async () => {
    seedSession("quiet");

    const started = Date.now();
    const body = await post("wait", { sessionIds: ["quiet"], timeoutMs: 300 });

    expect(body.ready).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("wakes on the queue itself, not at the next store read", async () => {
    seedSession("fast-wake");

    const started = Date.now();
    const waiting = post("wait", { sessionIds: ["fast-wake"], timeoutMs: 10_000 });
    // Let the request reach the server and park before the queue lands.
    await new Promise((r) => setTimeout(r, 50));
    await queue("fast-wake", "wake up");

    const body = await waiting;
    const elapsed = Date.now() - started;

    expect(body.ready).toEqual(["fast-wake"]);
    // NEGATIVE CONTROL: drop `promptQueued` from the client's queuePrompt and
    // this fails — the store recheck answers at ~1 s instead. The bound sits
    // well under that while staying clear of a loaded CI host.
    expect(elapsed).toBeLessThan(600);
  });

  it("finds a prompt another process queued at its next read of the store", async () => {
    seedSession("other-writer");

    const waiting = post("wait", { sessionIds: ["other-writer"], timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    // Straight into the store, as another process writes it: nothing here
    // hears about it, so only the recheck can find it.
    await store.queuePrompt("other-writer", "from elsewhere", { source: "session" });

    expect((await waiting).ready).toEqual(["other-writer"]);
  });

  it("wakes the waiter for the session the prompt was queued for, not another", async () => {
    seedSession("watcher-a");
    seedSession("watcher-b");

    const waiting = post("wait", { sessionIds: ["watcher-a", "watcher-b"], timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    await queue("watcher-b", "for b");

    expect((await waiting).ready).toEqual(["watcher-b"]);
  });

  it("wakes a waiter when a failed prompt is retried", async () => {
    seedSession("retried");
    await client.recordPromptDelivery("retried", "try again", {
      clientMessageId: "retry-1",
      delivery: "failed",
      source: "web_prompt",
    });

    const waiting = post("wait", { sessionIds: ["retried"], timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    await client.claimFailedPromptRetry("retried", "retry-1", "try again");

    expect((await waiting).ready).toEqual(["retried"]);
  });

  it("stops waiting when the caller hangs up", async () => {
    seedSession("hung-up");
    const caller = new AbortController();
    const started = Date.now();
    const waiting = delivery.waitForPrompts(["hung-up"], 10_000, caller.signal);
    setTimeout(() => caller.abort(), 50);

    expect(await waiting).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses a malformed session list rather than waiting on nothing", async () => {
    const res = await fetch(`${baseUrl}/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("what a sender is told", () => {
  it("reports `none` until a surface registers, then what that surface promises", async () => {
    const before = await post("guarantee", { sessionIds: ["listener-demo"] });
    expect((before.guarantees as Record<string, { guarantee: string }>)["listener-demo"].guarantee).toBe("none");

    expect(await post("listeners", { sessionId: "listener-demo", kind: "runtime", guarantee: "wake" }))
      .toEqual({ ok: true, guarantee: "wake" });

    const after = await post("guarantee", { sessionIds: ["listener-demo"] });
    expect((after.guarantees as Record<string, { guarantee: string }>)["listener-demo"].guarantee).toBe("wake");
  });

  it("drops back to `none` when the surface deregisters", async () => {
    await post("listeners", { sessionId: "listener-gone", kind: "runtime", guarantee: "wake" });
    await post("listeners", { sessionId: "listener-gone", kind: "runtime", active: false });

    const body = await post("guarantee", { sessionIds: ["listener-gone"] });
    expect((body.guarantees as Record<string, { guarantee: string }>)["listener-gone"].guarantee).toBe("none");
  });

  it("refuses a guarantee it does not recognise instead of defaulting", async () => {
    // A surface recorded with a defaulted guarantee would have a sender told a
    // promise nothing made.
    const res = await fetch(`${baseUrl}/listeners`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s", kind: "runtime", guarantee: "instantly" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("the loop guard", () => {
  it("refuses a sender bursting at one recipient, and says why", async () => {
    const verdicts = [];
    for (let i = 0; i < 6; i++) {
      verdicts.push(await post("wake-budget", { sessionId: "burst-target", fromSession: "loud" }));
    }

    expect(verdicts.slice(0, 5).every((v) => v.allowed === true)).toBe(true);
    expect(verdicts[5]).toMatchObject({ allowed: false, reason: "sender-burst" });
  });

  it("leaves a throttled message pending rather than dropping it", async () => {
    seedSession("throttled");
    for (let i = 0; i < 5; i++) {
      await post("wake-budget", { sessionId: "throttled", fromSession: "loud" });
    }
    expect(await post("wake-budget", { sessionId: "throttled", fromSession: "loud" }))
      .toMatchObject({ allowed: false });

    // The budget governs WAKING, never storage: the message is still there to
    // be read on the session's next tool call or resume.
    await queue("throttled", "over budget", "loud");
    expect(await client.getPrompts("throttled")).toHaveLength(1);
  });

  it("does not consume budget when only asked", async () => {
    for (let i = 0; i < 10; i++) {
      const verdict = await post("wake-budget", { sessionId: "peek-budget", fromSession: "peek-sender", consume: false });
      expect(verdict.allowed).toBe(true);
    }
  });
});

it("declares the guarantee route and keeps underscored session ids verbatim", async () => {
  expect(servedRoutes(promptsRouter(delivery))).toContain(sessionsRoutes.listDeliveryGuarantees);
  const res = await fetch(`${baseUrl}/guarantee`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionIds: ["s_with_underscores"] }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ guarantees: { s_with_underscores: { guarantee: "none", listeners: [] } } });
});
