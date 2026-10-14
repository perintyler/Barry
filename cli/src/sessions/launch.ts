import { configureSession } from "@barry-rocks/sdk/sessions";
/**
 * Running what an agent's `planLaunch` describes.
 *
 * The adapters know each vendor's argv, env and quirks; this file knows how to
 * spawn a child and clean up after it. Everything here talks to Barry's API,
 * its database, or the terminal — which is exactly why it did not move into
 * `agent-runtime`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildActionCommandsDir, buildSkillsPlugin } from "@barry-rocks/sdk/internal/actions";
import { modelRef, parseModelRef, type HarnessId, type ModelRef, type VendorId } from "@barry-rocks/sdk/ids";
import { routedEndpoint, type RoutingHarness } from "@barry-rocks/sdk/adapters/models";
import type { Vendor } from "@barry-rocks/sdk/adapters/models";
import type { LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { RendererAttachmentSchema, type RendererAttachment } from "@barry-rocks/sdk/internal/sessions";
interface McpConfig { mcpServers: Record<string, { disabled?: boolean; type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }> }


/** Compose repository instructions before the replacing system prompt so the session retains its repository guidance. */
export function composeSystemPrompt(
  repoDir: string,
  instructionPrompt: string,
  directive: string | null,
): string {
  const agentsMdPath = join(repoDir, "AGENTS.md");
  let prompt = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf-8") : "";

  if (instructionPrompt) {
    prompt += `${prompt ? "\n\n" : ""}${instructionPrompt}`;
  }
  if (directive) {
    prompt += `\n\n## Directive\n${directive}`;
  }
  return prompt;
}

export interface BuildLaunchConfigInput {
  sessionId: string;
  repoDir: string;
  childEnv: Record<string, string | undefined>;
  mcpConfigPath: string;
  settingsPath: string;
  systemPrompt: string;
  model?: string;
  modelProvider?: string;
  baseURL?: string;
  prompt?: string;
  extraArgs: string[];
  relax?: boolean;
  deniedTools: string[];
  allowedNativeTools?: string[];
  skillsDirs: string[];
  traitSkillDirs: string[];
  slashCommandActions: Parameters<typeof buildActionCommandsDir>[0];
  resume?: ResumeRequest;
  /** Directories created here are appended so the caller can clean them up. */
  tmpDirs: string[];
}

/**
 * Materialize what the adapters cannot build themselves.
 *
 * Skills and actions are bag concepts, and adapters deliberately have no bags
 * dependency, so they are turned into plain directories here. The adapter only
 * learns "a plugin directory" and "a project root" — which is why neither word
 * appears in its interface.
 */
function materializeBagDirs(input: BuildLaunchConfigInput): { pluginDirs: string[]; projectRoots: string[] } {
  const pluginDirs: string[] = [];
  const projectRoots: string[] = [];

  const skillsPluginDir = buildSkillsPlugin(input.skillsDirs, input.traitSkillDirs);
  if (skillsPluginDir) {
    input.tmpDirs.push(skillsPluginDir);
    pluginDirs.push(skillsPluginDir);
  }

  // Slash commands ride in as an added root rather than inside the plugin:
  // plugin commands get namespaced (`/barry:wrap-up`), while a root's
  // `.claude/commands/` keeps the bare name these actions had as skills.
  const commandsDir = buildActionCommandsDir(input.slashCommandActions);
  if (commandsDir) {
    input.tmpDirs.push(commandsDir);
    projectRoots.push(commandsDir);
  }
  return { pluginDirs, projectRoots };
}

export interface BuildSessionConfigInput extends BuildLaunchConfigInput {
  /**
   * The harness this launch runs on: its id, its own vendor — a model named
   * without one is that vendor's — and whether Barry can point it elsewhere.
   */
  harness: RoutingHarness;
  /** Every vendor, for a model another vendor serves. */
  vendors: readonly Vendor[];
  mcpServers: McpConfig["mcpServers"];
  /** Barry's OTLP receiver and the auth it takes, for a launch that reports to it. */
  telemetry?: { endpoint: string; headers: Record<string, string> };
  /** How the launched TUI's hooks reach Barry: `barry hook <vendor>`, as this CLI runs it. */
  relayCommand?: string;
}

/**
 * The same launch as the `SessionConfig` a harness adapter's modes take.
 *
 * What only a launch has — the mcp.json already written, the merged settings
 * file, and the `-p` one-shot — rides in `options`, which the adapter reads.
 */
export function buildSessionConfig(input: BuildSessionConfigInput): SessionConfig {
  const { pluginDirs, projectRoots } = materializeBagDirs(input);
  const model = input.model ? sessionModelRef(input.harness.id, input.model, input.modelProvider ?? input.harness.vendor) : undefined;
  // Resolved here, where the identity's keys are: the harness is handed the
  // address and key, never asked to look them up.
  const endpoint = routedEndpoint(input.harness, model, input.vendors, input.childEnv, input.baseURL ? { baseUrl: input.baseURL } : {});
  const resume = input.resume;
  return configureSession({
    sessionId: input.sessionId,
    cwd: input.repoDir,
    env: input.childEnv,
    mcpServers: sessionServers(input.mcpServers),
    ...(model ? { model } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    allowedNativeTools: input.allowedNativeTools ?? [],
    ...(input.deniedTools.length ? { deniedTools: input.deniedTools } : {}),
    ...(pluginDirs.length ? { pluginDirs } : {}),
    ...(projectRoots.length ? { projectRoots } : {}),
    extraArgs: input.extraArgs,
    strictMcpConfig: !input.relax,
    ...(input.telemetry ? { telemetryEndpoint: input.telemetry.endpoint, telemetryHeaders: input.telemetry.headers } : {}),
    ...(resume
      ? {
          resume: {
            ...(resume.providerSessionId ? { harnessSessionId: resume.providerSessionId } : {}),
            ...(resume.last ? { last: true } : {}),
            ...(resume.picker ? { picker: true } : {}),
          },
        }
      : {}),
    options: {
      mcpConfigPath: input.mcpConfigPath,
      settingsPath: input.settingsPath,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.relayCommand ? { relayCommand: input.relayCommand } : {}),
    },
  });
}

/**
 * The CLI's server entries in the session's shape. A disabled entry, and one
 * naming neither a command nor a URL, reaches no harness.
 */
function sessionServers(servers: McpConfig["mcpServers"]): SessionConfig["mcpServers"] {
  const out: SessionConfig["mcpServers"] = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.disabled) continue;
    if (server.url) {
      out[name] = { type: server.type === "sse" ? "sse" : "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
    } else if (server.command) {
      out[name] = { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: server.env } : {}) };
    }
  }
  return out;
}

/**
 * A model as `-m`, `--model` and the identity name it — an id, plus the vendor serving it
 * when that is not the harness's own — as a ref. A harness with no vendor
 * (opencode) connects itself and names models `vendor/model` already, so a
 * bare id there names nothing and is refused rather than passed on.
 */
export function sessionModelRef(harness: HarnessId, model: string, vendor: VendorId | undefined): ModelRef {
  if (vendor) return modelRef(vendor, model);
  const parsed = parseModelRef(model);
  if (!parsed) throw new Error(`${harness} names models vendor/model; "${model}" names no vendor`);
  return modelRef(parsed.vendor, parsed.model);
}

export interface ServerTurn {
  harness: string;
  model?: string;
  modelProvider?: string;
  prompt: string;
  repoPath: string;
}

/**
 * Start a one-shot turn on the API server, for a session the CLI created.
 *
 * The server starts a session on the harness and model its row names, so
 * those are recorded first and the message carries only the message: its
 * schema is strict, and naming the harness there failed every such run with
 * "Unrecognized key". Resolves to what to tell the user, or null once the
 * turn has started.
 */
export async function startServerTurn(
  sessionId: string,
  turn: ServerTurn,
  api: SessionApi,
): Promise<string | null> {
  const request = api.fetch ?? fetch;
  const recorded = await recordHarness(sessionId, turn, api);
  if (!recorded.ok) return await problemOf(recorded);
  const sent = await request(`${api.base}/sessions/${sessionId}/message`, {
    method: "POST",
    headers: api.headers,
    body: JSON.stringify({ content: turn.prompt, repoPath: turn.repoPath }),
  });
  return sent.ok ? null : await problemOf(sent);
}

export interface SessionApi {
  base: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}

/** The harness and model a session runs on, as the server starts it. */
export type SessionHarness = Pick<ServerTurn, "harness" | "model" | "modelProvider">;

/**
 * Open the session's hosted harness to a TUI this process launches: record
 * the harness and model it runs on, then attach, held for as long as this
 * process runs. Throws what to tell the user when refused.
 */
export async function attachToHostedSession(sessionId: string, harness: SessionHarness, api: SessionApi): Promise<RendererAttachment> {
  const recorded = await recordHarness(sessionId, harness, api);
  if (!recorded.ok) throw new Error(await problemOf(recorded));
  const attached = await (api.fetch ?? fetch)(`${api.base}/sessions/${sessionId}/attach`, {
    method: "POST",
    headers: api.headers,
    body: JSON.stringify({ launcherPid: process.pid }),
  });
  if (!attached.ok) throw new Error(await problemOf(attached));
  return RendererAttachmentSchema.parse(await attached.json());
}

/** End an attachment. Best-effort: one left behind is freed once this process exits. */
export async function detachFromHostedSession(sessionId: string, attachmentId: string, api: SessionApi): Promise<void> {
  await (api.fetch ?? fetch)(`${api.base}/sessions/${sessionId}/detach`, {
    method: "POST",
    headers: api.headers,
    body: JSON.stringify({ attachmentId }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
}

/**
 * Ends a TUI's attachment however the TUI goes — it exits, it never starts,
 * or this process is told to stop — then hands `leave` the exit code, once.
 */
export function detachWhenGone(
  child: Pick<ChildProcess, "on" | "kill">,
  detach: () => Promise<void>,
  leave: (code: number) => void,
  signals: Pick<NodeJS.EventEmitter, "on"> = process,
): void {
  let leaving = false;
  const go = async (code: number) => {
    if (leaving) return;
    leaving = true;
    await detach();
    leave(code);
  };
  child.on("error", () => void go(1));
  child.on("close", (code: number | null) => void go(code ?? 0));
  const onSignal = () => {
    try { child.kill(); } catch { /* child may already be gone */ }
    void go(0);
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
}

function recordHarness(sessionId: string, harness: SessionHarness, api: SessionApi): Promise<Response> {
  return (api.fetch ?? fetch)(`${api.base}/sessions/${sessionId}`, {
    method: "PATCH",
    headers: api.headers,
    body: JSON.stringify({
      provider: harness.harness,
      ...(harness.model ? { model: harness.model } : {}),
      ...(harness.modelProvider ? { modelProvider: harness.modelProvider } : {}),
    }),
  });
}

async function problemOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { detail?: string };
  return body.detail ?? (response.statusText || `HTTP ${response.status}`);
}

export interface RunChildOptions {
  /** Called after the child closes, before temp dirs are removed. */
  onClose?: () => void | Promise<void>;
  /** Wires pid reporting, signals, cleanup and the exit code. */
  attach: (child: ReturnType<typeof spawn>, onClose?: () => void | Promise<void>) => void;
  /** Prints a warning line. Injected so this module never assumes a terminal. */
  warn?: (message: string) => void;
}

/**
 * Spawn the child an adapter described.
 *
 * One spawn site for every provider, which is what keeps the pid recorded
 * exactly once and the signal handling identical everywhere.
 */
export function runChildSession(plan: LaunchPlan, options: RunChildOptions): void {
  const warn = options.warn ?? ((m: string) => console.warn(`Warning: ${m}`));
  for (const warning of plan.warnings) {
    warn(warning);
  }

  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: plan.env,
    ...(plan.cwd ? { cwd: plan.cwd } : {}),
  });

  options.attach(child, options.onClose);
}

/**
 * Asks a launch for its conversation id until it has one, then records it,
 * for a harness that picks its own id. `stop` asks one last time.
 */
export function discoverConversation(
  discover: () => Promise<string | undefined>,
  record: (harnessSessionId: string) => Promise<void>,
  intervalMs = 3_000,
): { stop(): Promise<void> } {
  let recorded = false;
  let attempt: Promise<void> | null = null;
  const tryOnce = (): Promise<void> => {
    attempt ??= (async () => {
      const harnessSessionId = await discover().catch(() => undefined);
      if (harnessSessionId && !recorded) {
        recorded = true;
        await record(harnessSessionId);
      }
    })().finally(() => {
      attempt = null;
    });
    return attempt;
  };
  const timer = setInterval(() => {
    if (!recorded) void tryOnce();
  }, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await attempt;
      if (!recorded) await tryOnce();
    },
  };
}

/** Agents whose one-shot runs go to the API server rather than a child. */
export function usesServerForPrompt(
  launcher: { promptExecution: "cli" | "server" },
  prompt: string | undefined,
): boolean {
  return Boolean(prompt) && launcher.promptExecution === "server";
}

/** Which conversation a launch continues: one by the harness's id, the latest, or the harness's own picker. */
export interface ResumeRequest {
  providerSessionId?: string;
  last?: boolean;
  picker?: boolean;
}

/**
 * A command that runs this same CLI — the build that launched the TUI, not
 * whichever `barry` is first on PATH, which may be another checkout's.
 *
 * A `file:` URL among node's own flags (tsx passes `--import file:///…`) is
 * written as a path: cursor silently never runs a hook command with a
 * `file:///` in it (measured on 2026.09.28), and node takes the path alike.
 */
export function thisCliCommand(...args: string[]): string {
  const script = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const nodeFlags = process.execArgv.map((flag) => (flag.startsWith("file:") ? fileURLToPath(flag) : flag));
  const argv = [process.execPath, ...nodeFlags, ...(script ? [script] : []), ...(process.env.BARRY_IDENTITY_BINDING ? [process.env.BARRY_IDENTITY_BINDING] : []), ...args];
  return argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}
