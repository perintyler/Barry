/**
 * The Antigravity modes' guarantees, checked against the real `agy` binary.
 *
 * Opt-in, because it needs the pinned build on PATH and drives a real TUI:
 *
 *   BARRY_ANTIGRAVITY_LIVE=1 pnpm exec vitest run src/live
 *
 * The model and Barry's MCP server are a local fake, so the probe runs spend
 * nothing. The bogus-key check uses the real API with a key that cannot work,
 * which shows agy sends the identity's key and never falls back to the user's
 * cached Google OAuth login.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import type { LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";
import { ANTIGRAVITY_REQUIREMENTS } from "../bin.js";
import { VERIFIED_ON } from "../modes.js";
import { REPLY, startProbe, type Probe } from "./probe.js";
import { runOnTerminal, sleep, until, type Terminal } from "./terminal.js";

const LIVE = process.env.BARRY_ANTIGRAVITY_LIVE === "1";
const IDENTITY_KEY = "test-barry-gemini-identity-key-12345";
const BOGUS_KEY = "AIzaSyFakeKeyBogus00000000000000000000000";

describe.runIf(LIVE)("antigravity TUI modes, live", { timeout: 180_000 }, () => {
  let probe: Probe;
  const scratch: string[] = [];

  beforeAll(async () => {
    const version = execFileSync("agy", ["--version"], { encoding: "utf8" });
    expect(
      version,
      "the agy on PATH is not the build the guarantees were verified on",
    ).toContain(ANTIGRAVITY_REQUIREMENTS.binary.recommendedVersion!);
    expect(ANTIGRAVITY_REQUIREMENTS.binary.recommendedVersion!).toBe(VERIFIED_ON);
    probe = await startProbe(IDENTITY_KEY);
  });

  afterAll(async () => {
    await probe?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  function made(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-live-")));
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
        PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
        USER: process.env.USER,
        SHELL: process.env.SHELL,
        TERM: "xterm-256color",
        GEMINI_API_KEY: IDENTITY_KEY,
      },
      endpoint: {
        baseUrl: probe.url,
        apiKey: IDENTITY_KEY,
      },
      mcpServers: { probe: { type: "http", url: `${probe.url}/mcp` } },
      ...overrides,
    };
  }

  async function launch(plan: LaunchPlan): Promise<Terminal> {
    scratch.push(...plan.tmpDirs);
    const terminal = runOnTerminal(plan.command, plan.args, {
      env: { ...plan.env, TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      cwd: plan.cwd,
    });
    onTestFailed(() => {
      console.log("screen:", terminal.screen().slice(-2000));
      console.log("requests:", JSON.stringify(probe.modelRequests.slice(-2)));
    });

    let answeredTheme = false;
    let answeredTerms = false;
    let answeredTrust = false;

    await until(() => {
      const screen = terminal.screen();
      const recent = screen.slice(-1500);
      if (!answeredTheme && /Choose your color scheme/.test(screen)) {
        answeredTheme = true;
        terminal.press("\r");
      }
      if (!answeredTerms && /Terms of Service & Data Use/.test(screen)) {
        answeredTerms = true;
        terminal.press("\x1b[B\x1b[C\r");
      }
      if (!answeredTrust && /Do you trust the contents of this project/.test(screen)) {
        answeredTrust = true;
        terminal.press("\r");
      }
      return answeredTerms && /Antigravity CLI/.test(screen) && /\? for shortcuts/.test(screen);
    }, 45_000, "the agy TUI to be ready");
    await sleep(1_000);
    return terminal;
  }

  it.each((["guest", "instrumented"] as const).flatMap(mode => (["valid", "missing", "error", "timeout"] as const).map(failure => ({ mode, failure }))))("$mode native gate failure $failure preserves refusal", async ({ mode, failure }) => {
    const config = sessionConfig(`tui-${mode}-${failure}`, { allowedNativeTools: ["run_command"], options: { relayCommand: "echo '{}'" } });
    const plan = await adapter.modes[mode]!.plan(config);
    if (!plan.cwd) throw new Error("Missing generated workspace");
    const gate = join(plan.cwd, ".agents", "tool_gate.cjs");
    if (failure === "missing") rmSync(gate);
    else if (failure !== "valid") writeFileSync(gate, failure === "error" ? "throw new Error('synthetic gate failure');" : "setInterval(() => {}, 1000);", { mode: 0o600 });
    const sentinel = join(config.cwd, "sentinel");
    const before = probe.modelRequests.length;
    const terminal = await launch(plan);
    try {
      await terminal.submit(`FORCE_SHELL:${sentinel}`);
      await until(() => probe.modelRequests.slice(before).some(request => request.body.includes("functionResponse")), 30_000, "the forced native tool outcome to reach the local model");
      expect(existsSync(sentinel)).toBe(failure === "valid");
    } finally { await terminal.close(); }
  }, 90_000);

  it("launches guest mode with identity key and tool gating", async () => {
    const recordedEvents: Array<{ event: string; payload: unknown }> = [];
    const relayScript = join(made(), "relay.cjs");
    writeFileSync(
      relayScript,
      `let data = '';
process.stdin.on('data', c => data += c);
process.stdin.on('end', () => {
  const fs = require('node:fs');
  fs.appendFileSync(${JSON.stringify(join(made(), "relay.log"))}, data + '\\n---\\n');
  console.log(JSON.stringify({}));
});
`,
      { mode: 0o755 },
    );

    const config = sessionConfig("sess-guest-live", {
      options: { relayCommand: `${process.execPath} ${relayScript}` },
    });

    const plan = await adapter.modes.guest!.plan(config);
    expect(plan.guarantees.identity).toBe("mcp-url");
    expect(plan.guarantees.gating).toBe("hooks");
    expect(plan.env.HOME).toBe(plan.cwd);
    expect(plan.env.GOOGLE_GEMINI_BASE_URL).toBe(probe.url);

    const initialRequests = probe.modelRequests.length;
    const term = await launch(plan);

    try {
      await term.submit("Hello Antigravity");
      await until(
        () => probe.modelRequests.length > initialRequests,
        30_000,
        "model request to reach probe",
      );

      const req = probe.modelRequests[probe.modelRequests.length - 1];
      expect(req.credential).toBe("expected");
      expect(req.rawKey).toBe(IDENTITY_KEY);

      // Verify the response is displayed
      await until(
        () => term.screen().includes(REPLY),
        30_000,
        "reply to appear on screen",
      );

      // Verify conversation ID discovery
      const convId = await plan.discoverHarnessSessionId?.();
      expect(convId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
      await term.close();
    }
  });

  it("delivers messages in instrumented mode with sender attribution and honest reporting", async () => {
    const config = sessionConfig("sess-inst-live", {
      options: { relayCommand: "echo '{}'" },
    });

    const plan = await adapter.modes.instrumented!.plan(config);
    expect(plan.inbox).toBeDefined();
    expect(plan.guarantees.delivery).toBe("turn-end");

    const term = await launch(plan);

    try {
      // Deliver a message while the TUI is running
      const delivered = await plan.inbox!.deliver({
        content: "Peer guidance message",
        from: "super-agent",
      });
      expect(delivered).toBe(true);

      const beforeTurnRequests = probe.modelRequests.length;
      await term.submit("Continue");

      await until(
        () => probe.modelRequests.some((r) => r.body.includes("[super-agent]: Peer guidance message")),
        30_000,
        "turn to reach probe with injected message",
      );

      const injectedReq = probe.modelRequests.find((r) =>
        r.body.includes("[super-agent]: Peer guidance message"),
      );
      expect(injectedReq).toBeDefined();
      expect(injectedReq?.credential).toBe("expected");
    } finally {
      await term.close();
    }

    // Report delivery failure when its required workspace is unavailable.
    // Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
    rmSync(plan.cwd!, { recursive: true, force: true });
    const lateDelivery = await plan.inbox!.deliver({ content: "lost message" });
    expect(lateDelivery).toBe(false);
  });

  it("fails immediately on bogus GEMINI_API_KEY without falling back to Google login", () => {
    const home = made();
    const cliDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "settings.json"), JSON.stringify({ modelProvider: "gemini" }));

    const res = spawnSync("agy", ["--print", "Test auth rejection"], {
      env: {
        PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
        HOME: home,
        GEMINI_API_KEY: BOGUS_KEY,
      },
      encoding: "utf8",
    });

    // Code 3 indicates agent executor HTTP 400 API key not valid
    expect(res.status).toBe(3);
    expect(res.stderr).toContain("API key not valid");
    expect(res.stderr).not.toContain("OAuth");
  });
});
