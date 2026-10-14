import { afterEach, expect, it, vi } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { toolGate } from "./tool-gate.js";

const config: SessionConfig = { sessionId: "test", cwd: "/tmp", env: {}, mcpServers: { probe: { type: "http", url: "http://localhost/mcp" } } };
const input = (tool_name: string): HookInput => ({ hook_event_name: "PreToolUse", session_id: "test", transcript_path: "", cwd: "/tmp", tool_name, tool_input: {}, tool_use_id: "call" });
const call = (gate: ReturnType<typeof toolGate>, name: string) => gate.hooks[0](input(name), "call", { signal: new AbortController().signal });
afterEach(() => vi.useRealTimers());

it.each([
  ["Bash", undefined, "deny"],
  ["StructuredOutput", undefined, "deny"],
  ["StructuredOutput", {}, "allow"],
] as const)("rules %s with output format %s as %s without asking", async (name, format, expected) => {
  const decide = vi.fn();
  expect(await call(toolGate({ ...config, decide }, format), name)).toMatchObject({ hookSpecificOutput: { permissionDecision: expected } });
  expect(decide).not.toHaveBeenCalled();
});
it.each([
  [async () => ({ allow: true as const }), "allow", "Barry tools only"],
  [async () => ({ allow: false as const, reason: "review refused" }), "deny", "review refused"],
  [async () => { throw Error("unavailable"); }, "deny", "Barry tools only"],
])("asks Barry for a scoped MCP call", async (decide, expected, reason) => {
  const rule = vi.fn(decide);
  expect(await call(toolGate({ ...config, decide: rule }), "mcp__probe__echo")).toMatchObject({ hookSpecificOutput: { permissionDecision: expected, permissionDecisionReason: reason } });
  expect(rule).toHaveBeenCalledWith({ id: "call", tool: "mcp__probe__echo", input: {} });
});
it("denies a scoped tool on the denylist without asking", async () => {
  const decide = vi.fn();
  expect(await call(toolGate({ ...config, decide, deniedTools: ["mcp__probe__echo"] }), "mcp__probe__echo")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(decide).not.toHaveBeenCalled();
});
it("denies before the CLI timeout when nobody rules", async () => {
  vi.useFakeTimers();
  const gate = toolGate({ ...config, decide: () => new Promise(() => {}) }, undefined, 3);
  expect(gate.timeout).toBe(3);
  const result = call(gate, "mcp__probe__echo");
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no ruling within 3s" } });
  expect(vi.getTimerCount()).toBe(0);
});
it("lets allowed natives reach the same caller ruling as MCP", async () => {
  const decide = vi.fn(async () => ({ allow: true as const }));
  const gate = toolGate({ ...config, allowedNativeTools: ["Read", "Grep"], deniedTools: ["Grep"], decide });
  expect(await call(gate, "Read")).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  expect(await call(gate, "Grep")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await call(gate, "Bash")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(decide).toHaveBeenCalledTimes(1);
});
