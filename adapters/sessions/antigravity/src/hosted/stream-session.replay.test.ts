import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { AntigravityStreamSession } from "./stream-session.js";
import { ANTIGRAVITY_HOSTED } from "../modes.js";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
const { spawn } = await import("node:child_process");
const lines = readFileSync(new URL("./__fixtures__/stream-json-1.3.1.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line) as { phase: string; dir: string; m: Record<string, unknown> });
it.each(["first", "allowed", "refused", "resume", "structured", "interrupt"])("replays %s through the hosted session", async phase => {
  const recorded = lines.filter(l => l.phase === phase);
  const inputIndex = recorded.findIndex(l => l.dir === "in");
  expect(inputIndex).toBeGreaterThanOrEqual(0);
  const messages = recorded.slice(inputIndex + 1).filter(l => l.dir === "out");
  const process = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  process.kill = vi.fn(signal => { process.emit("exit", 0, signal); return true; });
  process.stdin.once("data", () => { for (const line of messages) process.stdout.write(JSON.stringify(line.m) + "\n"); });
  vi.mocked(spawn).mockReturnValue(process);
  const session = new AntigravityStreamSession({ sessionId: `replay-${phase}`, cwd: "/tmp", env: { GEMINI_API_KEY: "replay" }, mcpServers: {} }, { guarantees: ANTIGRAVITY_HOSTED.guarantees });
  await session.deliver("replay", phase === "structured" ? { outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } } : undefined);
  if (phase === "interrupt") await session.interrupt();
  const events: SessionEvent[] = [];
  for await (const event of session.events()) { events.push(event); if (event.type === "done") break; }
  expect(events.filter(e => e.type === "done")).toHaveLength(1);
  if (phase === "first") {
    expect(session.harnessSessionId).toBe((messages.find(l => l.m.event === "init")?.m.conversation_id));
    expect(session.harnessSessionId).toBeTruthy();
  }
  if (phase === "allowed" || phase === "refused") {
    const start = events.find(e => e.type === "tool_use");
    expect(start).toBeDefined();
    const result = events.find(e => e.type === "tool_result");
    expect(result).toMatchObject({ id: start?.type === "tool_use" ? start.id : "missing" });
    if (phase === "refused") expect(result).toMatchObject({ error: true, result: expect.stringContaining("Barry tools only") });
    else expect(result).toMatchObject({ error: false, result: expect.stringContaining("probe-tool-ran") });
  }
  if (phase === "structured") expect(events.find(e => e.type === "result")).toMatchObject({ structured: { ok: true } });
  await session.close();
});
