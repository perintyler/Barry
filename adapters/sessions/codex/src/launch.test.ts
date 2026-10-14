import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "./adapter.js";
import { onlyThreadIn, planCodexLaunch } from "./launch.js";
import { CODEX_GUEST } from "./modes.js";
import { codexTranscript } from "./transcript.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function made(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-launch-"));
  scratch.push(dir);
  return dir;
}

function config(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    sessionId: `launch-${Math.random().toString(36).slice(2)}`,
    cwd: made(),
    env: { PATH: "/usr/bin", HOME: made(), OPENAI_API_KEY: "sk-identity" },
    mcpServers: {},
    ...overrides,
  };
}

const planGuest = async (given: SessionConfig) => adapter.modes.guest!.plan(given);

describe("the codex guest launch", () => {
  it("is refused without the identity's key", async () => {
    await expect(planGuest(config({ env: { PATH: "/usr/bin" } }))).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("hands a one-shot to the hosted path", async () => {
    await expect(planCodexLaunch(config({ options: { prompt: "do it" } }), CODEX_GUEST.guarantees)).rejects.toBeInstanceOf(NotSupportedInMode);
  });

  it("returns an ephemeral guest home to the launcher's cleanup list", async () => {
    const plan = await planGuest(config({ ephemeral: true }));
    scratch.push(plan.env.CODEX_HOME!);
    expect(plan.tmpDirs).toEqual([plan.env.CODEX_HOME]);
    expect(readFileSync(join(plan.env.CODEX_HOME!, "config.toml"), "utf8")).toContain('env_key = "OPENAI_API_KEY"');
  });

  it("runs the TUI in the session's own home, on the identity's key, with Barry's gate trusted", async () => {
    const plan = await planGuest(config({ systemPrompt: "Be brief." }));
    expect(plan.command).toBe("codex");
    expect(plan.args).toEqual(expect.arrayContaining(["--ask-for-approval", "never", "--dangerously-bypass-hook-trust"]));
    expect(plan.env.OPENAI_API_KEY).toBe("sk-identity");
    expect(plan.env.CODEX_API_KEY).toBeUndefined();
    const home = plan.env.CODEX_HOME!;
    scratch.push(home);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('developer_instructions = "Be brief."');
    expect(readFileSync(join(home, "hooks.json"), "utf8")).toContain("PreToolUse");
  });

  it("resumes only the exact conversation, and refuses widening Barry's policy", async () => {
    const resumed = await planGuest(config({ resume: { harnessSessionId: "0f1e2d3c-4b5a-4968-8776-655443322110" } }));
    scratch.push(resumed.env.CODEX_HOME!);
    expect(resumed.args.slice(-2)).toEqual(["resume", "0f1e2d3c-4b5a-4968-8776-655443322110"]);
    expect(resumed.harnessSessionId).toBe("0f1e2d3c-4b5a-4968-8776-655443322110");
    expect(resumed.discoverHarnessSessionId).toBeUndefined();
    await expect(planGuest(config({ resume: { last: true } }))).rejects.toThrow(/exact recorded conversation/);
    await expect(planGuest(config({ extraArgs: ["--enable", "shell_tool"] }))).rejects.toThrow(/Raw adapter arguments/);
  });
});

describe("finding a guest's conversation", () => {
  const rollout = (home: string, thread: string) => {
    const dir = join(home, "sessions", "2026", "10", "07");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-07T20-39-33-${thread}.jsonl`), "{}\n");
  };
  const A = "01a118f3-807c-7062-ac1b-95047f230486";
  const B = "01a118fb-1d0f-74e0-82b3-df078d6b33b7";

  it("is the thread of the one rollout in the session's home", async () => {
    const home = made();
    expect(await onlyThreadIn(home)).toBeUndefined();
    rollout(home, A);
    expect(await onlyThreadIn(home)).toBe(A);
  });

  it("is no answer when there are several, rather than a guess", async () => {
    const home = made();
    rollout(home, A);
    rollout(home, B);
    expect(await onlyThreadIn(home)).toBeUndefined();
  });

  it("is discovered for a fresh launch, from that launch's home", async () => {
    const plan = await planGuest(config());
    scratch.push(plan.env.CODEX_HOME!);
    expect(plan.harnessSessionId).toBeUndefined();
    expect(await plan.discoverHarnessSessionId!()).toBeUndefined();
    rollout(plan.env.CODEX_HOME!, A);
    expect(await plan.discoverHarnessSessionId!()).toBe(A);
  });

  it("is found by the transcript reader in the session's own home, with nothing but the thread id", async () => {
    const plan = await planGuest(config());
    scratch.push(plan.env.CODEX_HOME!);
    rollout(plan.env.CODEX_HOME!, B);
    expect(await codexTranscript.locate({ harnessSessionId: B })).toContain(B);
  });
});
