/**
 * The adapter's guarantees, checked against the real opencode binary.
 *
 * Opt-in — `BARRY_OPENCODE_LIVE=1` — because it needs the pinned build on
 * PATH. It spends nothing: the model and Barry's MCP server are a fake that
 * records what opencode sends (`probe-fixture.ts`), and the keys are fake.
 * Both modes are driven through `adapter.modes`, the entry points `barry
 * start` and the sessions API use, with Barry's tool ceiling applied.
 *
 *   BARRY_OPENCODE_LIVE=1 pnpm exec vitest run src/live
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { bagDataDir, writePrivateFile } from "@barry-rocks/sdk/services";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import type { EngineHandle, StartEngine } from "@barry-rocks/sdk/adapters/harnesses";
import type { PermissionRequest, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";
import { OPENCODE_REQUIREMENTS } from "../modes.js";
import { startProbe, type Probe } from "./probe-fixture.js";

const LIVE = process.env.BARRY_OPENCODE_LIVE === "1";
const IDENTITY_KEY = "identity-key";
const MODEL = "openrouter/openai/gpt-4o-mini";

describe.runIf(LIVE)("opencode, live", () => {
  let probe: Probe;
  let workspace: string;
  const savedHome = process.env.BARRY_HOME;
  const scratch: string[] = [];

  beforeAll(async () => {
    const version = execFileSync("opencode", ["--version"], { encoding: "utf8" });
    expect(version, "the opencode on PATH is not the build the guarantees were verified on").toContain(process.env.BARRY_OPENCODE_LIVE_VERSION ?? OPENCODE_REQUIREMENTS.binary.recommendedVersion);
    probe = await startProbe();
    // The sessions' opencode homes go under a throwaway instance.
    process.env.BARRY_HOME = made();
    workspace = made();
  });

  afterAll(async () => {
    await probe?.close();
    if (savedHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = savedHome;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function made(): string {
    const dir = mkdtempSync(join(tmpdir(), "oc-live-"));
    scratch.push(dir);
    return dir;
  }

  /** A session as Barry starts one: an identity holding an OpenRouter key, and Barry's MCP server. */
  function sessionConfig(sessionId: string): SessionConfig {
    const keep = ["PATH", "HOME", "USER", "TERM", "TMPDIR", "LANG", "SHELL"];
    const env: Record<string, string> = Object.fromEntries(keep.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
    return {
      sessionId,
      cwd: workspace,
      env: { ...env, TERM: env.TERM ?? "xterm-256color", OPENROUTER_API_KEY: IDENTITY_KEY },
      model: MODEL,
      mcpServers: { barry: { type: "http", url: `${probe.url}/mcp` } },
    };
  }

  /** The planned config, with OpenRouter pointed at the fake model. Nothing else changes. */
  function onProbe(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const configPath = env.OPENCODE_CONFIG;
    if (!configPath) throw new Error("live launch has no private config path");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const defined = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    writePrivateFile(configPath, JSON.stringify({ ...config, provider: { openrouter: { options: { baseURL: `${probe.url}/v1` } } } }));
    return defined;
  }


  /** Starts a real `opencode serve` for a hosted session, as the sessions bag does, on the fake model. */
  function engineStarter() {
    const engines = new Set<ChildProcess>();
    const versions: string[] = [];
    const startEngine: StartEngine = async (spec) => {
      const address = `127.0.0.1:${await freePort()}`;
      const password = randomUUID();
      const command = spec.command(address);
      const child = spawn(command.command, [...command.args], {
        cwd: spec.cwd,
        env: { ...onProbe(command.env), [spec.passwordEnvVar ?? "OPENCODE_SERVER_PASSWORD"]: password },
        stdio: "ignore",
      });
      engines.add(child);
      const handle: EngineHandle = {
        sessionId: spec.sessionId,
        address,
        password,
        recordVersion: async (version) => void versions.push(version),
        stop: async () => {
          if (child.exitCode === null) {
            child.kill("SIGTERM");
            await once(child, "exit");
          }
          engines.delete(child);
        },
      };
      return handle;
    };
    return { startEngine, engines, versions };
  }

  /** Where a session's opencode home lives in this run's instance (`openCodeHome`). */
  function homeOf(sessionId: string): string {
    return join(bagDataDir("opencode", { create: false }), "sessions", createHash("sha256").update(sessionId).digest("hex").slice(0, 16));
  }

  it("guest: the TUI reaches Barry with its own session only, on Barry's tools and the identity's key, and leaves nothing running", async () => {
    const guest = adapter.modes.guest;
    if (!guest) throw new Error("opencode declares no guest mode");
    onTestFailed(() => console.log("probe saw:", JSON.stringify({ mcp: probe.mcp, chats: probe.chats.map((chat) => ({ at: chat.at, auth: chat.auth, tools: chat.tools })) }, null, 1)));
    const plan = await guest.plan(sessionConfig("live-guest"));
    scratch.push(...plan.tmpDirs);
    const env = onProbe(plan.env);
    const before = openCodeProcesses();

    // E6 as it would meet a guest: a background service already registered
    // where this TUI would look for one, holding another session's config.
    const intruderConfig = JSON.parse(readFileSync(env.OPENCODE_CONFIG, "utf8")) as Record<string, unknown>;
    const intruderConfigPath = join(made(), "opencode.json");
    writePrivateFile(intruderConfigPath, JSON.stringify({ ...intruderConfig, mcp: { servers: { barry: { type: "remote", url: `${probe.url}/mcp?sessionId=intruder`, codemode: false } } } }));
    const intruder = { ...process.env, ...env, OPENCODE_CONFIG: intruderConfigPath };
    // On a port of its own: the background service's default is one fixed
    // port, and the user's own service may already hold it.
    execFileSync("opencode", ["service", "set", "port", String(await freePort())], { env: intruder, cwd: workspace, stdio: "ignore", timeout: 30_000 });
    execFileSync("opencode", ["api", "GET", "/api/info"], { env: intruder, cwd: workspace, stdio: "ignore", timeout: 30_000 });

    probe.script([{ call: "barry_probe_tool", delayMs: 500 }, { text: "done" }]);
    let tui: ChildProcess | undefined;
    try {
      // Under a pty, as a person runs it, typing into it. Python's `pty.spawn`
      // rather than `script`, which refuses a socket for stdin — and a child's
      // piped stdin is one.
      tui = spawn("python3", ["-c", "import pty, sys; pty.spawn(sys.argv[1:])", plan.command, ...plan.args], { env, cwd: plan.cwd, stdio: ["pipe", "ignore", "ignore"] });
      await until(() => probe.mcp.some((request) => request.sessionId === "live-guest" && request.method === "tools/list"), 30_000);
      // A person types after the TUI has drawn; by then its tools are listed.
      await sleep(1500);
      tui.stdin?.write("go\r");
      await until(() => probe.chats.length >= 2, 60_000);
    } finally {
      if (tui && tui.exitCode === null) {
        tui.kill("SIGTERM");
        await Promise.race([once(tui, "exit"), sleep(10_000)]);
      }
      execFileSync("opencode", ["service", "stop"], { env: intruder, stdio: "ignore", timeout: 30_000 });
    }

    // The call reached Barry's MCP server as this session, not the service's.
    expect(probe.mcp.filter((request) => request.method === "tools/call").map((request) => request.sessionId)).toEqual(["live-guest"]);
    expect(probe.chats[0]?.tools).toEqual(["barry_probe_tool"]);
    expect(probe.chats.every((chat) => chat.auth === IDENTITY_KEY)).toBe(true);
    expect(JSON.stringify(probe.chats[1]?.messages)).toContain("probe-tool-ran");
    await until(() => openCodeProcesses().every((pid) => before.includes(pid)), 10_000);
  }, 90_000);

  it("hosted: Barry rules on each call of its tools, which are there from the first turn; a turn can be steered and interrupted", async () => {
    const hosted = adapter.modes.hosted;
    if (!hosted) throw new Error("opencode declares no hosted mode");
    const { startEngine, engines, versions } = engineStarter();

    const asked: PermissionRequest[] = [];
    const session = await hosted.start(
      { ...sessionConfig("live-hosted"), decide: async (request) => (asked.push(request), { allow: true }) },
      startEngine,
    );
    const events: SessionEvent[] = [];
    onTestFailed(() => console.log("probe saw:", JSON.stringify({ mcp: probe.mcp, chats: probe.chats.map((chat) => ({ at: chat.at, auth: chat.auth, tools: chat.tools })), events }, null, 1)));
    void (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    const dones = () => events.filter((event) => event.type === "done").length;

    try {
      // A call of Barry's tool, on the first turn: put to Barry, then run.
      probe.script([{ call: "barry_probe_tool", delayMs: 300 }, { text: "done" }]);
      await session.deliver("go");
      await until(() => dones() === 1, 60_000);
      expect(asked.map((request) => request.tool)).toEqual(["mcp__barry__probe_tool"]);
      expect(probe.chats[0]?.tools).toEqual(["barry_probe_tool"]);
      expect(probe.chats.every((chat) => chat.auth === IDENTITY_KEY)).toBe(true);
      expect(probe.mcp.filter((request) => request.method === "tools/call").map((request) => request.sessionId)).toEqual(["live-hosted"]);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", result: expect.stringContaining("probe-tool-ran") }));
      expect(versions).toContain(process.env.BARRY_OPENCODE_LIVE_VERSION ?? OPENCODE_REQUIREMENTS.binary.recommendedVersion);

      // A message delivered mid-turn with steer joins the running turn.
      probe.script([{ text: "first", delayMs: 3000 }, { text: "after-steer" }]);
      await session.deliver("one");
      await until(() => probe.chats.length === 1, 30_000);
      expect((await session.deliver("two", { ifActive: "steer" })).status).toBe("steered");
      await until(() => dones() === 2, 60_000);
      expect(probe.chats.some((chat) => JSON.stringify(chat.messages).includes("two"))).toBe(true);

      // An interrupt ends the running turn, and only the turn.
      probe.script([{ text: "never", delayMs: 60_000 }]);
      await session.deliver("wait");
      await until(() => probe.chats.length === 1, 30_000);
      await session.interrupt();
      await until(() => dones() === 3, 15_000);
      expect(session.status()).toBe("idle");
    } finally {
      await session.close();
    }
    expect(engines.size).toBe(0);
    // It had a conversation, which `barry resume` can come back to.
    expect(existsSync(homeOf("live-hosted"))).toBe(true);
  }, 90_000);

  // BARRY_OPENCODE_LIVE=1: installed opencode, scratch XDG and local endpoint.
  it("native grants allow file reads and refuse shell", async () => {
    const file = join(workspace, "fixture.txt"), sentinel = join(workspace, "sentinel");
    writeFileSync(file, "GRANTED_NATIVE_READ");
    const { startEngine } = engineStarter();
    const session = await adapter.modes.hosted!.start({ ...sessionConfig("native-reads"), allowedNativeTools: ["read", "grep", "glob"], decide: async () => ({ allow: true }) }, startEngine);
    const events: SessionEvent[] = [];
    let done = 0;
    const collecting = (async () => { for await (const event of session.events()) { events.push(event); if (event.type === "done") done++; } })();
    try {
      probe.script([{ call: "read", args: { path: file } }, { text: "read done" }]);
      await session.deliver("Read the fixture");
      await until(() => done === 1, 60000);
      expect(JSON.stringify(events)).toContain("GRANTED_NATIVE_READ");
      expect(probe.chats[0].tools).toContain("read");
      expect(probe.chats[0].tools).not.toContain("shell");
      probe.script([{ call: "shell", args: { command: `touch ${sentinel}`, description: "Probe" } }, { text: "refused done" }]);
      await session.deliver("Force denied shell");
      await until(() => done === 2, 60000);
      expect(JSON.stringify(events)).toContain("currently available");
      expect(existsSync(sentinel)).toBe(false);
    } finally { await session.close(); await collecting; }
  }, 90000);

  it("hosted: a session closed before anything was said leaves no home behind", async () => {
    const hosted = adapter.modes.hosted;
    if (!hosted) throw new Error("opencode declares no hosted mode");
    const { startEngine, engines } = engineStarter();
    const session = await hosted.start(sessionConfig("live-hosted-unused"), startEngine);
    expect(existsSync(homeOf("live-hosted-unused"))).toBe(true);

    await session.close();

    expect(engines.size).toBe(0);
    expect(existsSync(homeOf("live-hosted-unused"))).toBe(false);
  });
});

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The pids of every opencode process on the machine. */
function openCodeProcesses(): string[] {
  const listing = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return listing
    .split("\n")
    .filter((line) => /\bopencode(\.exe)?\b/.test(line) && !line.includes("vitest"))
    .map((line) => line.trim().split(/\s+/)[0] ?? "");
}
