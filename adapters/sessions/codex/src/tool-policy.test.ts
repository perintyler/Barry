import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { stableNodePath } from "@barry-rocks/sdk/services";
import { vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexEngineSpec } from "./app-server/start.js";
import { codexToolGateCommand, writeCodexToolGate } from "./tool-policy.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function gate(toolName: string): string {
  const home = mkdtempSync(join(tmpdir(), "codex-gate-"));
  homes.push(home);
  writeCodexToolGate(home, ["barry-tools"], ["mcp__barry_tools__denied"]);
  return execFileSync(process.execPath, [join(home, "barry-tool-gate.cjs")], { input: JSON.stringify({ tool_name: toolName }), encoding: "utf8" });
}

describe("Barry's codex tool gate", () => {
  it.each(["missing", "throw new Error('synthetic failure');", "process.stdout.write('invalid JSON');", "process.stdout.write('{}');"])("the launcher denies an unavailable or invalid gate: %s", failure => {
    const home = mkdtempSync(join(tmpdir(), "codex-gate-failure-"));
    homes.push(home);
    writeCodexToolGate(home, ["probe"], [], ["apply_patch"]);
    const script = join(home, "barry-tool-gate.cjs");
    if (failure === "missing") rmSync(script);
    else writeFileSync(script, failure);
    const output = execFileSync("/bin/sh", ["-c", codexToolGateCommand(home)], { input: JSON.stringify({ tool_name: "apply_patch" }), encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(output).hookSpecificOutput).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "Barry tool gate unavailable" });
    expect(output).not.toContain("synthetic failure");
  });

  it("lets a Barry tool through without a decision, which codex would read as a failed hook", () => {
    expect(gate("mcp__barry_tools__send_prompt")).toBe("");
  });

  it("denies a native tool, and a Barry tool the session denies", () => {
    for (const tool of ["apply_patch", "mcp__barry_tools__denied", "mcp__barry_tools__"]) {
      expect(JSON.parse(gate(tool)).hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    }
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
    writeCodexToolGate(home, ['probe']);
    const command = codexToolGateCommand(home);
    expect(command.startsWith("'" + stableNodePath() + "' ")).toBe(true);
    if (release) expect(command.startsWith("'" + join(home, "app-support/current/runtime/bin/node") + "' ")).toBe(true);
    expect(execFileSync('/bin/sh', ['-c', command], { input: JSON.stringify({tool_name:'mcp__probe__echo'}), encoding:'utf8' })).toBe('');
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

it("silently permits allowed hook names and denies the remainder", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-native-gate-"));
  homes.push(home);
  writeCodexToolGate(home, ["barry"], ["view_image"], ["exec_command", "write_stdin", "view_image"]);
  const run = (tool_name: string) => execFileSync(process.execPath, [join(home, "barry-tool-gate.cjs")], { input: JSON.stringify({ tool_name }), encoding: "utf8" });
  expect(run("Bash")).toBe("");
  expect(run("write_stdin")).toBe("");
  for (const name of ["apply_patch", "view_image"]) expect(JSON.parse(run(name)).hookSpecificOutput.permissionDecision).toBe("deny");
});

it("passes the same granted switches to the hosted engine's -c arguments", () => {
  const command = codexEngineSpec("native", "/scratch/codex", "/scratch/repo", {
    allowedNativeTools: ["exec_command", "write_stdin", "view_image", "web_search"], deniedTools: ["view_image"],
  }).command("/scratch/socket");
  expect(command.args).toEqual(expect.arrayContaining(['features.shell_tool=true', 'features.view_image=false', 'web_search="live"']));
  expect(command.args).toContain("features.standalone_web_search=false");
});
