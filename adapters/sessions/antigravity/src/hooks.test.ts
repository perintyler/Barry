import { mkdirSync, symlinkSync } from "node:fs";
import { stableNodePath } from "@barry-rocks/sdk/services";
import { vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInstrumentedHooks, setupGating } from "./hooks.js";
import { NATIVE_TOOLS } from "./native-tools.js";

describe("Antigravity hooks", () => {
  it("persists messages delivered after setup, preserves sender and consumes each once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-agy-'"));
    try {
      const hooks = createInstrumentedHooks();
      await hooks.inbox.deliver({ content: "before" });
      hooks.setup(dir, NATIVE_TOOLS as string[], ["probe"]);
      await hooks.inbox.deliver({ content: "after", from: "peer" });
      const config = JSON.parse(readFileSync(join(dir, ".agents/hooks.json"), "utf8"));
      const run = () => JSON.parse(execSync(config["barry-inbox"].PreInvocation[0].command, { encoding: "utf8" }));
      expect(run()).toEqual({ injectSteps: [{ userMessage: "before" }, { userMessage: "[peer]: after" }] });
      expect(run()).toEqual({});
      await hooks.inbox.deliver({ content: "next" });
      expect(run()).toEqual({ injectSteps: [{ userMessage: "next" }] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("denies natives and unknown tools while preserving the scoped MCP wrapper", () => {
    const dir = mkdtempSync(join(tmpdir(), "barry-agy-gate-"));
    try {
      createInstrumentedHooks().setup(dir, [...NATIVE_TOOLS, "mcp__probe__write"], ["probe"]);
      const config = JSON.parse(readFileSync(join(dir, ".agents/hooks.json"), "utf8"));
      const command = config["barry-gating"].PreToolUse[0].hooks[0].command;
      const run = (input: unknown) => JSON.parse(execSync(command, { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" }));
      for (const name of [...NATIVE_TOOLS.filter(name => name !== "call_mcp_tool"), "future_native"]) expect(run({ toolCall: { name, args: {} } }).decision).toBe("deny");
      expect(run("malformed").decision).toBe("deny");
      const call = (server: string, tool: string) => ({ toolCall: { name: "call_mcp_tool", args: { ServerName: server, ToolName: tool, Arguments: {} } } });
      expect(run(call("probe", "echo")).decision).toBe("allow");
      expect(run(call("ambient", "echo")).decision).toBe("deny");
      expect(run(call("probe", "write")).decision).toBe("deny");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20000);
});
it("empties the previous launch’s inbox before accepting new messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "barry-agy-inbox-"));
  try {
    const previous = createInstrumentedHooks();
    previous.setup(dir);
    await previous.inbox.deliver({ content: "stale" });
    const next = createInstrumentedHooks();
    next.setup(dir);
    expect(next.drainUnclaimed()).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("allows finish only when a structured response was requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "barry-agy-format-"));
  try {
    for (const structured of [false, true]) {
      setupGating(dir, [], [], structured);
      const hooks = JSON.parse(readFileSync(join(dir, ".agents/hooks.json"), "utf8"));
      const run = (name: string) => JSON.parse(execSync(hooks["barry-gating"].PreToolUse[0].hooks[0].command, { input: JSON.stringify({ toolCall: { name, args: {} } }), encoding: "utf8" }));
      expect(run("finish").decision).toBe(structured ? "allow" : "deny");
      expect(run("run_command").decision).toBe("deny");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([false, true])("names a working installed Node in its hook command (release=%s)", release => {
  const home = mkdtempSync(join(tmpdir(), "c3-node-"));
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_NODE", undefined);
  try {
    if (release) {
      const target = join(home, "target");
      mkdirSync(join(target, "runtime/bin"), { recursive: true });
      symlinkSync(process.execPath, join(target, "runtime/bin/node"));
      mkdirSync(join(home, "app-support"), { recursive: true });
      symlinkSync(target, join(home, "app-support/current"));
    }

    setupGating(home, [], ['probe']);
    const command = JSON.parse(readFileSync(join(home, '.agents/hooks.json'), 'utf8'))['barry-gating'].PreToolUse[0].hooks[0].command;
    expect(command.startsWith("'" + stableNodePath() + "' ")).toBe(true);
    if (release) expect(command.startsWith("'" + join(home, "app-support/current/runtime/bin/node") + "' ")).toBe(true);
    expect(JSON.parse(execSync(command, { input: JSON.stringify({toolCall:{name:'call_mcp_tool',args:{ServerName:'probe',ToolName:'echo'}}}), encoding:'utf8' })).decision).toBe('allow');
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

it("grants native reads while preserving Barry send_message despite the native name", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-native-gate-"));
  try {
    setupGating(dir, ["grep_search", "send_message"], ["barry"], false, ["view_file", "grep_search"]);
    const hooks = JSON.parse(readFileSync(join(dir, ".agents/hooks.json"), "utf8"));
    const command = hooks["barry-gating"].PreToolUse[0].hooks[0].command;
    const run = (name: string, args = {}) => JSON.parse(execSync(command, { input: JSON.stringify({ toolCall: { name, args } }), encoding: "utf8" })).decision;
    expect(run("view_file")).toBe("allow");
    for (const name of ["grep_search", "run_command", "send_message"]) expect(run(name)).toBe("deny");
    expect(run("call_mcp_tool", { ServerName: "barry", ToolName: "send_message", Arguments: {} })).toBe("allow");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
