import { describe, expect, it, vi } from "vitest";
import { configureHarnessSession } from "./configure.js";
import { defineAdapter } from "../adapters/harnesses/index.js";
import { testAdapter, testSessionMode } from "../adapters/harnesses/testing.js";
import type { SessionConfig } from "./index.js";

const input = (): SessionConfig => ({ sessionId: "barry-1", cwd: "/tmp", env: { BARRY_SESSION_ID: "wrong" }, mcpServers: { probe: { type: "http", url: "http://localhost/mcp?sessionId=wrong&sessionId=decoy" }, stdio: { command: "probe", env: { BARRY_SESSION_ID: "wrong" } } } });
describe("mandatory adapter policy", () => {
  it("normalizes the hosted boundary including direct SDK callers", async () => {
    const start = vi.fn(async (_config: SessionConfig) => { throw new Error("boundary reached"); });
    const fixture = testAdapter();
    const adapter = testAdapter({ id: "test", capabilities: { ...fixture.capabilities, toolDenial: "native" }, nativeTools: ["Shell", "Read"] });
    const wrapped = defineAdapter({ ...adapter, modes: { hosted: testSessionMode(start), guest: null, instrumented: null } });
    await expect(wrapped.modes.hosted!.start(input(), vi.fn())).rejects.toThrow("boundary reached");
    const config = start.mock.calls[0][0];
    expect(config.deniedTools).toEqual(expect.arrayContaining([...adapter.nativeTools]));
    expect(config.env.BARRY_SESSION_ID).toBe("barry-1");
    expect(new URL((config.mcpServers.probe as { url: string }).url).searchParams.getAll("sessionId")).toEqual(["barry-1"]);
    expect((config.mcpServers.stdio as { env: Record<string, string> }).env.BARRY_SESSION_ID).toBe("barry-1");
    for (const tool of adapter.nativeTools) expect(await config.decide!({ id: "n", tool, input: {} })).toMatchObject({ allow: false });
    for (const tool of ["unknown_native", "mcp__ambient__echo"]) expect(await config.decide!({ id: "u", tool, input: {} })).toMatchObject({ allow: false });
    expect(await config.decide!({ id: "m", tool: "mcp__probe__echo", input: {} })).toEqual({ allow: true });
  });
  it("refuses an adapter that cannot enforce its native ceiling", () => {
    const start = vi.fn();
    const wrapped = defineAdapter(testAdapter({ id: "unsafe", nativeTools: ["Shell"], modes: { hosted: testSessionMode(start), guest: null, instrumented: null } }));
    expect(() => wrapped.modes.hosted!.start(input(), vi.fn())).toThrow(/cannot enforce/);
    expect(start).not.toHaveBeenCalled();
  });
  it("refuses passthrough and ambient MCP overrides before adapter execution", () => {
    expect(() => configureHarnessSession({ ...input(), extraArgs: ["--tools", "Bash"] }, [])).toThrow(/Raw adapter/);
    expect(() => configureHarnessSession({ ...input(), strictMcpConfig: false }, [])).toThrow(/unscoped/);
    expect(() => configureHarnessSession({ ...input(), resume: { last: true } }, [])).toThrow(/exact/);
    expect(() => configureHarnessSession({ ...input(), mcpServers: { "*": { command: "probe" } } }, [])).toThrow(/wildcards/);
  });
  it("retains caller denials and does not mutate the supplied config", async () => {
    const supplied = input();
    supplied.deniedTools = ["mcp__probe__write"];
    const decide = vi.fn(async () => ({ allow: true as const }));
    supplied.decide = decide;
    const config = configureHarnessSession(supplied, ["Bash"]);
    expect(await config.decide!({ id: "1", tool: "mcp__probe__write", input: {} })).toMatchObject({ allow: false });
    expect(decide).not.toHaveBeenCalled();
    expect(supplied.env.BARRY_SESSION_ID).toBe("wrong");
    expect(supplied.deniedTools).toEqual(["mcp__probe__write"]);
  });
});

it("keeps only grantable tools and forwards allowed natives to the caller", async () => {
  const decide = vi.fn(async () => ({ allow: false as const, reason: "caller refused" }));
  const config = configureHarnessSession({ ...input(), allowedNativeTools: ["Read", "Shell", "Other"], deniedTools: ["sHeLl"], decide }, ["Read", "Shell", "Other"], { grantable: ["Read", "Shell"] });
  expect(config.allowedNativeTools).toEqual(["Read"]);
  expect(config.deniedTools).toEqual(["Shell", "Other", "sHeLl"]);
  expect(await config.decide!({ id: "r", tool: "Read", input: {} })).toEqual({ allow: false, reason: "caller refused" });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(await config.decide!({ id: "o", tool: "Other", input: {} })).toMatchObject({ allow: false });
  expect(configureHarnessSession({ ...input(), allowedNativeTools: ["Read"] }, ["Read"]).allowedNativeTools).toEqual([]);
});
it("refuses partial inseparable allowances, including a caller denial", () => {
  const native = { grantable: ["Write", "Edit"], inseparable: [["Write", "Edit"]] };
  expect(configureHarnessSession({ ...input(), allowedNativeTools: ["Write"] }, native.grantable, native).allowedNativeTools).toEqual([]);
  expect(configureHarnessSession({ ...input(), allowedNativeTools: ["Write", "Edit"], deniedTools: ["Edit"] }, native.grantable, native).allowedNativeTools).toEqual([]);
  expect(configureHarnessSession({ ...input(), allowedNativeTools: ["Write", "Edit"] }, native.grantable, native).allowedNativeTools).toEqual(["Write", "Edit"]);
});
