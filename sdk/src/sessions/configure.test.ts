import { expect, it, describe } from "vitest";
import { configureSession, assertSessionOwner, allowedNative, disallowedTools } from "./configure.js";
import type { SessionConfig } from "./index.js";
it("owns effective configuration collections without changing policy or adapter options", () => {
  const input: SessionConfig = { sessionId: "fixture", cwd: "/fixture", env: { KEY: "explicit" }, mcpServers: { local: { command: "node", args: ["fixture"], env: { TOKEN: "declared" } }, remote: { type: "http", url: "http://fixture", headers: { Authorization: "explicit" } } }, deniedTools: ["write", "write"], egressSandbox: { allowDomains: [], allowUnixSockets: ["/fixture.sock"] }, options: { native: true }, decide: async () => ({ allow: false, reason: "restricted" }) };
  const cli = configureSession(input), api = configureSession(input);
  expect(cli).toEqual(api);
  expect(cli.deniedTools).toEqual(["write"]);
  cli.env.KEY = "changed";
  if ("command" in cli.mcpServers.local) { cli.mcpServers.local.args!.push("changed"); cli.mcpServers.local.env!.TOKEN = "changed"; }
  cli.egressSandbox!.allowDomains.push("leak.test");
  expect(api.env.KEY).toBe("explicit");
  expect(api.mcpServers.local).toEqual(input.mcpServers.local);
  expect(api.egressSandbox!.allowDomains).toEqual([]);
  expect(api.decide).toBe(input.decide);
  expect(() => assertSessionOwner({ identity_id: 2 }, 1)).toThrow("another identity");
  expect(() => assertSessionOwner(undefined, 1)).toThrow("not found");
});

describe("shared native-tool helpers (step 22, ADP-6)", () => {
  const TOOLS = ["Bash", "Read", "Write", "Edit", "WebSearch"] as const;
  it("allowedNative filters to requested, catalogued, non-denied tools (case-insensitive denial)", () => {
    const allowed = allowedNative({ allowedNativeTools: ["Bash", "Read", "WebSearch"], deniedTools: ["bash"] }, TOOLS);
    expect(allowed).toEqual(["Read", "WebSearch"]);
  });
  it("allowedNative honours a grantable restriction when native control supplies one", () => {
    const native = { grantable: ["Read"] };
    const allowed = allowedNative({ allowedNativeTools: ["Bash", "Read"], deniedTools: [] }, TOOLS, native);
    expect(allowed).toEqual(["Read"]);
  });
  it("allowedNative drops an inseparable group whole when any member is unavailable", () => {
    const native = { grantable: ["Edit", "Write"], inseparable: [["Edit", "Write"]] };
    const allowed = allowedNative({ allowedNativeTools: ["Edit"], deniedTools: [] }, TOOLS, native);
    expect(allowed).not.toContain("Edit");
    expect(allowed).not.toContain("Write");
  });
  it("disallowedTools is the complement plus explicit denials", () => {
    const denied = disallowedTools({ allowedNativeTools: ["Read"], deniedTools: ["ExtraThing"] }, TOOLS);
    expect(denied).toContain("Bash");
    expect(denied).toContain("Write");
    expect(denied).toContain("ExtraThing");
    expect(denied).not.toContain("Read");
  });
});
