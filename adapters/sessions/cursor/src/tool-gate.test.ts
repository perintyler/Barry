import { mkdirSync, symlinkSync } from "node:fs";
import { stableNodePath } from "@barry-rocks/sdk/services";
import { vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCursorToolGate } from "./tool-gate.js";
import { NATIVE_TOOLS } from "./native-tools.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function gate(servers: string[], denied: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "barry-gate-'"));
  directories.push(directory);
  const written = writeCursorToolGate(directory, servers, denied);
  const verdict = (input: string) => {
    const said = JSON.parse(execSync(written.command, { input, encoding: "utf8" })) as { permission?: string };
    return said.permission === "deny" ? "deny" : "allow";
  };
  return { written, verdict };
}

const preToolUse = (tool_name: string) => JSON.stringify({ hook_event_name: "preToolUse", tool_name });
const beforeMcp = (mcp_server_name: string, tool_name: string) => JSON.stringify({ hook_event_name: "beforeMCPExecution", mcp_server_name, tool_name });

describe("Barry's gate in cursor's TUI", () => {
  it.each([
    { hook_event_name: "preToolUse", tool_name: "Read" },
    { hook_event_name: "beforeMCPExecution", mcp_server_name: "probe", tool_name: "echo" },
  ])("returns an explicit schema allow for $hook_event_name", input => {
    const directory = mkdtempSync(join(tmpdir(), "cursor-explicit-allow-"));
    directories.push(directory);
    const hook = writeCursorToolGate(directory, ["probe"], [], ["Read"]);
    expect(JSON.parse(execSync(hook.command, { input: JSON.stringify(input), encoding: "utf8" }))).toEqual({ permission: "allow" });
  });

  it("refuses every native tool, a new one, and malformed or unknown input", () => {
    const { written, verdict } = gate(["probe"]);
    expect(written.failClosed).toBe(true);
    for (const tool of [...NATIVE_TOOLS, "NewNativeTool", "MCP:", "mcp__probe__echo"]) expect(verdict(preToolUse(tool)), tool).toBe("deny");
    expect(verdict("bad JSON")).toBe("deny");
    expect(verdict(JSON.stringify({ hook_event_name: "somethingNew", tool_name: "MCP:echo" }))).toBe("deny");
  }, 20000);

  it("lets an MCP call past preToolUse, which does not name its server, with an explicit allow", () => {
    const { written } = gate(["probe"]);
    expect(execSync(written.command, { input: preToolUse("MCP:echo"), encoding: "utf8" }).trim()).toBe(JSON.stringify({ permission: "allow" }));
  });

  it("runs only Barry's servers' tools, minus the session's denials, at beforeMCPExecution", () => {
    const { verdict } = gate(["probe", "barry-tools"], ["mcp__probe__write", "mcp__barry_tools__delete"]);
    expect(verdict(beforeMcp("probe", "echo"))).toBe("allow");
    expect(verdict(beforeMcp("barry-tools", "echo"))).toBe("allow");
    expect(verdict(beforeMcp("plugin-linear-linear", "echo"))).toBe("deny");
    expect(verdict(beforeMcp("probe", "write"))).toBe("deny");
    expect(verdict(beforeMcp("barry-tools", "delete"))).toBe("deny");
    expect(verdict(beforeMcp("probe", ""))).toBe("deny");
  });
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

    const command = writeCursorToolGate(home, ['probe']).command;
    expect(command.startsWith("'" + stableNodePath() + "' ")).toBe(true);
    if (release) expect(command.startsWith("'" + join(home, "app-support/current/runtime/bin/node") + "' ")).toBe(true);
    expect(JSON.parse(execSync(command, { input: JSON.stringify({hook_event_name:'preToolUse',tool_name:'MCP:echo'}), encoding:'utf8' }))).toEqual({ permission: "allow" });
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

it("permits allowed native hooks while honoring denials and the Write/Edit switch", () => {
  const directory = mkdtempSync(join(tmpdir(), "cursor-native-gate-"));
  directories.push(directory);
  const command = writeCursorToolGate(directory, [], ["Grep"], ["Read", "Grep", "Write"]).command;
  const run = (name: string) => JSON.parse(execSync(command, { input: preToolUse(name), encoding: "utf8" }));
  expect(run("Read")).toEqual({ permission: "allow" });
  for (const name of ["Grep", "Write", "Shell"]) expect(run(name).permission).toBe("deny");
});
