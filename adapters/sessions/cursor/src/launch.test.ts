import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "./adapter.js";
import { planInstrumented, relayWithBarryHome } from "./instrumented.js";
import { chatExists, planCursorLaunch } from "./launch.js";
import { CURSOR_GUEST, CURSOR_INSTRUMENTED } from "./modes.js";
import { cursorHome } from "./runtime.js";

const CHAT = "0f1e2d3c-4b5a-4968-8776-655443322110";
const NEW_CHAT = "11111111-2222-4333-8444-555555555555";

let scratch: string;
const plans: string[] = [];
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cursor-launch-"));
  vi.stubEnv("BARRY_HOME", join(scratch, "barry"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of plans.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: `launch-${Math.random().toString(36).slice(2)}`,
    cwd: join(scratch, "repo"),
    env: { PATH: "/usr/bin", HOME: "/Users/real", CURSOR_API_KEY: "sk-identity" },
    mcpServers: { barry: { type: "http", url: "http://127.0.0.1:9/mcp?sessionId=s" } },
    ...overrides,
  };
}

const reserveChat = vi.fn(async () => NEW_CHAT);
// Async, so the adapter's synchronous refusals arrive as rejections.
const planGuest = async (given: SessionConfig) => adapter.modes.guest!.plan(given);

async function guest(given: SessionConfig) {
  const plan = await planCursorLaunch(given, CURSOR_GUEST.guarantees, { reserveChat });
  plans.push(...plan.tmpDirs);
  return plan;
}

describe("the cursor guest launch", () => {
  it("preserves a native grant when the caller has no explicit denials", async () => {
    const plan = await guest(config({ allowedNativeTools: ["Read"] }));
    const script = join(plan.cwd!, ".cursor", "barry-tool-gate.cjs");
    for (const [tool, permitted] of [["Read", true], ["Shell", false]] as const) {
      const result = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ hook_event_name: "preToolUse", tool_name: tool }), encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).permission === "deny").toBe(!permitted);
    }
  });

  it("is refused without the identity's key, and hands a one-shot to the hosted path", async () => {
    await expect(planGuest(config({ env: { PATH: "/usr/bin" } }))).rejects.toThrow(/CURSOR_API_KEY/);
    await expect(planCursorLaunch(config({ options: { prompt: "do it" } }), CURSOR_GUEST.guarantees)).rejects.toBeInstanceOf(NotSupportedInMode);
  });

  it("runs the TUI in the session's home, on the key held in memory, in a workspace carrying Barry's gate", async () => {
    const given = config({ systemPrompt: "Be brief." });
    const plan = await guest(given);
    expect(plan.env).toMatchObject({ HOME: cursorHome(given.sessionId), CURSOR_API_KEY: "sk-identity", AGENT_CLI_CREDENTIAL_STORE: "memory" });
    expect(plan.args).toEqual(expect.arrayContaining(["--disable-auto-update", "--force", "--approve-mcps", "--trust", "--add-dir", given.cwd, "--resume", NEW_CHAT]));
    expect(plan.harnessSessionId).toBe(NEW_CHAT);
    expect(plan.cwd).toBe(plan.args[plan.args.indexOf("--workspace") + 1]);
    expect(plan.tmpDirs).toEqual([plan.cwd]);
    const hooks = JSON.parse(readFileSync(join(plan.cwd!, ".cursor", "hooks.json"), "utf8")).hooks;
    expect(hooks.preToolUse[0].command).toBe(hooks.beforeMCPExecution[0].command);
    expect(readFileSync(join(plan.cwd!, "AGENTS.md"), "utf8")).toContain("Be brief.");
    expect(Object.keys(JSON.parse(readFileSync(join(plan.cwd!, ".cursor", "mcp.json"), "utf8")).mcpServers)).toEqual(["barry"]);
  });

  it("resumes a chat in the session's home exactly, and starts a new one, said so, for one it cannot open", async () => {
    const given = config();
    mkdirSync(join(cursorHome(given.sessionId), ".cursor", "chats", "abc123", CHAT), { recursive: true });
    const resumed = await guest({ ...given, resume: { harnessSessionId: CHAT } });
    expect(resumed.args.slice(resumed.args.indexOf("--resume"), resumed.args.indexOf("--resume") + 2)).toEqual(["--resume", CHAT]);
    expect(resumed.warnings.filter((warning) => warning.includes("new chat"))).toEqual([]);

    const hosted = await guest({ ...config(), resume: { harnessSessionId: CHAT } });
    expect(hosted.harnessSessionId).toBe(NEW_CHAT);
    expect(hosted.warnings.join(" ")).toMatch(/ran hosted.*new chat/);

    await expect(planGuest(config({ resume: { last: true } }))).rejects.toThrow(/exact recorded conversation/);
    await expect(planGuest(config({ extraArgs: ["--yolo"] }))).rejects.toThrow(/Raw adapter arguments/);
  });

  it("says so when cursor gives no chat id", async () => {
    const plan = await planCursorLaunch(config(), CURSOR_GUEST.guarantees, { reserveChat: async () => undefined });
    plans.push(...plan.tmpDirs);
    expect(plan.harnessSessionId).toBeUndefined();
    expect(plan.args).not.toContain("--resume");
    expect(plan.warnings.join(" ")).toMatch(/no chat id/);
  });

  it("surfaces denials cursor cannot enforce in the launch warnings (ADP-18)", async () => {
    // Glob is one of cursor's uncontrolled tools: it has no permission kind, so
    // denying it is not enforceable in-session and the launch must say so.
    const plan = await guest(config({ deniedTools: ["Glob"] }));
    expect(plan.warnings.join(" ")).toMatch(/cannot enforce these denials/);
    expect(plan.warnings.join(" ")).toContain("Glob");
  });

  it("knows a chat by its directory in the home", () => {
    const home = join(scratch, "home");
    expect(chatExists(home, CHAT)).toBe(false);
    mkdirSync(join(home, ".cursor", "chats", "w1", CHAT), { recursive: true });
    expect(chatExists(home, CHAT)).toBe(true);
  });
});

describe("the cursor instrumented launch", () => {
  it("refuses a missing tracking relay before preparing a launch", async () => {
    await expect(planInstrumented(config(), CURSOR_INSTRUMENTED.guarantees, { reserveChat })).rejects.toThrow(/tracking relay/);
  });

  it("adds a held stop hook running Barry's relay in the user's own home, uncapped and timed past its hold", async () => {
    const plan = await planInstrumented(config({ options: { relayCommand: "'/node' '/barry' hook cursor" } }), CURSOR_INSTRUMENTED.guarantees, { reserveChat });
    plans.push(...plan.tmpDirs);
    const hooks = JSON.parse(readFileSync(join(plan.cwd!, ".cursor", "hooks.json"), "utf8")).hooks;
    expect(hooks.stop).toEqual([{ command: relayWithBarryHome("'/node' '/barry' hook cursor"), timeout: 120, loop_limit: null }]);
    expect(hooks.preToolUse).toHaveLength(1);
    expect(plan.guarantees.delivery).toBe("turn-end");
  });

  it("gives the relay the user's home back, quoted", () => {
    expect(relayWithBarryHome("barry hook cursor", "/Users/o'neil")).toBe("HOME='/Users/o'\\''neil' barry hook cursor");
  });
});
