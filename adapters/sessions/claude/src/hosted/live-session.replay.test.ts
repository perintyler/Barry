import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ClaudeLiveSession, type LiveQuery } from "./live-session.js";
import { processSDKMessage } from "../anthropic-compatible/event-mapping.js";
import { CLAUDE_LIVE } from "../modes.js";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
const lines = readFileSync(new URL("./__fixtures__/sdk-2.1.282.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line) as { phase: string; dir: string; m: Parameters<typeof processSDKMessage>[0] });
it.each(["memory-first", "memory-second", "allowed", "refused", "native", "steer", "interrupt", "after-interrupt", "adopt", "per-turn", "window"])("replays %s through the live session", async phase => {
  const messages = lines.filter(line => line.phase === phase && line.dir === "out").map(line => line.m);
  expect(messages.filter(m => m.type === "result")).toHaveLength(1);
  expect(messages.length).toBeGreaterThan(0);
  const session = new ClaudeLiveSession({ id: phase, guarantees: CLAUDE_LIVE.guarantees, open: async prompt => ({
    async *[Symbol.asyncIterator]() { for await (const _message of prompt) { yield* messages; } },
    async interrupt() {}, close() {},
  } satisfies LiveQuery), toEvents: m => processSDKMessage(m as Parameters<typeof processSDKMessage>[0]), structuredTurn: async function* () {} });
  await session.deliver("replay");
  const events: SessionEvent[] = [];
  for await (const event of session.events()) { events.push(event); if (event.type === "done") break; }
  expect(events.filter(e => e.type === "done")).toHaveLength(1);
  const resultIndex = events.findIndex(e => e.type === "result");
  expect(resultIndex).toBeGreaterThanOrEqual(0);
  expect(events.at(-1)).toMatchObject({ type: "done", usage: expect.any(Object) });
  if (phase === "memory-first") expect(session.harnessVersion).toBe("2.1.282");
  if (phase === "allowed" || phase === "refused") {
    const start = events.find(e => e.type === "tool_use");
    expect(start).toBeDefined();
    expect(events.find(e => e.type === "tool_result")).toMatchObject({ id: start?.type === "tool_use" ? start.id : "missing" });
    if (phase === "refused") expect(events.find(e => e.type === "tool_result")).toMatchObject({ error: true, result: expect.stringContaining("review refused") });
  }
  await session.close();
});
