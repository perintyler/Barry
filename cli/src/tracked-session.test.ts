import { describe, expect, it, vi } from "vitest";
import { trackSession, withSessionRecorder, type SessionRecorder } from "./tracked-session.js";
import type { Session, SessionEvent } from "@barry-rocks/sdk/sessions";

/** What reached the store, in the order the inserts ran. */
const stored: string[] = [];
vi.mock("@barry-rocks/sessions-bag/client", () => ({
  createProviderSession: vi.fn(async () => {}),
  // The store numbers a message as its insert runs: a slow first append that
  // was overtaken would be stored, and numbered, second.
  appendMessage: vi.fn(async (_sessionId: string, message: { content?: string }) => {
    if (message.content === "slow") await new Promise((resolve) => setTimeout(resolve, 30));
    stored.push(message.content ?? "");
    return stored.length - 1;
  }),
}));

function source(events: SessionEvent[]): Session {
  return {
    id: "barry", harnessSessionId: "vendor", harnessVersion: null, mode: "hosted",
    guarantees: {} as Session["guarantees"], status: () => "idle",
    deliver: async () => ({ messageId: "user", status: "started" }),
    async *events() { yield* events; }, interrupt: async () => {}, answer: async () => {}, close: async () => {},
  };
}
describe("one-shot session recording", () => {
  it("records links once, preserves tool correlation and records terminal events before returning", async () => {
    const events: SessionEvent[] = [
      { type: "init", harnessSessionId: "vendor" },
      { type: "tool_use", id: "call", tool: "mcp__probe__echo", input: { marker: "one" }, parentToolUseId: "parent" },
      { type: "tool_result", id: "call", result: { marker: "one" }, parentToolUseId: "parent" },
      { type: "result", result: "answer" }, { type: "done", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    ];
    const recorder = { link: vi.fn<SessionRecorder["link"]>(async () => {}), message: vi.fn<SessionRecorder["message"]>(async () => {}) };
    const session = withSessionRecorder(source(events), recorder);
    await session.deliver("question");
    const received = [];
    let recordedAtDone = 0;
    for await (const event of session.events()) {
      if (event.type === "done") recordedAtDone = recorder.message.mock.calls.length;
      received.push(event);
    }
    expect(received).toEqual(events);
    expect(recorder.link.mock.calls).toEqual([["vendor"]]);
    expect(recorder.message.mock.calls.map(call => call[0])).toEqual([
      { type: "text", role: "user", content: "question" },
      { type: "tool_start", name: "mcp__probe__echo", input: { marker: "one" }, toolUseId: "call", parentToolUseId: "parent" },
      { type: "tool_result", toolUseId: "call", result: '{"marker":"one"}', parentToolUseId: "parent" },
      { type: "text", role: "assistant", content: "answer" },
      { type: "result", result: "answer", error: undefined, metadata: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } },
    ]);
    expect(recordedAtDone).toBe(5);
  });
  it("does not duplicate final text and resets result state between turns", async () => {
    const recorder = { link: vi.fn<SessionRecorder["link"]>(async () => {}), message: vi.fn<SessionRecorder["message"]>(async () => {}) };
    const session = withSessionRecorder(source([{ type: "text", text: "answer" }, { type: "result", result: "answer" }, { type: "done" }, { type: "error", error: "disconnected" }, { type: "done" }]), recorder);
    for await (const _event of session.events()) { /* drain */ }
    expect(recorder.message.mock.calls.map(call => call[0]).filter(message => message.type === "text")).toHaveLength(1);
    expect(recorder.message.mock.calls.at(-1)?.[0]).toMatchObject({ type: "result", result: undefined });
  });
  it("appends one message at a time, in the order they were made", async () => {
    stored.length = 0;
    const session = trackSession(source([]), "claude-code");
    await Promise.all([session.deliver("slow"), session.deliver("fast")]);
    expect(stored).toEqual(["slow", "fast"]);
  });
  it("surfaces tracking failures instead of producing an untracked success", async () => {
    const session = withSessionRecorder(source([{ type: "init", harnessSessionId: "vendor" }]), { link: async () => { throw new Error("store unavailable"); }, message: async () => {} });
    await expect(async () => { for await (const _event of session.events()) { /* drain */ } }).rejects.toThrow("store unavailable");
  });
});
