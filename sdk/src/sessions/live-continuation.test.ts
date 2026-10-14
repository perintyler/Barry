import { describe, expect, it } from "vitest";
import { EventQueue, type Session, type SessionConfig, type SessionEvent } from "./index.js";
import { LiveContinuation } from "./live-continuation.js";

const guarantees = { capture: "total", delivery: "wake", steer: true, interrupt: true, gating: "per-call", keepsVendorUi: false, identity: "inherent" } as const;
const config: SessionConfig = { sessionId: "session", cwd: "/tmp", env: {}, mcpServers: {} };
function fixture() {
  let effects = 0; let closed = false;
  const queue = new EventQueue<SessionEvent>();
  const start = async (input: SessionConfig): Promise<Session> => ({
    id: "session", harnessSessionId: "vendor-session", harnessVersion: "version", mode: "hosted", guarantees,
    events: () => queue, status: () => "active", answer: async () => {}, interrupt: async () => { queue.push({ type: "done" }); },
    close: async () => { closed = true; queue.end(); },
    deliver: async () => {
      void (async () => {
        queue.push({ type: "tool_use", id: "original", tool: "effect", input: { exact: "input" } });
        const decision = await input.decide!({ id: "original", tool: "effect", input: { exact: "input" } });
        if (decision.allow) effects++;
        queue.push({ type: "tool_result", id: "original", result: decision.allow ? "Done" : "Denied", error: !decision.allow });
        queue.push({ type: "partial", text: "Finished" });
        queue.push({ type: "done" });
      })();
      return { messageId: "input", status: "started" };
    },
  });
  return { start, get effects() { return effects; }, get closed() { return closed; } };
}

describe("live approval continuation", () => {
  it("retains the callback and waits for the effect journal before returning approval", async () => {
    const f = fixture(); const events: SessionEvent[] = [];
    const handle = await LiveContinuation.open("opaque", "config", config, f.start);
    const paused = await handle.begin("Work", async (event) => { events.push(event); });
    expect(paused.type).toBe("interrupted"); expect(f.effects).toBe(0); expect(f.closed).toBe(false);
    if (paused.type !== "interrupted") throw new Error("Expected pause");
    let journalCommitted = false;
    const completed = await handle.restore(paused.continuation, new Map([["original", { allow: true }]]), {
      authorize: async () => ({ allow: true }),
      execute: async (_call, effect) => {
        expect(f.effects).toBe(0); const outcome = await effect(); journalCommitted = true; return outcome;
      },
    }, async (event) => { if (event.type === "tool_result") expect(journalCommitted).toBe(true); events.push(event); });
    expect(completed.type).toBe("completed"); expect(f.effects).toBe(1);
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(1);
    await handle.close(); expect(f.closed).toBe(true);
  });

  it("refuses to restore a dead runtime and rechecks authority before any effect", async () => {
    const original = fixture(); const handle = await LiveContinuation.open("opaque", "config", config, original.start);
    const paused = await handle.begin("Work", async () => {});
    if (paused.type !== "interrupted") throw new Error("Expected pause");
    const fresh = fixture(); const replacement = await LiveContinuation.open("opaque", "config", config, fresh.start);
    expect(() => replacement.validate(paused.continuation)).toThrow("original harness");
    await handle.restore(paused.continuation, new Map([["original", { allow: true }]]), {
      authorize: async () => ({ allow: false, reason: "Revoked" }),
      execute: async () => { throw new Error("Must not execute"); },
    }, async () => {});
    expect(original.effects).toBe(0);
    await handle.close(); await replacement.close();
  });
});
