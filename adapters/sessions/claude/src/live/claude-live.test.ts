/**
 * The TUI modes' guarantees, checked against the real `claude` binary.
 *
 * Opt-in, because it needs the pinned build on PATH and drives a real TUI:
 *
 *   BARRY_CLAUDE_LIVE=1 pnpm exec vitest run src/live
 *
 * The model, Barry's MCP server and the telemetry receiver are a local fake,
 * so the probe runs spend nothing. The last check uses the real API with a
 * key that cannot work: it shows the TUI never falls back to the user's own
 * `/login`, so it needs one on this machine and skips without it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import type { LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";
import { CLAUDE_REQUIREMENTS } from "../modes.js";
import { NATIVE_TOOLS } from "../native-tools.js";
import { startProbe, type Probe } from "./probe.js";
import { runOnTerminal, sleep, until, type Terminal } from "./terminal.js";

const LIVE = process.env.BARRY_CLAUDE_LIVE === "1";
const IDENTITY_KEY = ["sk-ant-api03", "barry-live-identity-key"].join("-");
const BOGUS_KEY = "sk-ant-api03-barry-live-bogus-key-" + "0".repeat(40);

describe.runIf(LIVE)("claude TUI modes, live", { timeout: 180_000 }, () => {
  let probe: Probe;
  const scratch: string[] = [];
  const transcripts: string[] = [];

  beforeAll(async () => {
    const version = execFileSync("claude", ["--version"], { encoding: "utf8" });
    expect(version, "the claude on PATH is not the build the guarantees were verified on").toContain(CLAUDE_REQUIREMENTS.binary.pin.version);
    probe = await startProbe(IDENTITY_KEY);
  });

  afterAll(async () => {
    await probe?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    for (const transcript of transcripts) rmSync(transcript, { force: true });
  });

  function made(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-live-")));
    scratch.push(dir);
    return dir;
  }

  function sessionConfig(sessionId: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
    const repo = join(made(), "repo");
    mkdirSync(repo);
    return {
      sessionId,
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: homedir(),
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        TERM: "xterm-256color",
        ANTHROPIC_API_KEY: IDENTITY_KEY,
        ANTHROPIC_BASE_URL: probe.url,
      },
      model: "anthropic/haiku",
      mcpServers: { probe: { type: "http", url: `${probe.url}/mcp` } },
      ...overrides,
    };
  }

  /** Starts the planned TUI and waits until it can take a prompt. */
  async function launch(plan: LaunchPlan): Promise<Terminal> {
    scratch.push(...plan.tmpDirs);
    const terminal = runOnTerminal(plan.command, plan.args, { env: plan.env, ...(plan.cwd ? { cwd: plan.cwd } : {}) });
    onTestFailed(() => console.log("screen:", terminal.screen().slice(-3000)));
    let acceptedBypass = false;
    await until(() => {
      const screen = terminal.screen();
      // First run with --dangerously-skip-permissions asks once to accept it.
      if (!acceptedBypass && /Yes, I accept/.test(screen)) {
        acceptedBypass = true;
        terminal.press("\x1b[B");
        setTimeout(() => terminal.press("\r"), 300);
      }
      return /for shortcuts|❯/.test(screen);
    }, 45_000, "the TUI to be ready");
    await sleep(1_500);
    return terminal;
  }

  function transcriptOf(conversationId: string): string | undefined {
    const projects = join(homedir(), ".claude", "projects");
    for (const project of readdirSync(projects)) {
      const path = join(projects, project, `${conversationId}.jsonl`);
      if (existsSync(path)) {
        transcripts.push(path);
        return path;
      }
    }
    return undefined;
  }

  it("guest: runs on the identity's key without asking, on Barry's tools only, under the reserved conversation id", async () => {
    const plan = await adapter.modes.guest!.plan(sessionConfig("live-guest"));
    const before = probe.modelRequests.length;
    const terminal = await launch(plan);
    try {
      expect(terminal.screen()).not.toMatch(/custom API key|use this API key/);
      await terminal.submit("Reply with only the word PONG");
      // claude sends a tool-less request before the turn itself.
      await until(() => probe.modelRequests.slice(before).some((request) => request.stream && request.tools.length > 0), 45_000, "the turn to reach the model");
    } finally {
      await terminal.close();
    }

    const requests = probe.modelRequests.slice(before);
    expect(requests.map((request) => request.credential)).toEqual(requests.map(() => "expected"));
    const turn = requests.find((request) => request.stream && request.tools.length > 0)!;
    expect(turn.tools).toContain("mcp__probe__probe_tool");
    expect(turn.tools.filter((tool) => NATIVE_TOOLS.includes(tool))).toEqual([]);
    expect(probe.mcpCalls.some((call) => call.method === "tools/list" && call.sessionId === "live-guest")).toBe(true);
    expect(transcriptOf(plan.harnessSessionId!)).toBeDefined();
  });

  it("instrumented: is woken while idle by a message on its inbox socket, and reports to the telemetry receiver", async () => {
    const plan = await adapter.modes.instrumented!.plan(sessionConfig("live-instrumented", { telemetryEndpoint: probe.url }));
    expect(plan.guarantees.delivery).toBe("wake-peer-framed");
    const before = probe.modelRequests.length;
    const terminal = await launch(plan);
    try {
      await terminal.submit("Reply with only the word PONG");
      await until(() => probe.modelRequests.slice(before).some((request) => request.stream), 45_000, "the first turn");
      await sleep(3_000);
      await expect(plan.inbox!.deliver({ content: "barry-live-wake-word" })).resolves.toBe(true);
      await until(
        () => probe.modelRequests.slice(before).some((request) => request.stream && request.body.includes("barry-live-wake-word")),
        45_000,
        "the delivered message to start a turn",
      );
      await until(() => probe.telemetryPaths.length > 0, 30_000, "telemetry to arrive");
    } finally {
      await terminal.close();
    }
    expect(probe.modelRequests.slice(before).every((request) => request.credential === "expected")).toBe(true);
  });

  it("never falls back to the user's own login: a bogus key is refused by the real API", async (context) => {
    const status = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8" })) as { loggedIn?: boolean };
    if (!status.loggedIn) context.skip("needs a claude /login on this machine to show the TUI does not use it");

    const config = sessionConfig("live-bogus");
    const { ANTHROPIC_BASE_URL: _probe, ...realApi } = config.env;
    const plan = await adapter.modes.guest!.plan({ ...config, env: { ...realApi, ANTHROPIC_API_KEY: BOGUS_KEY } });
    const terminal = await launch(plan);
    try {
      await terminal.submit("Reply with only the word PONG");
      await until(() => /API key is invalid|invalid x-api-key|authentication_error/i.test(terminal.screen()), 60_000, "the API to refuse the key");
    } finally {
      await terminal.close();
    }
    expect(terminal.screen()).not.toMatch(/⏺ PONG/);
    transcriptOf(plan.harnessSessionId!);
  });
});
