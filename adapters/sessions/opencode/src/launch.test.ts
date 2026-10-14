/**
 * The guest launch, as planned. What the plan does to the real binary — the
 * session id that reaches Barry's MCP server, the tools the model is offered,
 * the key it authenticates with — is `src/live/opencode-live.test.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "./adapter.js";
import { planOpenCodeLaunch } from "./launch.js";
import { OPENCODE_GUEST } from "./modes.js";
import { NATIVE_TOOLS } from "./native-tools.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-guest-"));
  made.push(dir);
  return dir;
}

const BASE: SessionConfig = {
  sessionId: "barry-1",
  cwd: "/repo",
  env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "or-key" },
  model: "openrouter/openai/gpt-4o-mini",
  mcpServers: { barry: { type: "http", url: "http://127.0.0.1:3901/mcp?sessionId=barry-1" } },
  deniedTools: ["shell", "mcp__barry__wipe"],
};

async function plan(overrides: Partial<SessionConfig> = {}, root = scratch()) {
  const launched = await planOpenCodeLaunch({ ...BASE, ...overrides }, OPENCODE_GUEST.guarantees, root);
  made.push(...launched.tmpDirs);
  const configPath = launched.env.OPENCODE_CONFIG;
  if (!configPath) throw new Error("guest launch has no private config path");
  return { launched, root, config: JSON.parse(readFileSync(configPath, "utf8")) };
}

describe("the guest launch", () => {
  it("runs opencode's own TUI on a private server, not the shared background service", async () => {
    const { launched } = await plan();

    expect(launched.command).toBe("opencode");
    expect(launched.args[0]).toBe("--standalone");
    expect(launched.cwd).toBe("/repo");
  });

  it("chooses the conversation's id itself, so it is recorded before the TUI starts", async () => {
    const { launched } = await plan();
    const again = await plan();

    expect(launched.harnessSessionId).toMatch(/^ses_[0-9a-f]{26}$/);
    expect(launched.args).toEqual(["--standalone", "--session", launched.harnessSessionId]);
    expect(again.launched.harnessSessionId).toBe(launched.harnessSessionId);
  });

  it("names its model in config, since the TUI takes no --model", async () => {
    const { launched, config } = await plan();

    expect(config.model).toBe("openrouter/openai/gpt-4o-mini");
    expect(launched.args).not.toContain("--model");
  });

  it("lets Barry's tools run and denies every native one, by rules fixed at launch", async () => {
    const { config } = await plan();

    expect(config.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "barry_*", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "barry_wipe", resource: "*", effect: "deny" },
    ]);
    expect(config.mcp.servers.barry).toEqual({ type: "remote", url: "http://127.0.0.1:3901/mcp?sessionId=barry-1", codemode: false });
  });

  it("authenticates with the identity's key, from the session's own data dir, on its providers only", async () => {
    const { launched, root, config } = await plan();

    expect(launched.env.OPENROUTER_API_KEY).toBe("or-key");
    expect(launched.env.PATH).toBe("/usr/bin");
    expect(launched.env.XDG_DATA_HOME?.startsWith(root)).toBe(true);
    expect(config.enabled_providers).toEqual(["openrouter"]);
  });

  it("removes only its runtime dir afterwards: the session's home holds the conversation", async () => {
    const { launched } = await plan();

    expect(launched.tmpDirs).toEqual([launched.env.XDG_RUNTIME_DIR]);
  });

  it("refuses a one-shot, which the launcher then runs hosted", async () => {
    await expect(plan({ options: { prompt: "do it" } })).rejects.toBeInstanceOf(NotSupportedInMode);
    await expect(plan({ options: { prompt: "do it" } })).rejects.toMatchObject({ operation: "prompt", mode: "guest" });
  });

  it("guarantees what it declared", async () => {
    const { launched } = await plan();

    expect(launched.guarantees).toEqual(OPENCODE_GUEST.guarantees);
    expect(launched.warnings).toEqual([]);
  });
});

describe("resuming a guest session", () => {
  it("continues the recorded conversation from the session's own data", async () => {
    const root = scratch();
    const first = await plan({}, root);
    // What the first TUI left behind.
    mkdirSync(join(first.launched.env.XDG_DATA_HOME!, "opencode"), { recursive: true });
    writeFileSync(join(first.launched.env.XDG_DATA_HOME!, "opencode", "opencode.db"), "");

    const resumed = await plan({ resume: { harnessSessionId: "ses_recorded" } }, root);

    expect(resumed.launched.args).toEqual(["--standalone", "--session", "ses_recorded"]);
    expect(resumed.launched.harnessSessionId).toBe("ses_recorded");
  });

  it("refuses when the conversation's data is gone, rather than start an empty one under its id", async () => {
    await expect(plan({ resume: { harnessSessionId: "ses_recorded" } })).rejects.toThrow(/cannot be resumed/);
  });
});

describe("the guest mode the adapter declares", () => {
  const saved = process.env.BARRY_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = saved;
  });

  it("denies every native tool the adapter knows of, whatever the session asked", async () => {
    process.env.BARRY_HOME = scratch();
    const guest = adapter.modes.guest;
    if (!guest) throw new Error("opencode declares no guest mode");

    const launched = await guest.plan({ ...BASE, deniedTools: [] });
    made.push(...launched.tmpDirs);
    const configPath = launched.env.OPENCODE_CONFIG;
    if (!configPath) throw new Error("guest launch has no private config path");
    const denied = JSON.parse(readFileSync(configPath, "utf8")).permissions
      .filter((rule: { effect: string }) => rule.effect === "deny")
      .map((rule: { action: string }) => rule.action);

    expect(denied).toEqual(expect.arrayContaining(["*", ...NATIVE_TOOLS.map(tool => ["write", "patch"].includes(tool) ? "edit" : tool)]));
  });
});
