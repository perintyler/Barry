/**
 * The cursor modes' guarantees, checked against the real `cursor-agent`.
 *
 * Opt-in, because cursor's model is its own and cannot be faked: the positive
 * checks spend a few short turns on the key in `BARRY_CURSOR_LIVE_KEY`.
 *
 *   BARRY_CURSOR_LIVE=1 BARRY_CURSOR_LIVE_KEY=… pnpm exec vitest run src/live
 *
 * Every run uses a scratch `BARRY_HOME`, so the session homes are scratch too.
 * Barry's MCP server is a local stand-in. The user's real home is never used.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from "vitest";
import type { LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";
import { chatExists } from "../launch.js";
import { VERIFIED_ON } from "../modes.js";
import { cursorHome } from "../runtime.js";
import { cursorTranscript } from "../transcript.js";
import { startMcpProbe, type McpProbe } from "./mcp-probe.js";
import { runOnTerminal, sleep, until, type Terminal } from "./terminal.js";

const workspaces = vi.hoisted(() => [] as string[]);
vi.mock("../workspace.js", async original => {
  const workspace = await original<typeof import("../workspace.js")>();
  return { ...workspace, writeCursorSessionWorkspace(...args: Parameters<typeof workspace.writeCursorSessionWorkspace>) {
    const plan = workspace.writeCursorSessionWorkspace(...args);
    workspaces.push(plan.workspaceDir);
    return plan;
  } };
});

const LIVE = process.env.BARRY_CURSOR_LIVE === "1";
const KEY = process.env.BARRY_CURSOR_LIVE_KEY ?? "";
const BOGUS_KEY = "crsr_barry_live_bogus_0000000000000000000000000000000000000000";
const MODEL = "cursor/claude-haiku-5-5-low";
const VERSIONS = join(homedir(), ".local", "share", "cursor-agent", "versions");

describe.runIf(LIVE)("cursor modes, live", { timeout: 300_000 }, () => {
  let probe: McpProbe;
  let scratch: string;
  let builds: string[];
  const savedBarryHome = process.env.BARRY_HOME;

  beforeAll(async () => {
    expect(KEY, "BARRY_CURSOR_LIVE_KEY must hold a real Cursor API key").not.toBe("");
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "cursor-live-")));
    process.env.BARRY_HOME = join(scratch, "barry");
    builds = readdirSync(VERSIONS);
    expect(builds.some((name) => name.startsWith(`${VERIFIED_ON}-`)), `cursor-agent ${VERIFIED_ON} must be installed`).toBe(true);
    probe = await startMcpProbe();
  });

  afterAll(async () => {
    await probe?.close();
    if (savedBarryHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = savedBarryHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  function sessionConfig(sessionId: string, key = KEY): SessionConfig {
    const repo = join(scratch, `repo-${sessionId}`);
    mkdirSync(repo, { recursive: true });
    return {
      sessionId,
      cwd: repo,
      env: { PATH: process.env.PATH, USER: process.env.USER, TMPDIR: process.env.TMPDIR, LANG: "en_US.UTF-8", TERM: "xterm-256color", CURSOR_API_KEY: key },
      model: MODEL,
      mcpServers: { probe: { type: "http", url: `${probe.url}?sessionId=${sessionId}` } },
    };
  }

  const calledProbe = (sessionId: string) => probe.calls.some((call) => call.method === "tools/call" && call.sessionId === sessionId);

  async function launch(plan: LaunchPlan): Promise<Terminal> {
    const terminal = runOnTerminal(plan.command, plan.args, { env: plan.env, ...(plan.cwd ? { cwd: plan.cwd } : {}) });
    onTestFailed(() => console.log("screen:", terminal.screen().slice(-1500)));
    await until(() => /Run Everything/.test(terminal.screen()), 60_000, "the TUI to be ready");
    await sleep(2_000);
    return terminal;
  }

  async function turn(session: { deliver(content: string): Promise<unknown>; events(): AsyncIterable<SessionEvent> }, prompt: string): Promise<SessionEvent[]> {
    await session.deliver(prompt);
    const events: SessionEvent[] = [];
    for await (const event of session.events()) {
      events.push(event);
      if (event.type === "done") break;
    }
    return events;
  }

  it("hosted: answers on the key over ACP, runs Barry's tool, and refuses a native call", async () => {
    const config = sessionConfig("live-hosted");
    const sentinel = join(config.cwd, "native-sentinel.txt");
    const session = await adapter.modes.hosted!.start(config, () => Promise.reject(new Error("cursor runs no engine")));
    try {
      const first = await turn(session, "Call the probe_tool tool from the probe MCP server once, then reply DONE.");
      expect(calledProbe("live-hosted")).toBe(true);
      expect(first).toContainEqual(expect.objectContaining({ type: "tool_use", tool: "mcp__probe__probe_tool" }));

      const second = await turn(session, `Use your shell tool to run exactly: touch ${sentinel} . Do not use any other tool.`);
      // Refused by the workspace's denylist before cursor would ask Barry.
      expect(second).toContainEqual(expect.objectContaining({ type: "tool_use", tool: "Shell" }));
      expect(second).not.toContainEqual(expect.objectContaining({ type: "permission_request", tool: "Shell" }));
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      await session.close();
    }
    expect(existsSync(join(cursorHome("live-hosted"), ".cursor", "acp-sessions"))).toBe(true);
  });

  // Author only: BARRY_CURSOR_LIVE=1 plus BARRY_CURSOR_LIVE_KEY; spends paid turns.
  it("native grants record hosted control evidence for the author", async () => {
    const config = sessionConfig("native-evidence");
    const fixture = join(config.cwd, "fixture.txt"), sentinel = join(config.cwd, "sentinel");
    writeFileSync(fixture, "GRANTED_NATIVE_READ");
    const session = await adapter.modes.hosted!.start({ ...config, allowedNativeTools: ["Read", "Grep", "List", "Glob"], decide: async () => ({ allow: true }) }, () => Promise.reject(Error("no engine")));
    const workspace = workspaces.at(-1)!;
    const gate = join(workspace, ".cursor", "barry-tool-gate.cjs");
    const hooks = join(config.cwd, "hooks.jsonl");
    writeFileSync(gate, readFileSync(gate, "utf8").replace("let allowed = false;", `require('node:fs').appendFileSync(${JSON.stringify(hooks)}, data + '\n');
  let allowed = false;`));
    const evidence: Record<string, SessionEvent[]> = {};
    try {
      evidence.Read = await turn(session, `Use only your native Read tool to read ${fixture} and quote its contents.`);
      expect(JSON.stringify(evidence.Read)).toContain("GRANTED_NATIVE_READ");
      evidence.Shell = await turn(session, `Use only your native Shell tool to run: touch ${sentinel}.`);
      expect(existsSync(sentinel)).toBe(false);
      for (const tool of ["Grep", "List", "Glob", "Fetch", "WebSearch"]) {
        evidence[tool] = await turn(session, `Use only your native ${tool} tool once. For filesystem tools inspect ${config.cwd} for GRANTED_NATIVE_READ. For Fetch use ${probe.url}. For WebSearch search for Barry agent platform. Report a refusal if unavailable.`);
      }
      writeFileSync(join(config.cwd, "native-evidence.json"), JSON.stringify({ events: evidence, hooks: existsSync(hooks) ? readFileSync(hooks, "utf8") : "No hook payloads" }, null, 2));
      console.info("Cursor native evidence:", JSON.stringify({ events: evidence, hooks: existsSync(hooks) ? readFileSync(hooks, "utf8") : "No hook payloads" }));
    } finally { await session.close(); }
  });

  it("guest: the TUI in its own home runs Barry's tool, has a native call refused, and its chat is resumed and found", async () => {
    const config = sessionConfig("live-guest");
    const sentinel = join(config.cwd, "native-sentinel.txt");
    const plan = await adapter.modes.guest!.plan(config);
    expect(plan.harnessSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const terminal = await launch(plan);
    try {
      expect(terminal.screen()).not.toMatch(/Sign in|Log in/i);
      await terminal.submit("Call the probe_tool tool from the probe MCP server once, then reply DONE.");
      await until(() => calledProbe("live-guest"), 90_000, "Barry's tool to run");
      await terminal.submit(`Use your shell tool to run exactly: touch ${sentinel} . Do not use any other tool.`);
      await until(() => /Barry tools only|blocked|denied/i.test(terminal.screen()), 90_000, "the native call to be refused");
    } finally {
      await terminal.close();
      for (const dir of plan.tmpDirs) rmSync(dir, { recursive: true, force: true });
    }
    expect(existsSync(sentinel)).toBe(false);
    const chat = plan.harnessSessionId!;
    expect(chatExists(cursorHome("live-guest"), chat)).toBe(true);
    expect(await cursorTranscript.locate({ harnessSessionId: chat })).toContain(chat);

    const resumed = await adapter.modes.guest!.plan({ ...config, resume: { harnessSessionId: chat } });
    for (const dir of resumed.tmpDirs) rmSync(dir, { recursive: true, force: true });
    expect(resumed.harnessSessionId).toBe(chat);
    expect(resumed.warnings.join(" ")).not.toMatch(/new chat/);
  });

  it("guest: a bogus key is refused by Cursor, and no turn runs", async () => {
    const config = sessionConfig("live-guest-bogus", BOGUS_KEY);
    const plan = await adapter.modes.guest!.plan(config);
    const terminal = runOnTerminal(plan.command, plan.args, { env: plan.env, ...(plan.cwd ? { cwd: plan.cwd } : {}) });
    onTestFailed(() => console.log("screen:", terminal.screen().slice(-1500)));
    try {
      await until(() => /invalid|unauthori[sz]ed|API key/i.test(terminal.screen()), 60_000, "Cursor to refuse the key");
    } finally {
      await terminal.close();
      for (const dir of plan.tmpDirs) rmSync(dir, { recursive: true, force: true });
    }
    expect(calledProbe("live-guest-bogus")).toBe(false);
  });

  it("instrumented: a message that lands while the stop hook holds starts a turn in the quiet TUI", async () => {
    // A stand-in for Barry's relay, which needs Barry's store: it holds at
    // `stop` and answers with whatever lands in the inbox file.
    const inbox = join(scratch, "inbox.txt");
    const holds = join(scratch, "holds.log");
    const relay = join(scratch, "relay.cjs");
    writeFileSync(relay, `const fs = require("node:fs");
let data = ""; process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", async () => {
  const p = JSON.parse(data || "{}");
  fs.appendFileSync(${JSON.stringify(holds)}, JSON.stringify({ event: p.hook_event_name, generation: p.generation_id, home: process.env.HOME }) + "\\n");
  for (const end = Date.now() + 60000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
    if (fs.existsSync(${JSON.stringify(inbox)})) {
      const message = fs.readFileSync(${JSON.stringify(inbox)}, "utf8"); fs.rmSync(${JSON.stringify(inbox)});
      console.log(JSON.stringify({ followup_message: message })); return;
    }
  }
  console.log("{}");
});
`);
    const config = { ...sessionConfig("live-instrumented"), options: { relayCommand: `'${process.execPath}' '${relay}'` } };
    const plan = await adapter.modes.instrumented!.plan(config);
    const terminal = await launch(plan);
    const held = () => (existsSync(holds) ? readFileSync(holds, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { generation: string; home: string }) : []);
    try {
      await terminal.submit("Reply with exactly: FIRST TURN DONE");
      await until(() => held().length === 1, 90_000, "the stop hook to hold");
      expect(held()[0].home).toBe(homedir());
      writeFileSync(inbox, "Reply with exactly: ANSWERED FROM THE INBOX");
      await until(() => held().length === 2, 90_000, "the inbox's turn to run and end");
      expect(held()[1].generation).not.toBe(held()[0].generation);
      expect(terminal.screen()).toContain("ANSWERED FROM THE INBOX");
    } finally {
      await terminal.close();
      for (const dir of plan.tmpDirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins the build: nothing new was installed while the sessions ran", () => {
    expect(readdirSync(VERSIONS)).toEqual(builds);
  });
});
