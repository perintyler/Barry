import { stableNodePath } from "@barry-rocks/sdk/services";
/**
 * Each shipped adapter's guest mode plans exactly the launches recorded in
 * `__golden__/launch-*.json` — recorded from the launchers these replaced, so
 * what a user runs with `barry start` did not change when they did.
 *
 * Each recorded case is rebuilt as the `SessionConfig` a new caller passes:
 * a model is a `vendor/model` ref, a resume names the harness's own session
 * id, and harness settings ride in `options` — the `-p` one-shot among them,
 * until a hosted session can carry what that launch gives the agent. A
 * harness whose one-shot was recorded as a server launch (codex) refuses it
 * in guest mode instead. `asRecorded` maps the renamed plan fields back in
 * one place.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedVendors } from "../helpers/shipped-vendors.js";
import { codexHomesRoot } from "@barry-rocks/session-codex/runtime";

const VENDORS = await shippedVendors();
import type { Adapter, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import { routedEndpoint } from "@barry-rocks/sdk/adapters/models";

import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";

vi.mock("@barry-rocks/session-cursor/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/session-cursor/runtime")>()),
  resolveCursorAgent: () => ({ command: process.env.GOLDEN_FAKE_CURSOR_BIN ?? "cursor-bin-not-set", pinned: true }),
}));

const ADAPTERS: Record<string, Adapter> = {
  claude: (await import("@barry-rocks/session-claude")).default,
  codex: (await import("@barry-rocks/session-codex")).default,
  cursor: (await import("@barry-rocks/session-cursor")).default,
  opencode: (await import("@barry-rocks/session-opencode")).default,
};

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__golden__");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";

let scratch: string;
let repoDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "barry-launch-parity-")));
  for (const key of ["BARRY_HOME", "BARRY_OLLAMA_URL", "GOLDEN_FAKE_CURSOR_BIN"]) {
    saved[key] = process.env[key];
  }
  process.env.BARRY_HOME = join(scratch, "barry-home");
  delete process.env.BARRY_OLLAMA_URL;
  repoDir = join(scratch, "repo");
  mkdirSync(repoDir, { recursive: true });
  const fakeCursor = join(scratch, "bin", "cursor");
  writeFileRecursive(
    fakeCursor,
    [
      "#!/bin/sh",
      'if [ "$GOLDEN_CURSOR_CHAT" = "none" ]; then exit 0; fi',
      `for arg in "$@"; do if [ "$arg" = "create-chat" ]; then echo ${CHAT_ID}; fi; done`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeCursor, 0o755);
  process.env.GOLDEN_FAKE_CURSOR_BIN = fakeCursor;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

function writeFileRecursive(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const MCP_SERVERS: SessionConfig["mcpServers"] = {
  barry: { type: "http", url: "http://127.0.0.1:4510/mcp?sessionId=golden", headers: { Authorization: "Bearer golden-token" } },
  local: { command: "node", args: ["server.js"], env: { LOCAL_FLAG: "1" } },
};

interface Case {
  name: string;
  config?: Partial<SessionConfig>;
  mcpServers?: SessionConfig["mcpServers"];
  /** The caller passes a settings file of its own, as `barry start` does. */
  callerSettings?: true;
}

const COMMON: Case[] = [
  { name: "default" },
  { name: "resume-by-id", config: { resume: { harnessSessionId: "prior-conversation" } } },
  { name: "resume-last", config: { resume: { last: true } } },
  { name: "resume-picker", config: { resume: { picker: true } } },
  { name: "denied-tools", config: { deniedTools: ["Bash", "Glob", "WebFetch"] } },
  { name: "plugins-and-roots", config: { pluginDirs: ["/plugins/skills"], projectRoots: ["/extra/root"] } },
  { name: "relax", config: { strictMcpConfig: false } },
  { name: "system-prompt", config: { systemPrompt: "Be brief." } },
  { name: "extra-args", config: { extraArgs: ["--verbose"] } },
  { name: "no-mcp-servers", mcpServers: {} },
  { name: "prompt", config: { options: { prompt: "do it" } } },
];

const SPECIFIC: Record<string, Case[]> = {
  claude: [
    { name: "own-model", config: { model: "anthropic/claude-opus-5" } },
    { name: "zai-without-key", config: { model: "zai/glm-5.2" } },
    { name: "zai-with-key", config: { model: "zai/glm-5.2", env: { PATH: "/usr/bin", Z_AI_API_KEY: "zk-golden" } } },
    { name: "ollama-catalog-model", config: { model: "ollama/qwen3:4b" } },
    { name: "ollama-custom-model", config: { model: "ollama/my-custom:7b" } },
    { name: "ollama-base-url", config: { model: "ollama/qwen3:4b", endpoint: { baseUrl: "http://10.0.0.5:11434" } } },
    { name: "settings", callerSettings: true },
    { name: "telemetry", config: { telemetryEndpoint: "http://127.0.0.1:4318" } },
  ],
  codex: [
    { name: "own-model", config: { model: "openai/gpt-5.5" } },
    { name: "openai-key", config: { env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-golden" } } },
    { name: "prompt-with-resume", config: { options: { prompt: "do it" }, resume: { last: true } } },
  ],
  cursor: [
    { name: "own-model", config: { model: "cursor/claude-opus-5-high" } },
    // Through the session's env: create-chat runs with nothing else.
    { name: "no-chat-id", config: { env: { GOLDEN_CURSOR_CHAT: "none" } } },
  ],
  opencode: [
    { name: "own-model", config: { model: "anthropic/claude-opus-5" } },
    { name: "prompt-with-model", config: { options: { prompt: "do it" }, model: "anthropic/claude-opus-5" } },
  ],
};

function normalize(value: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, replacements)]));
  }
  return value;
}

function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** The new plan in the recorded shape: `harnessSessionId` was `providerSessionId`, and guarantees are new. */
function asRecorded(plan: LaunchPlan): Record<string, unknown> {
  const { harnessSessionId, guarantees: _guarantees, inbox: _inbox, discoverHarnessSessionId, ...rest } = plan;
  return {
    kind: "cli",
    ...rest,
    ...(harnessSessionId ? { providerSessionId: harnessSessionId } : {}),
    ...(discoverHarnessSessionId ? { discoversConversation: true } : {}),
  };
}

async function planFor(id: string, c: Case, index: number): Promise<unknown> {
  const caseDir = join(scratch, "cases", `${id}-${index}`);
  const mcpConfigPath = join(caseDir, "mcp.json");
  const mcpServers = c.mcpServers ?? MCP_SERVERS;
  writeFileRecursive(mcpConfigPath, JSON.stringify({ mcpServers }));
  const userCodexHome = join(caseDir, "user-codex-home");
  writeFileRecursive(join(userCodexHome, ".keep"), "");

  const baseEnv: Record<string, string> = {
    PATH: "/usr/bin",
    BARRY_SESSION_ID: `golden-${id}-${c.name}`,
    ...(id === "codex" ? { CODEX_HOME: userCodexHome } : {}),
    ...(id === "claude" ? { ANTHROPIC_API_KEY: "sk-ant-golden" } : {}),
    ...(id === "codex" ? { OPENAI_API_KEY: "sk-golden" } : {}),
    ...(id === "cursor" ? { CURSOR_API_KEY: "crsr-golden" } : {}),
  };
  const given: SessionConfig = {
    sessionId: `golden-${id}-${c.name}`,
    cwd: repoDir,
    mcpServers,
    ...c.config,
    env: { ...baseEnv, ...(c.config?.env ?? {}) },
    options: { mcpConfigPath, ...(c.config?.options as object | undefined), ...(c.callerSettings ? { settingsPath: join(caseDir, "settings.json") } : {}) },
  };
  // The routed endpoint and key a composition root resolves for the model, as
  // `barry start` does: an adapter is handed them, never asked to look them up.
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`no adapter ${id}`);
  const endpoint = routedEndpoint(adapter, given.model, VENDORS, given.env, given.endpoint?.baseUrl ? { baseUrl: given.endpoint.baseUrl } : {});
  const { endpoint: _override, ...rest } = given;
  const config: SessionConfig = { ...rest, ...(endpoint ? { endpoint } : {}) };

  const guest = adapter.modes.guest;
  if (!guest) throw new Error(`${id} has no guest mode`);
  let plan: LaunchPlan;
  try {
    plan = await guest.plan(config);
  } catch (err) {
    // What the old launcher recorded for a one-shot it hands to the server.
    if (err instanceof NotSupportedInMode && err.operation === "prompt") {
      return { case: c.name, plan: { kind: "server", prompt: (config.options as { prompt: string }).prompt }, written: {} };
    }
    // A launch the adapter refuses is recorded as the refusal it gives.
    return { case: c.name, refused: err instanceof Error ? err.message : String(err) };
  }

  const written: Record<string, Record<string, string>> = {};
  for (const dir of plan.tmpDirs) written["<TMP_DIR>"] = filesUnder(dir);
  if (id === "codex" && plan.env.CODEX_HOME) written["<CODEX_HOME>"] = filesUnder(plan.env.CODEX_HOME);
  if (id === "cursor" && plan.env.HOME) written["<CURSOR_HOME>"] = filesUnder(plan.env.HOME);

  const replacements: Array<[string, string]> = [
    // The node a gate runs on is whichever runs this test, and may live under the user's home.
    [stableNodePath(), "<NODE>"],
    [process.execPath, "<NODE>"],
    ...plan.tmpDirs.map((d): [string, string] => [d, "<TMP_DIR>"]),
    // A conversation id the adapter reserved is fresh each run.
    ...(plan.harnessSessionId && UUID.test(plan.harnessSessionId) ? [[plan.harnessSessionId, "<RESERVED_ID>"] as [string, string]] : []),
    [process.env.GOLDEN_FAKE_CURSOR_BIN ?? "", "<CURSOR_BIN>"],
    [mcpConfigPath, "<MCP_CONFIG>"],
    [userCodexHome, "<USER_CODEX_HOME>"],
    // The session's CODEX_HOME follows the adapter's daemon-short root,
    // named by the instance id and a digest of the session id — both stable
    // here, but noise in a recorded plan. The digest stays visible.
    [codexHomesRoot(), "<CODEX_HOME>"],
    [repoDir, "<REPO>"],
    [process.env.BARRY_HOME ?? "", "<BARRY_HOME>"],
    [scratch, "<SCRATCH>"],
    // Cursor's stdio servers keep the user's own home.
    [homedir(), "<USER_HOME>"],
  ];
  const recorded = normalize({ case: c.name, plan: asRecorded(plan), written }, replacements);
  // The caller removes a plan's directories (LaunchPlan.tmpDirs); here, that is this test.
  for (const dir of plan.tmpDirs) rmSync(dir, { recursive: true, force: true });
  return recorded;
}

const GUEST_ADAPTERS = Object.keys(ADAPTERS).filter((id) => Boolean(ADAPTERS[id]?.modes.guest));

describe.each(GUEST_ADAPTERS)("%s guest mode", (id) => {
  const recorded = JSON.parse(readFileSync(join(GOLDEN, `launch-${id}.json`), "utf8")) as Array<{ case: string }>;
  const cases = [...COMMON, ...(SPECIFIC[id] ?? [])];

  // GOLDEN_UPDATE=<adapter id> re-records that adapter's file instead of checking it.
  const updating = process.env.GOLDEN_UPDATE === id;
  it.runIf(updating)("re-records the golden file", async () => {
    const plans = [];
    for (const [index, c] of cases.entries()) plans.push(await planFor(id, c, index));
    writeFileSync(join(GOLDEN, `launch-${id}.json`), `${JSON.stringify(plans, null, 2)}\n`);
  });
  if (updating) return;

  it("covers every recorded case", () => {
    const covered = new Set(cases.map((c) => c.name));
    expect(recorded.map((r) => r.case).filter((name) => !covered.has(name))).toEqual([]);
  });

  it.each(cases.map((c, index) => [c.name, c, index] as const))("plans %s as recorded", async (_name, c, index) => {
    expect(await planFor(id, c, index)).toEqual(recorded.find((r) => r.case === c.name));
  });
});
