import { describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "../../sessions/index.js";
import { defineAdapter } from "./index.js";
import { testAdapter, testSessionMode } from "./testing.js";

const entries = ["start", "adopt", "openContinuation"] as const;
type Entry = typeof entries[number];

function fixture() {
  const reached = new Error("configured vendor entry reached");
  const start = vi.fn(async (_config: SessionConfig) => { throw reached; });
  const adopt = vi.fn(async (_id: string, _config: SessionConfig) => { throw reached; });
  const openContinuation = vi.fn(async (_config: SessionConfig) => { throw reached; });
  const base = testAdapter();
  const defined = defineAdapter({
    ...base,
    nativeTools: ["Read", "Write"],
    capabilities: { ...base.capabilities, toolDenial: "native" },
    modes: {
      ...base.modes,
      hosted: { ...testSessionMode(start), build: "bundled", native: { grantable: ["Read"] }, adopt, openContinuation },
    },
  });
  const hosted = defined.modes.hosted!;
  const engine = vi.fn(async () => { throw new Error("engine must not start in this fixture"); });
  const invoke = (entry: Entry, config: SessionConfig) => {
    if (entry === "adopt") return hosted.adopt!("recorded-conversation", config);
    if (entry === "openContinuation") return hosted.openContinuation!(config, engine);
    return hosted.start(config, engine);
  };
  const config: SessionConfig = {
    sessionId: "configured-session", cwd: "/tmp", env: { BARRY_SESSION_ID: "spoofed" },
    mcpServers: { files: { command: "fixture-mcp", env: { BARRY_SESSION_ID: "spoofed" } } },
    allowedNativeTools: ["Read", "Write"],
  };
  return { reached, start, adopt, openContinuation, invoke, config, engine };
}

function supplied(entry: Entry, f: ReturnType<typeof fixture>): SessionConfig {
  if (entry === "adopt") return f.adopt.mock.calls[0][1];
  if (entry === "openContinuation") return f.openContinuation.mock.calls[0][0];
  return f.start.mock.calls[0][0];
}

describe("configured hosted entry points", () => {
  it.each(entries)("%s receives the mandatory session ceiling", async entry => {
    const f = fixture();
    await expect(f.invoke(entry, f.config)).rejects.toBe(f.reached);
    const configured = supplied(entry, f);
    expect(configured.env.BARRY_SESSION_ID).toBe(f.config.sessionId);
    expect(configured.strictMcpConfig).toBe(true);
    expect(configured.allowedNativeTools).toEqual(["Read"]);
    expect(configured.deniedTools).toEqual(["Write"]);
    expect(configured.mcpServers.files).toMatchObject({ env: { BARRY_SESSION_ID: f.config.sessionId } });
    await expect(configured.decide!({ id: "write-call", tool: "Write", input: {} })).resolves.toMatchObject({ allow: false });
    expect(f.config.env.BARRY_SESSION_ID).toBe("spoofed");
    expect(f.engine).not.toHaveBeenCalled();
  });

  it.each(entries)("%s refuses raw policy overrides before reaching the vendor", async entry => {
    const f = fixture();
    await expect(Promise.resolve().then(() => f.invoke(entry, { ...f.config, extraArgs: ["--dangerously-skip-permissions"] }))).rejects.toThrow(/Raw adapter arguments/);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.openContinuation).not.toHaveBeenCalled();
    expect(f.engine).not.toHaveBeenCalled();
  });
});
