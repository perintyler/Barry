import { stableNodePath } from "@barry-rocks/sdk/services";
/**
 * `barry start` plans the launches recorded, for the inputs `start` actually
 * builds — recorded when they were shown equal to the old launchers' plans.
 *
 * The adapters' own goldens pin their plans; this pins the CLI's half — the
 * `SessionConfig` it builds from its launch inputs, and the one-shot it hands
 * to the server when the harness refuses it in guest mode. Cursor is left out
 * only because planning its launch runs the real cursor binary to reserve a
 * chat; its guest mode is pinned to the goldens through the same bridge.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import { codexHomesRoot } from "@barry-rocks/session-codex/runtime";
import { NotSupportedInMode } from "@barry-rocks/sdk/sessions";
import { harnessAdapter, resetAdapterStore } from "../adapters/installed.js";
import { shippedVendors } from "../../test/helpers/shipped-vendors.js";

const VENDORS = await shippedVendors();
import { buildSessionConfig, type BuildLaunchConfigInput } from "../sessions/launch.js";

const savedHome = process.env.BARRY_HOME;
const savedAllowEmpty = process.env.BARRY_CONFIG_ALLOW_EMPTY;
// Adapters resolve repository paths; normalize macOS temporary-directory aliases
// before inputs are built so the golden is shared with Linux.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "barry-start-parity-")));
process.env.BARRY_HOME = join(scratch, "home");
process.env.BARRY_CONFIG_ALLOW_EMPTY = "1";
const repoDir = join(scratch, "repo");
const skillsDir = join(scratch, "skills");

beforeAll(() => {
  // The store records the shipped adapters, and codex writes its home, under
  // BARRY_HOME — which must never be the developer's own.
  resetAdapterStore();
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(skillsDir, "greet"), { recursive: true });
  writeFileSync(join(skillsDir, "greet", "SKILL.md"), "---\nname: greet\ndescription: Say hello.\n---\nSay hello.\n");
});

afterAll(() => {
  if (savedAllowEmpty === undefined) delete process.env.BARRY_CONFIG_ALLOW_EMPTY;
  else process.env.BARRY_CONFIG_ALLOW_EMPTY = savedAllowEmpty;
  if (savedHome === undefined) delete process.env.BARRY_HOME;
  else process.env.BARRY_HOME = savedHome;
  resetAdapterStore();
  rmSync(scratch, { recursive: true, force: true });
});

const SERVERS = { barry: { type: "http", url: "http://127.0.0.1:4510/mcp?sessionId=s" } };

type Variant = Partial<BuildLaunchConfigInput>;

const COMMON: Record<string, Variant> = {
  default: {},
  "one-shot": { prompt: "do it" },
  "resume by id": { resume: { harnessSessionId: "prior-conversation" } },
  "resume last": { resume: { last: true } },
  "resume picker": { resume: { picker: true } },
  relax: { relax: true },
  "denied tools": { deniedTools: ["Bash", "Glob"] },
  "extra args": { extraArgs: ["--verbose"] },
  skills: { skillsDirs: [skillsDir] },
};

const SPECIFIC: Record<string, Record<string, Variant>> = {
  claude: {
    "own model": { model: "claude-opus-5" },
    "catalog-routed model": { model: "glm-5.2" },
    "routed to z.ai": { model: "glm-5.2", modelProvider: "zai" },
    "routed to ollama": { model: "qwen3:4b", modelProvider: "ollama", baseURL: "http://10.0.0.5:11434" },
    // Not in any curated model list, so only the explicit vendor can route it.
    "custom model routed to ollama": { model: "my-custom:7b", modelProvider: "ollama" },
  },
  codex: {
    "own model": { model: "gpt-5.5" },
    // No routed cases: codex's TUI launch passes the model through and routes
    // nothing, and `start` refuses codex with another vendor before this.
    "one-shot with resume": { prompt: "do it", resume: { last: true } },
  },
  opencode: {
    "own model": { model: "anthropic/claude-opus-5" },
    "one-shot with model": { prompt: "do it", model: "anthropic/claude-opus-5" },
  },
};

function inputFor(harness: string, name: string, variant: Variant): BuildLaunchConfigInput {
  const caseDir = join(scratch, "cases", `${harness}-${name.replace(/\W+/g, "-")}`);
  mkdirSync(caseDir, { recursive: true });
  const mcpConfigPath = join(caseDir, "mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: SERVERS }));
  return {
    sessionId: `parity-${harness}`,
    repoDir,
    childEnv: {
      PATH: "/usr/bin",
      BARRY_SESSION_ID: `parity-${harness}`,
      ...(harness === "codex" ? { CODEX_HOME: caseDir } : {}),
      ...(harness === "claude" ? { ANTHROPIC_API_KEY: "sk-ant-parity" } : {}),
      ...(harness === "codex" ? { OPENAI_API_KEY: "sk-parity" } : {}),
    },
    mcpConfigPath,
    settingsPath: join(caseDir, "settings.json"),
    systemPrompt: "Be brief.",
    extraArgs: [],
    deniedTools: [],
    skillsDirs: [],
    bagSkillDirs: [],
    slashCommandActions: [],
    tmpDirs: [],
    ...variant,
  };
}

/**
 * What a plan wrote that its argv only points at: codex routes a model by the
 * config.toml in its home, so two plans can match while their homes differ.
 */
function writtenHome(plan: { env: Record<string, string | undefined> }): Record<string, string> {
  const home = plan.env.CODEX_HOME;
  if (!home) return {};
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(home, path)] = readFileSync(path, "utf8");
    }
  };
  walk(home);
  return out;
}

/** Temp dirs and reserved conversation ids are made fresh by each build, the scratch dir by each run, and node is the machine's; name them instead. */
function normalized(plan: unknown, tmpDirs: string[], harnessSessionId?: string): unknown {
  let json = JSON.stringify(plan);
  // The node a gate runs on is whichever runs this test: another install or version is not another plan.
  json = json.split(stableNodePath()).join("<NODE>");
  json = json.split(process.execPath).join("<NODE>");
  if (harnessSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(harnessSessionId)) {
    json = json.split(harnessSessionId).join("<RESERVED_ID>");
  }
  tmpDirs.forEach((dir, index) => {
    json = json.split(dir).join(`<TMP_${index}>`);
  });
  json = json.split(scratch).join("<SCRATCH>");
  // The instance a run's session homes are kept in (opencode's), made fresh by each run.
  if (process.env.BARRY_HOME) json = json.split(process.env.BARRY_HOME).join("<BARRY_HOME>");
  // The session's CODEX_HOME follows the adapter's daemon-short root,
  // named by the instance id and a digest of the session id — both stable
  // here, but noise in a recorded plan. The digest stays visible.
  json = json.split(codexHomesRoot()).join("<CODEX_HOME>");
  return JSON.parse(json);
}

async function viaAdapter(harness: string, input: BuildLaunchConfigInput): Promise<unknown> {
  const tmpDirs: string[] = [];
  const adapter = await harnessAdapter(harness);
  const config = buildSessionConfig({ ...input, tmpDirs, harness: adapter, vendors: VENDORS, mcpServers: SERVERS });
  let plan: LaunchPlan;
  try {
    plan = await adapter.modes.guest!.plan(config);
  } catch (err) {
    // `start` hands this one-shot to the server, as the old launcher said to.
    if (err instanceof NotSupportedInMode && err.operation === "prompt" && input.prompt) {
      return { kind: "server", prompt: input.prompt };
    }
    // A launch the adapter refuses is recorded as the refusal it gives.
    return { refused: err instanceof Error ? err.message : String(err) };
  }
  const { harnessSessionId, guarantees: _guarantees, inbox: _inbox, discoverHarnessSessionId, ...rest } = plan;
  const recorded = normalized(
    {
      plan: {
        kind: "cli",
        ...rest,
        ...(harnessSessionId ? { harnessSessionId: harnessSessionId } : {}),
        ...(discoverHarnessSessionId ? { discoversConversation: true } : {}),
      },
      written: writtenHome(plan),
    },
    [...tmpDirs, ...plan.tmpDirs],
    harnessSessionId,
  );
  // The caller removes a plan's directories (LaunchPlan.tmpDirs); here, that is this test.
  for (const dir of plan.tmpDirs) rmSync(dir, { recursive: true, force: true });
  return recorded;
}

const { adapterStore } = await import("../adapters/installed.js");
const { adapters } = await adapterStore();
for (const harness of Object.keys(SPECIFIC)) {
  const { fileURLToPath } = await import("node:url");
  await adapters.add(fileURLToPath(new URL(`../../../adapters/sessions/${harness}/`, import.meta.url)));
}

const GUEST_HARNESSES = (
  await Promise.all(
    Object.keys(SPECIFIC).map(async (harness) => {
      const adapter = await harnessAdapter(harness);
      return adapter.modes.guest ? harness : null;
    }),
  )
).filter((h): h is string => Boolean(h));

describe.each(GUEST_HARNESSES)("barry start on %s", (harness) => {
  it("plans the launches recorded", async () => {
    const plans: Record<string, unknown> = {};
    for (const [name, variant] of Object.entries({ ...COMMON, ...SPECIFIC[harness] })) {
      plans[name] = await viaAdapter(harness, inputFor(harness, name, variant));
    }
    await expect(JSON.stringify(plans, null, 2) + "\n").toMatchFileSnapshot(`__golden__/start-launch-${harness}.json`);
  });
});

it("carries real bag grants and bounds through the CLI's TUI launch config", async () => {
  const { Barry } = await import("@barry-rocks/sdk");
  const { identities } = await import("@barry-rocks/identities-bag");
  const { resolveNativeTools } = await import("@barry-rocks/sdk/bounds");
  const { parseManifest } = await import("@barry-rocks/sdk/bags");
  const { adapters } = await adapterStore();
  await adapters.add(new URL("../../../adapters/sessions/pi/", import.meta.url).pathname);
  await adapters.add(new URL("../../../adapters/sessions/cursor/", import.meta.url).pathname);
  Barry.use(identities);
  try {
    const record = adapters.installed().find((item) => item.id === "claude-code")!;
    const adapter = await harnessAdapter("claude-code");
    const bash = parseManifest(new URL("../../../bags/bash/", import.meta.url).pathname)!;
    const noBashRaw = bash.bounds!["no-bash"] ?? bash.bounds!["bash:no-bash"];
    const noBashBound =
      noBashRaw && typeof noBashRaw === "object" && "bound" in noBashRaw && noBashRaw.bound
        ? noBashRaw.bound
        : noBashRaw;

    for (const [boundInputs, expected] of [
      [[{ tools: { deny: ["*:Bash", "*:Write", "*:Edit", "*:NotebookEdit", "*:WebFetch", "*:WebSearch"] } }], ["Read", "Glob", "Grep"]],
      [[{ tools: { deny: ["*:Bash", "*:Read", "*:Write", "*:Edit", "*:NotebookEdit", "*:Glob", "*:Grep"] }, network: { deny: ["all"] } }], []],
      [[{ tools: { deny: ["*:Read", "*:Write", "*:Edit", "*:NotebookEdit", "*:Glob", "*:Grep", "*:WebFetch", "*:WebSearch"] } }, noBashBound!], []],
    ] as const) {
      const bound = await Barry.bound(null, [...boundInputs]);
      const native = resolveNativeTools(bound, [], record, "guest");
      expect(native.allowed).toEqual(expected);
      const config = buildSessionConfig({
        ...inputFor("claude", "native-grants", {}),
        harness: adapter,
        vendors: VENDORS,
        mcpServers: SERVERS,
        allowedNativeTools: native.allowed,
        deniedTools: native.denied,
      });
      const plan = await adapter.modes.guest!.plan(config);
      try {
        expect(plan.args[plan.args.indexOf("--tools") + 1]).toBe(expected.join(","));
        expect(plan.args).toContain("Bash");
      } finally {
        for (const directory of plan.tmpDirs) rmSync(directory, { recursive: true, force: true });
      }
    }
    const cursor = adapters.installed().find((item) => item.id === "cursor")!;
    const cursorBound = await Barry.bound(null, [{ files: { deny: [".env"] } }]);
    expect(resolveNativeTools(cursorBound, [], cursor, "hosted").conflicts).toHaveProperty("Grep");
    const piTools = await Barry.tools(null, [], []);
    expect(piTools).toEqual([]);
  } finally {
    Barry.reset();
  }
});
