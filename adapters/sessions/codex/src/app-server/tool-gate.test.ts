import { describe, expect, it, vi } from "vitest";
import { trustBarryToolGate } from "./tool-gate.js";
import { codexToolGateCommand } from "../tool-gate.js";

const home = "/tmp/owned-codex";
function client(overrides = {}) {
  const hook = { key: 'owned:pre_tool_use:0:0', sourcePath: home + "/hooks.json", eventName: "preToolUse", enabled: true, command: codexToolGateCommand(home), currentHash: "sha256:exact", trustStatus: "untrusted", ...overrides };
  return { call: vi.fn(async (method: string) => {
    if (method === "hooks/list") return { data: [{ hooks: [{ ...hook }], errors: [] }] };
    if (method === "config/batchWrite") { hook.trustStatus = "trusted"; return {}; }
    throw new Error("unexpected operation");
  }) };
}
describe("Codex startup tool gate", () => {
  it("trusts the loaded gate's exact hash only in its private config", async () => {
    const rpc = client(); await trustBarryToolGate(rpc, home, "/tmp/repo");
    expect(rpc.call).toHaveBeenCalledWith("config/batchWrite", expect.objectContaining({ filePath: home + "/config.toml", edits: [{ keyPath: 'hooks.state."owned:pre_tool_use:0:0"', mergeStrategy: "replace", value: { enabled: true, trusted_hash: "sha256:exact" } }] }));
  });
  it.each([{ command: "ambient hook" }, { enabled: false }, { sourcePath: "/other/hooks.json" }])("refuses a gate mismatch before trusting anything: %j", async overrides => {
    const rpc = client(overrides); await expect(trustBarryToolGate(rpc, home, "/tmp/repo")).rejects.toThrow(/exact tool gate/);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });
});

it("recognizes the canonical path of the same generated policy through a home alias", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "barry-hook-alias-"));
  try {
    writeFileSync(join(root, "hooks.json"), "{}");
    symlinkSync(root, root + "-alias");
    const alias = root + "-alias";
    const hook = { key: "owned", eventName: "preToolUse", command: codexToolGateCommand(alias), sourcePath: realpathSync(join(root, "hooks.json")), currentHash: "exact-hash", enabled: true, trustStatus: "untrusted" };
    const call = vi.fn(async (method: string) => {
      if (method === "hooks/list") return { data: [{ hooks: [hook] }] };
      hook.trustStatus = "trusted"; return {};
    });
    await trustBarryToolGate({ call }, alias, root);
    expect(call).toHaveBeenCalledWith("config/batchWrite", expect.objectContaining({ filePath: join(alias, "config.toml") }));
  } finally { rmSync(root + "-alias", { force: true }); rmSync(root, { recursive: true, force: true }); }
});
