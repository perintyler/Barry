/**
 * The codex modes' guarantees, checked against the real `codex` binary.
 *
 * Opt-in, because it needs the pinned build on PATH and drives real TUIs:
 *
 *   BARRY_CODEX_LIVE=1 pnpm exec vitest run src/live
 *
 * The model and Barry's MCP server are a local fake, so the probe runs spend
 * nothing. The bogus-key checks use the real API with a key that cannot work,
 * which shows codex sends the identity's key and never falls back to the
 * user's own codex login.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest";
import type { StartEngine, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import { configureHarnessSession } from "@barry-rocks/sdk/sessions";

import type { SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";
import { clientUrl, connectWhenReady, webSocketAdapter } from "../app-server/host.js";
import { AppServerClient } from "../app-server/protocol.js";
import { startCodexHosted } from "../hosted/app-server-session.js";
import { CODEX_HOSTED, CODEX_REQUIREMENTS } from "../modes.js";
import { NATIVE_TOOLS } from "../native-tools.js";
import { defaultCodexHome } from "../runtime.js";
import { codexTranscript } from "../transcript.js";
import { startProbe, type Probe } from "./probe.js";
import { runOnTerminal, sleep, until, type Terminal } from "./terminal.js";

const LIVE = process.env.BARRY_CODEX_LIVE === "1";
const KEYS = { IDENTITY: "sk-barry-live-identity", AMBIENT: "sk-barry-live-ambient" };
const BOGUS_KEY = "sk-proj-barry-live-bogus-" + "0".repeat(42);
const GUIDANCE = "BARRY-LIVE-GUIDANCE";
const OPENAI = 'base_url = "https://api.openai.com/v1"';

describe.runIf(LIVE)("codex modes, live", { timeout: 240_000 }, () => {
  let probe: Probe;
  let sentinel: string;
  const scratch: string[] = [];

  beforeAll(async () => {
    const version = execFileSync("codex", ["--version"], { encoding: "utf8" });
    expect(version, "the codex on PATH is not the build the guarantees were verified on").toContain(CODEX_REQUIREMENTS.binary.pin.version);
    sentinel = join(made(), "native-sentinel.txt");
    probe = await startProbe(KEYS, { guidance: GUIDANCE, sentinel });
  });

  afterAll(async () => {
    await probe?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function made(root = tmpdir()): string {
    const dir = realpathSync(mkdtempSync(join(root, "cx-live-")));
    scratch.push(dir);
    return dir;
  }

  /**
   * A user home whose own codex has answered the gpt-5.5 migration prompt, so
   * the launch's carrying it over is what keeps the prompt away.
   */
  function answeredHome(): string {
    const home = made();
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), '[notice.model_migrations]\n"gpt-5.5" = "gpt-6-sol"\n');
    return home;
  }

  function sessionConfig(sessionId: string, key = KEYS.IDENTITY, home = answeredHome()): SessionConfig {
    const repo = join(made(), "repo");
    mkdirSync(repo);
    return {
      sessionId,
      cwd: repo,
      env: { PATH: process.env.PATH, HOME: home, USER: process.env.USER, OPENAI_API_KEY: key },
      model: "openai/gpt-5.5",
      systemPrompt: `${GUIDANCE}: you are a Barry session.`,
      mcpServers: { probe: { type: "http", url: `${probe.url}/mcp` } },
    };
  }

  /** Sends the planned TUI's model traffic to the fake rather than OpenAI. */
  function onProbe(plan: LaunchPlan): void {
    const config = join(plan.env.CODEX_HOME!, "config.toml");
    writeFileSync(config, readFileSync(config, "utf8").replace(OPENAI, `base_url = "${probe.url}/v1"`));
  }

  async function launch(plan: LaunchPlan, cwd: string): Promise<Terminal> {
    scratch.push(plan.env.CODEX_HOME!);
    const terminal = runOnTerminal(plan.command, plan.args, { env: { ...plan.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" }, cwd });
    onTestFailed(() => console.log("screen:", terminal.screen().slice(-1500), "\nrequests:", JSON.stringify(probe.modelRequests.slice(-3).map((r) => ({ credential: r.credential, tools: r.tools, last: r.lastInput.slice(0, 160) })))));
    await until(() => {
      const screen = terminal.screen();
      if (/Try new model/.test(screen)) throw new Error("a model-migration prompt took the first input");
      return /Ask Codex|for shortcuts/.test(screen);
    }, 45_000, "the TUI to be ready");
    await sleep(1_500);
    return terminal;
  }

  it("guest: runs on the identity's key with Barry's guidance and tools, refuses a native call, and is found by its rollout", async () => {
    const config = sessionConfig("live-guest");
    const plan = await adapter.modes.guest!.plan(config);
    onProbe(plan);
    const before = probe.modelRequests.length;
    const terminal = await launch(plan, config.cwd);
    try {
      expect(terminal.screen()).not.toMatch(/Sign in with ChatGPT|connect an API key/);
      await terminal.submit("CALL_PROBE please");
      await until(() => probe.mcpCalls.some((call) => call.method === "tools/call" && call.sessionId === "live-guest"), 45_000, "Barry's tool to run");
      await until(() => probe.modelRequests.slice(before).some((request) => request.lastInput.includes("probe-tool-ran")), 30_000, "the tool result");
      await terminal.submit("NATIVE_PROBE:apply_patch");
      await until(() => probe.modelRequests.slice(before).some((request) => request.lastInput.includes("PreToolUse")), 45_000, "the hook to refuse");
    } finally {
      await terminal.close();
    }
    const requests = probe.modelRequests.slice(before);
    expect(requests.map((request) => request.credential)).toEqual(requests.map(() => "IDENTITY"));
    expect(requests.some((request) => request.guided)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    const threadId = await plan.discoverHarnessSessionId!();
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await codexTranscript.locate({ harnessSessionId: threadId! })).toContain(threadId);
  });

  it("guest: two at once each reach Barry under their own session, never through a shared engine", async () => {
    const [a, b] = [sessionConfig("live-guest-a"), sessionConfig("live-guest-b")];
    const [planA, planB] = [await adapter.modes.guest!.plan(a), await adapter.modes.guest!.plan(b)];
    onProbe(planA);
    onProbe(planB);
    const [tuiA, tuiB] = [await launch(planA, a.cwd), await launch(planB, b.cwd)];
    try {
      await tuiA.submit("CALL_PROBE please");
      await tuiB.submit("CALL_PROBE please");
      await until(() => ["live-guest-a", "live-guest-b"].every((id) => probe.mcpCalls.some((call) => call.method === "tools/call" && call.sessionId === id)), 60_000, "both tools to run");
    } finally {
      await Promise.all([tuiA.close(), tuiB.close()]);
    }
  });

  it("guest: a bogus key is refused by the real API, and the user's own codex login is never used", async () => {
    // The real home, where the user's own codex login lives. Codex's default
    // model, because this machine may not have answered gpt-5.5's migration prompt.
    const { model: _model, ...config } = sessionConfig("live-guest-bogus", BOGUS_KEY, homedir());
    const terminal = await launch(await adapter.modes.guest!.plan(config), config.cwd);
    try {
      await terminal.submit("Reply with PONG");
      await until(() => /Incorrect API key|invalid_api_key/.test(terminal.screen()), 60_000, "the API to refuse the key");
    } finally {
      await terminal.close();
    }
  });

  /** Engines as the sessions bag starts them: the session's env only, nothing inherited. */
  function engineStarter(overrideArgs: string[]) {
    const children = new Set<ChildProcess>();
    const startEngine: StartEngine = async (spec) => {
      const address = join(made(realpathSync("/tmp")), "engine.sock");
      const command = spec.command(address);
      const child = spawn(command.command, [...command.args, ...overrideArgs], { cwd: spec.cwd, env: command.env, stdio: "ignore" });
      children.add(child);
      return { sessionId: spec.sessionId, address, recordVersion: async () => undefined, stop: async () => void child.kill() };
    };
    return { startEngine, stopAll: () => children.forEach((child) => child.kill()) };
  }

  async function turn(config: SessionConfig, prompt: string, overrideArgs: string[], beforeDeliver?: (home: string) => void): Promise<SessionEvent[]> {
    const { startEngine, stopAll } = engineStarter(overrideArgs);
    try {
      const session = await adapter.modes.hosted!.start(config, startEngine);
      scratch.push(defaultCodexHome(config.sessionId));
      beforeDeliver?.(defaultCodexHome(config.sessionId));
      await session.deliver(prompt);
      const events: SessionEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === "done") break;
      }
      await session.close();
      return events;
    } finally {
      stopAll();
    }
  }

  it("hosted: the engine sends the identity's key and runs Barry's tool", async () => {
    const before = probe.modelRequests.length;
    const events = await turn(sessionConfig("live-hosted"), "CALL_PROBE please", ["-c", `model_providers.barry-openai.base_url="${probe.url}/v1"`]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const requests = probe.modelRequests.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.credential === "IDENTITY")).toBe(true);
    expect(probe.mcpCalls.some((call) => call.method === "tools/call" && call.sessionId === "live-hosted")).toBe(true);
  });

  // BARRY_CODEX_LIVE=1: installed codex and local Responses probe, no secrets.
  it("native grants allow file writes and refuse shell", async () => {
    vi.stubEnv("BARRY_HOME", made());
    try {
      const overrides = ["-c", `model_providers.barry-openai.base_url="${probe.url}/v1"`];
      const written = await turn({ ...sessionConfig("native-write"), allowedNativeTools: ["apply_patch"] }, "NATIVE_PROBE:apply_patch", overrides);
      expect(written.some(event => event.type === "error")).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toContain("native executed");
      const refused = await turn({ ...sessionConfig("native-shell-denied"), allowedNativeTools: ["apply_patch"] }, "NATIVE_PROBE:exec_command", overrides);
      expect(JSON.stringify(refused)).toMatch(/Barry tools only|unsupported call: exec_command|not found|not available/);
      expect(existsSync(sentinel + "-shell")).toBe(false);
      expect(probe.modelRequests.at(-1)?.tools.some(tool => tool.includes("exec_command") || tool.includes("write_stdin"))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["missing", "error", "timeout"] as const)("native gate failure: %s refuses the forced write", async failure => {
    rmSync(sentinel, { force: true });
    const before = probe.modelRequests.length;
    const config = { ...sessionConfig(`gate-${failure}`), allowedNativeTools: ["apply_patch"] };
    const events = await turn(config, "NATIVE_PROBE:apply_patch", ["-c", `model_providers.barry-openai.base_url="${probe.url}/v1"`], home => {
      const gate = join(home, "barry-tool-gate.cjs");
      if (failure === "missing") rmSync(gate);
      else writeFileSync(gate, failure === "error" ? "throw new Error('synthetic gate failure');" : "setInterval(() => {}, 1000);", { mode: 0o600 });
    });
    expect(probe.modelRequests.slice(before).some(request => request.tools.some(tool => tool.includes("apply_patch")))).toBe(true);
    expect(existsSync(sentinel), JSON.stringify(events)).toBe(false);
  }, 45_000);

  it("hosted: a bogus key is refused by the real API, rather than sent without a key or replaced by a login", async () => {
    const events = await turn(sessionConfig("live-hosted-bogus", BOGUS_KEY), "Reply with PONG", []);
    const errors = events.filter((event) => event.type === "error").map((event) => JSON.stringify(event));
    expect(errors.join("\n")).toMatch(/Incorrect API key|invalid_api_key/);
  });

  it.each((["guest", "instrumented"] as const).flatMap(mode =>
    (["valid", "missing", "error", "timeout"] as const).map(failure => ({ mode, failure })),
  ))("TUI gate: $mode $failure", async ({ mode, failure }) => {
    rmSync(sentinel, { force: true });
    const config = { ...sessionConfig(`tui-${mode}-${failure}`), allowedNativeTools: ["apply_patch"] };
    const { startEngine, stopAll } = engineStarter(["-c", `model_providers.barry-openai.base_url="${probe.url}/v1"`]);
    let session: Awaited<ReturnType<typeof startCodexHosted>> | undefined;
    let terminal: Terminal | undefined;
    try {
      let plan: LaunchPlan;
      if (mode === "guest") {
        plan = await adapter.modes.guest!.plan(config);
        onProbe(plan);
      } else {
        session = await startCodexHosted(config, startEngine, { guarantees: CODEX_HOSTED.guarantees });
        const attachment = await session.attach!();
        plan = await adapter.modes.instrumented!.plan({ ...config, options: { attachment } });
      }
      const gate = join(plan.env.CODEX_HOME!, "barry-tool-gate.cjs");
      if (failure === "missing") rmSync(gate);
      else if (failure !== "valid") writeFileSync(gate, failure === "error" ? "throw new Error('synthetic gate failure');" : "setInterval(() => {}, 1000);", { mode: 0o600 });
      terminal = await launch(plan, config.cwd);
      const before = probe.modelRequests.length;
      await terminal.submit("NATIVE_PROBE:apply_patch");
      await until(() => probe.modelRequests.slice(before).some(request => request.lastInput.includes("custom_tool_call_output")), 45_000, "the native outcome to return to the model");
      expect(probe.modelRequests.slice(before).some(request => request.tools.some(tool => tool.includes("apply_patch")))).toBe(true);
      expect(existsSync(sentinel)).toBe(failure === "valid");
    } finally {
      session?.detach?.();
      await terminal?.close();
      await session?.close();
      stopAll();
    }
  }, 90_000);

  /** Reads one turn another client started, to its end. */
  async function nextTurn(turns: AsyncIterator<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for (;;) {
      const next = await turns.next();
      if (next.done) return events;
      events.push(next.value);
      if (next.value.type === "done") return events;
    }
  }

  /** What a person does with `/hooks` in the TUI: switch Barry's gate off, from a client of its own. */
  async function switchGateOff(address: string, home: string, cwd: string): Promise<void> {
    const client = new AppServerClient(webSocketAdapter(await connectWhenReady(clientUrl(address))));
    await client.call("initialize", { clientInfo: { name: "barry-live-test", version: "0" }, capabilities: { experimentalApi: true } });
    client.notify("initialized", {});
    const listed = await client.call("hooks/list", { cwds: [cwd] }) as { data: Array<{ hooks: Array<{ key: string; sourcePath: string; eventName: string; currentHash: string }> }> };
    const gate = listed.data.flatMap((entry) => entry.hooks).find((hook) => hook.sourcePath === join(home, "hooks.json") && hook.eventName === "preToolUse")!;
    await client.call("config/batchWrite", { filePath: join(home, "config.toml"), reloadUserConfig: true, edits: [{ keyPath: `hooks.state.${JSON.stringify(gate.key)}`, mergeStrategy: "replace", value: { enabled: false, trusted_hash: gate.currentHash } }] });
  }

  it("instrumented: the TUI on Barry's engine shows Barry's turns, brings the person's to Barry, outlives the idle release, and keeps the gate", async () => {
    const config = configureHarnessSession(sessionConfig("live-attach"), NATIVE_TOOLS);
    const home = defaultCodexHome(config.sessionId);
    scratch.push(home);
    const { startEngine, stopAll } = engineStarter(["-c", `model_providers.barry-openai.base_url="${probe.url}/v1"`]);
    const before = probe.modelRequests.length;
    const session = await startCodexHosted(config, startEngine, { guarantees: CODEX_HOSTED.guarantees, releaseAfterMs: 1_000 });
    let terminal: Terminal | undefined;
    try {
      const attachment = await session.attach!();
      const plan = await adapter.modes.instrumented!.plan({ ...config, options: { attachment } });
      expect(plan.env.OPENAI_API_KEY).toBeUndefined();
      terminal = await launch(plan, config.cwd);
      expect(terminal.screen()).not.toMatch(/Sign in with ChatGPT|connect an API key/);

      await sleep(2_500);
      await session.deliver("ECHO:barry-turn");
      await until(() => terminal!.screen().includes("echoed barry-turn"), 45_000, "Barry's turn to show in the TUI");

      const turns = session.externalTurns!()[Symbol.asyncIterator]();
      await terminal.submit("ECHO:person-turn");
      const typed = await nextTurn(turns);
      expect(typed).toContainEqual({ type: "text", text: "ECHO:person-turn", role: "user" });
      expect(typed.some((event) => event.type === "text" && event.text === "echoed person-turn")).toBe(true);

      await switchGateOff(attachment.address, home, config.cwd);
      await terminal.submit("CALL_PROBE please");
      await nextTurn(turns);
      expect(session.warnings?.join("\n")).toMatch(/switched off.*turned back on/);
      expect(terminal.screen()).not.toMatch(/Hook failed/);
      expect(probe.mcpCalls.some((call) => call.method === "tools/call" && call.sessionId === "live-attach")).toBe(true);

      await terminal.submit("NATIVE_PROBE:apply_patch");
      await nextTurn(turns);
      await until(() => probe.modelRequests.slice(before).some((request) => request.lastInput.includes("PreToolUse")), 30_000, "the hook to refuse");
    } finally {
      session.detach?.();
      await terminal?.close();
      await session.close();
      stopAll();
    }
    const requests = probe.modelRequests.slice(before);
    expect(requests.map((request) => request.credential)).toEqual(requests.map(() => "IDENTITY"));
    // The TUI also asks the model for a title, without tools or guidance.
    const turnRequests = requests.filter((request) => request.tools.length > 0);
    expect(turnRequests.length).toBeGreaterThan(0);
    expect(turnRequests.every((request) => request.guided)).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });
});
