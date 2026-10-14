import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERIFIED_ON } from "./modes.js";
import { cursorEnv, cursorHome, keepUserHome, prepareCursorHome, requireCursorKey, resolveCursorAgent } from "./runtime.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cursor-runtime-"));
  vi.stubEnv("BARRY_HOME", join(scratch, "barry"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a cursor session's home", () => {
  it("is one per session, under this instance's cache", () => {
    expect(cursorHome("a")).toContain(join(scratch, "barry", "cache", "cursor-homes"));
    expect(cursorHome("a")).not.toBe(cursorHome("b"));
    expect(cursorHome("a")).toBe(cursorHome("a"));
  });

  it("asks before every native call and never updates, keeping what cursor wrote itself", () => {
    const home = cursorHome("s1");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(ls)"] }, channel: "stable", privacyCache: { mode: 1 } }));
    prepareCursorHome("s1");
    const config = JSON.parse(readFileSync(join(home, ".cursor", "cli-config.json"), "utf8"));
    expect(config).toMatchObject({ channel: "static", approvalMode: "allowlist", permissions: { allow: [], deny: [] }, privacyCache: { mode: 1 } });
  });
});

describe("a cursor session's environment", () => {
  it("runs from the session's home on the identity's key, holding the token in memory", () => {
    const env = cursorEnv({ sessionId: "s1", cwd: "/repo", env: { HOME: "/Users/real", CURSOR_API_KEY: "key", PATH: "/bin", UNSET: undefined }, mcpServers: {} }, "/homes/s1");
    expect(env).toEqual({ HOME: "/homes/s1", CURSOR_API_KEY: "key", PATH: "/bin", AGENT_CLI_CREDENTIAL_STORE: "memory", BARRY_PROVIDER: "cursor", BARRY_SESSION_ID: "s1" });
  });

  it("is refused without the identity's key", () => {
    expect(() => requireCursorKey({})).toThrow(/CURSOR_API_KEY/);
    expect(requireCursorKey({ CURSOR_API_KEY: "key" })).toBe("key");
  });
});

describe("a session's MCP servers", () => {
  it("keep the user's home when cursor starts them, unless they name one", () => {
    expect(keepUserHome({
      local: { command: "node", args: ["server.js"], env: { TOKEN: "t" } },
      named: { command: "node", env: { HOME: "/elsewhere" } },
      barry: { type: "http", url: "http://127.0.0.1:9/mcp" },
    }, "/Users/real")).toEqual({
      local: { command: "node", args: ["server.js"], env: { HOME: "/Users/real", TOKEN: "t" } },
      named: { command: "node", env: { HOME: "/elsewhere" } },
      barry: { type: "http", url: "http://127.0.0.1:9/mcp" },
    });
  });
});

describe("the cursor-agent a session runs", () => {
  it("is the pinned build when it is installed, else the current one", () => {
    const home = join(scratch, "user");
    const versions = join(home, ".local", "share", "cursor-agent", "versions");
    expect(resolveCursorAgent(home)).toEqual({ command: "cursor-agent", pinned: false });

    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "cursor-agent"), "");
    expect(resolveCursorAgent(home)).toEqual({ command: join(home, ".local", "bin", "cursor-agent"), pinned: false });

    mkdirSync(join(versions, `${VERIFIED_ON}-other`), { recursive: true });
    writeFileSync(join(versions, `${VERIFIED_ON}-other`, "cursor-agent"), "");
    expect(resolveCursorAgent(home).pinned).toBe(false);

    mkdirSync(join(versions, `${VERIFIED_ON}-14929f9`), { recursive: true });
    writeFileSync(join(versions, `${VERIFIED_ON}-14929f9`, "cursor-agent"), "");
    mkdirSync(join(versions, "2099.01.01-ffffff0"), { recursive: true });
    expect(resolveCursorAgent(home)).toEqual({ command: join(versions, `${VERIFIED_ON}-14929f9`, "cursor-agent"), pinned: true });
  });
});
