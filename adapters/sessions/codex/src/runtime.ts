import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { createHash, randomUUID } from "crypto";
import { writeCodexToolGate, toolGateConfig } from "./tool-gate.js";
import { barryCacheDir, instanceId, writePrivateFile } from "@barry-rocks/sdk/services";
import { parseModelRef } from "@barry-rocks/sdk/ids";
import { codexModelId } from "./model-id.js";
import { stdioEnvironment } from "./stdio-env.js";

export interface CodexMcpServerConfig {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CodexRuntimeOptions {
  barrySessionId?: string;
  codexHome?: string;
  mcpServers?: Record<string, CodexMcpServerConfig>;
  deniedTools?: readonly string[];
  allowedNativeTools?: readonly string[];
  env?: Record<string, string | undefined>;
  /**
   * The working directory this session runs in, pre-trusted in `config.toml`.
   *
   * Without it the TUI opens "Trust this folder?" on attach and swallows
   * everything typed into it. Resolved to its realpath before being written,
   * because codex canonicalises the cwd before the lookup.
   */
  projectDir?: string;
  endpoint?: {
    /** Base URL must serve the Responses API supported by the pinned Codex build. */
    baseUrl: string;
    apiKey?: string;
  };
  model?: string;
  /** Barry's guidance for a TUI launch. A hosted thread carries it on `thread/start` instead. */
  instructions?: string;
  /** The user's codex config, whose answered model-migration prompts are carried over. */
  userConfigPath?: string;
}

export interface CodexRuntime {
  codexHome: string;
  configPath: string;
  env: Record<string, string>;
}

export interface CodexMcpTomlServer {
  url?: string;
  bearer_token_env_var?: string;
  env_http_headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env_vars?: string[];
}

/**
 * `codex app-server` binds a control socket at
 * `<CODEX_HOME>/app-server-control/app-server-control.sock` on its own,
 * outside any flag Barry passes — so `CODEX_HOME` itself must leave room for
 * that fixed 43-byte suffix under the OS's ~104-byte `sun_path` limit.
 */
const APP_SERVER_CONTROL_SOCKET_SUFFIX = "/app-server-control/app-server-control.sock";

/** Same margin `allocateUnixSocket` uses: under the OS limit, not at it. */
const SOCKET_PATH_LIMIT = 100;

/**
 * Codex's own vendor, as a provider Barry declares. Codex's built-in OpenAI
 * provider authenticates from a login (`auth.json`) and ignores a key in the
 * environment, so on its own it sends no credential at all (verified on
 * 0.160.1). This one reads the identity's key from the environment.
 */
const OWN_PROVIDER = {
  key: "barry-openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  credentialEnvVar: "OPENAI_API_KEY",
} as const;

/**
 * `CODEX_HOME` for one Barry session.
 *
 * A short alias at the realpath of `/tmp`, not `~/Library/Application Support/Barry` or
 * `os.tmpdir()`: both realpath to a long per-user directory on macOS (the
 * latter IS `$TMPDIR`, `/var/folders/<hash>/<hash>/T`, itself already ~50-90
 * bytes depending on the machine) that alone can exceed the budget below
 * before the session id is even added. `/tmp` resolves to `/private/tmp` on
 * macOS and stays short on Linux too.
 *
 * Scoped by `instanceId()` so a worktree's `.barry-dev` instance never shares
 * a codex home with the real one, and named by a short digest of the session
 * id rather than the id itself — same reasoning as `allocateUnixSocket`: the
 * budget below leaves little room, and the store, not the directory name,
 * says whose home this is. Preparation links this alias to the durable cache
 * home. Codex 0.160.1 canonicalizes CODEX_HOME but binds Unix sockets at its
 * own short protected path, leaving a rendezvous symlink at the requested
 * location; the pinned macOS/Linux probes verify a long durable target works.
 * No symlink sandbox opt-out is needed. Keeping our alias short also preserves
 * older verified launch plans and their path-normalized goldens.
 */
export function defaultCodexHome(barrySessionId?: string): string {
  const id = createHash("sha256")
    .update(barrySessionId || randomUUID())
    .digest("hex")
    .slice(0, 12);
  // Every segment here is fixed-length (an 8-hex instance id, a 12-hex session
  // digest), so the result is always the same length regardless of input —
  // `runtime.test.ts` asserts that length stays under SOCKET_PATH_LIMIT rather
  // than checking it at runtime, since a runtime check here could never fail.
  return join(codexHomesRoot(), id);
}

/** Throws before codex would fail opaquely inside its own startup. */
function assertSocketPathFits(codexHome: string): void {
  const socketPath = codexHome + APP_SERVER_CONTROL_SOCKET_SUFFIX;
  if (socketPath.length > SOCKET_PATH_LIMIT) {
    throw new Error(
      `codex's control socket would be ${socketPath.length} bytes, over the ~${SOCKET_PATH_LIMIT} the OS allows: ${socketPath}`,
    );
  }
}

/**
 * `<realpath of /tmp>/barry-codex/<instance id>` — not created here. `defaultCodexHome`
 * stays a pure path computation; `prepareCodexRuntime`'s own `mkdirSync` brings
 * the whole chain into existence, and `ephemeralCodexHome` brings only the
 * parent it needs before `mkdtempSync`.
 */
export function codexHomesRoot(): string {
  return join(realpathSync("/tmp"), "barry-codex", instanceId());
}

/** Conversations survive temporary-directory cleanup; only their short aliases live there. */
export function durableCodexHomesRoot(): string {
  return join(barryCacheDir(), "codex-homes", instanceId());
}

/** Barry's retention metadata stays outside the harness's own configuration. */
export function codexHomeRecordPath(digest: string): string {
  if (!/^[a-f0-9]{12}$/.test(digest)) throw new Error("invalid managed codex home digest");
  return join(durableCodexHomesRoot(), ".sessions", `${digest}.json`);
}

/** Serialize preparation with retention; a busy home is kept or retried, never guessed stale. */
export function lockCodexHome(digest: string): () => void {
  if (!/^[a-f0-9]{12}$/.test(digest)) throw new Error("invalid managed codex home digest");
  const lock = join(durableCodexHomesRoot(), ".locks", digest);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  mkdirSync(lock, { mode: 0o700 });
  return () => rmSync(lock, { recursive: true });
}

/** Restore a managed alias, migrating an older directory without dropping its data. */
export function ensureCodexHome(codexHome: string): void {
  if (codexHome !== join(codexHomesRoot(), basename(codexHome)) || !/^[a-f0-9]{12}$/.test(basename(codexHome))) return;
  const durable = join(durableCodexHomesRoot(), basename(codexHome));
  mkdirSync(codexHomesRoot(), { recursive: true, mode: 0o700 });
  mkdirSync(durableCodexHomesRoot(), { recursive: true, mode: 0o700 });
  const existing = lstatSync(codexHome, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    if (!existsSync(durable) || realpathSync(codexHome) !== realpathSync(durable)) throw new Error(`codex home alias does not point at its managed durable home: ${codexHome}`);
    return;
  }
  if (existing) {
    if (!existing.isDirectory() || existsSync(durable)) throw new Error(`preserve both codex homes before resolving a migration conflict: ${codexHome}, ${durable}`);
    try { renameSync(codexHome, durable); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      cpSync(codexHome, durable, { recursive: true, errorOnExist: true, force: false });
      rmSync(codexHome, { recursive: true });
    }
  } else mkdirSync(durable, { recursive: true, mode: 0o700 });
  symlinkSync(durable, codexHome, "dir");
}

/**
 * A throwaway `CODEX_HOME` for a one-turn session, under the same short root
 * as {@link defaultCodexHome} — never `os.tmpdir()`, which is what left the
 * ephemeral path with this exact bug (`$TMPDIR` alone can already be over
 * budget once codex's fixed `app-server-control/app-server-control.sock`
 * suffix is added).
 *
 * The caller removes it; nothing here reaps it. The parent is created 0700 so
 * other users on the box cannot read into it before `mkdtemp` claims a name.
 */
export function ephemeralCodexHome(): string {
  const root = codexHomesRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const codexHome = mkdtempSync(`${root}/`);
  assertSocketPathFits(codexHome);
  return codexHome;
}

export function prepareCodexRuntime(options: CodexRuntimeOptions): CodexRuntime {
  const codexHome = options.codexHome || defaultCodexHome(options.barrySessionId);
  const managed = codexHome === join(codexHomesRoot(), basename(codexHome)) && /^[a-f0-9]{12}$/.test(basename(codexHome));
  const unlock = managed ? lockCodexHome(basename(codexHome)) : undefined;
  try {
  ensureCodexHome(codexHome);
  const env = compactEnv({
    ...(options.env ?? {}),
  });

  // No ambient credentials, plugins, skills or rules enter this private home.
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (!options.codexHome && options.barrySessionId) {
    const record = codexHomeRecordPath(basename(codexHome));
    mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
    writeFileSync(record, JSON.stringify({ sessionId: options.barrySessionId, lastUsedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  // Private config writes must land in the real owned directory; step 06's
  // managed home is a symlink alias (kept for the CODEX_HOME socket rendezvous),
  // which writePrivateFile's parent-ownership guard refuses.
  const ownedHome = realpathSync(codexHome);
  writeCodexToolGate(ownedHome, Object.keys(options.mcpServers ?? {}), options.deniedTools, options.allowedNativeTools, codexHome);

  let providerToml: string | undefined;
  let providerKey: string | undefined;
  let resolvedModelId: string | undefined;

  if (options.endpoint) {
    const endpointVendor = (options.model ? parseModelRef(options.model)?.vendor : undefined) ?? "custom";
    // Custom URLs must not override a reserved built-in provider such as openai.
    providerKey = `barry-endpoint-${endpointVendor}`;
    resolvedModelId = options.model ? codexModelId(options.model) : undefined;
    let credentialEnvVar: string | null = null;
    if (options.endpoint.apiKey) {
      credentialEnvVar = `BARRY_CODEX_PROVIDER_${sanitizeEnvSegment(endpointVendor)}_KEY`;
      env[credentialEnvVar] = options.endpoint.apiKey;
    }
    const toml = codexModelProviderToml(
      providerKey,
      {
        wireProtocol: "openai-protocol",
        baseUrl: options.endpoint.baseUrl,
        credentialEnvVar,
      },
      endpointVendor,
    );
    if (toml) {
      providerToml = toml;
    }
  } else {
    providerKey = OWN_PROVIDER.key;
    resolvedModelId = options.model ? codexModelId(options.model) : undefined;
    providerToml = codexModelProviderToml(
      OWN_PROVIDER.key,
      { wireProtocol: "openai-protocol", baseUrl: OWN_PROVIDER.baseUrl, credentialEnvVar: OWN_PROVIDER.credentialEnvVar, wireApi: "responses" },
      OWN_PROVIDER.label,
    ) ?? undefined;
  }

  const servers = codexMcpServersToToml(options.mcpServers ?? {}, env, codexHome);
  const configPath = join(ownedHome, "config.toml");
  writePrivateFile(
    configPath,
    renderCodexConfigToml(servers, {
      allowedNativeTools: options.allowedNativeTools,
      deniedTools: options.deniedTools,
      // realpath, because codex canonicalises the cwd before looking up its
      // trust level — a symlinked path (every macOS /tmp path) never matches.
      trustedProject: options.projectDir ? realpathSync(options.projectDir) : undefined,
      modelProvider: providerKey,
      model: resolvedModelId,
      modelProviderToml: providerToml,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.userConfigPath ? { answeredMigrations: answeredModelMigrations(options.userConfigPath) } : {}),
    }),
  );

  return {
    codexHome,
    configPath,
    env: {
      ...env,
      CODEX_HOME: codexHome,
    },
  };
  } finally { unlock?.(); }
}

export function codexMcpServersToToml(
  mcpServers: Record<string, CodexMcpServerConfig>,
  env: Record<string, string> = {},
  home?: string,
): Record<string, CodexMcpTomlServer> {
  const result: Record<string, CodexMcpTomlServer> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    if (server.url) {
      result[name] = translateHttpServer(name, server, env);
      continue;
    }

    if (server.command) {
      if (server.env && Object.keys(server.env).length > 0) {
        if (!home) throw new Error("Codex stdio environment requires an owned runtime home");
        const launcher = stdioEnvironment(name, server.env, env, home);
        result[name] = { ...launcher, args: [...launcher.args, server.command, ...(server.args ?? [])] };
        continue;
      }
      result[name] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
      };
      continue;
    }

    throw new Error(`Codex MCP server "${name}" must define either url or command`);
  }

  return result;
}

function translateHttpServer(
  name: string,
  server: CodexMcpServerConfig,
  env: Record<string, string>,
): CodexMcpTomlServer {
  const translated: CodexMcpTomlServer = { url: server.url };
  const headers = server.headers ?? {};
  const headerEntries = Object.entries(headers);
  if (headerEntries.length === 0) return translated;

  const authorization = headerEntries.find(([key]) => key.toLowerCase() === "authorization");
  const bearer = authorization?.[1].match(/^Bearer\s+(.+)$/i);
  if (bearer) {
    const envVar = `BARRY_CODEX_MCP_${sanitizeEnvSegment(name)}_BEARER_TOKEN`;
    env[envVar] = bearer[1]!;
    translated.bearer_token_env_var = envVar;
  }

  const remainingHeaders = headerEntries.filter(([key]) => key.toLowerCase() !== "authorization" || !bearer);
  if (remainingHeaders.length > 0) {
    translated.env_http_headers = {};
    for (const [key, value] of remainingHeaders) {
      const envVar = `BARRY_CODEX_MCP_${sanitizeEnvSegment(name)}_HEADER_${sanitizeEnvSegment(key)}`;
      env[envVar] = value;
      translated.env_http_headers[key] = envVar;
    }
  }

  return translated;
}

/**
 * A `[model_providers.*]` block for an endpoint codex can actually reach.
 *
 * Derived from the catalog's endpoint spec rather than hand-written, so the
 * base URL and credential variable have one definition. `wire_api` is the
 * reason this is not simply "point codex at any endpoint": codex speaks the
 * OpenAI format, and an Anthropic-protocol endpoint is unreachable however the
 * URL is set. `checkAgentModelPair` refuses those pairs before a session
 * starts; this function refuses to EMIT one, so the two cannot disagree.
 *
 * Returns null for an endpoint codex cannot speak, and for one whose base URL
 * is resolved at runtime rather than fixed — a local daemon's address is not
 * this file's to invent.
 */
export function codexModelProviderToml(
  key: string,
  endpoint: {
    wireProtocol: "anthropic-protocol" | "openai-protocol";
    baseUrl: string | null;
    credentialEnvVar: string | null;
    /** The pinned vendor supports Responses; explicit chat-only endpoints are refused. */
    wireApi?: "chat" | "responses";
  },
  label: string,
): string | null {
  if (endpoint.wireProtocol !== "openai-protocol") return null;
  if (!endpoint.baseUrl) return null;
  if (endpoint.wireApi === "chat") return null;

  const lines = [
    `[model_providers.${tomlKey(key)}]`,
    `name = ${tomlString(label)}`,
    `base_url = ${tomlString(endpoint.baseUrl)}`,
    `wire_api = ${tomlString("responses")}`,
  ];
  if (endpoint.credentialEnvVar) {
    lines.push(`env_key = ${tomlString(endpoint.credentialEnvVar)}`);
  }
  return lines.join("\n");
}

/**
 * Render `config.toml`.
 *
 * **Top-level keys must come BEFORE any `[table]`.** TOML scopes every key to
 * the most recent table header, so a top-level setting written after
 * `[projects."…"]` silently becomes a key of that project instead — it parses,
 * it applies to nothing, and there is no error.
 */
function renderCodexConfigToml(
  servers: Record<string, CodexMcpTomlServer>,
  options: {
    allowedNativeTools?: readonly string[];
    deniedTools?: readonly string[];
    trustedProject?: string;
    modelProvider?: string;
    model?: string;
    modelProviderToml?: string;
    instructions?: string;
    answeredMigrations?: string[];
  } = {},
): string {
  const lines: string[] = [];

  // ---- top-level keys FIRST ----

  if (options.modelProvider) {
    lines.push(`model_provider = ${tomlString(options.modelProvider)}`);
  }
  if (options.model) {
    lines.push(`model = ${tomlString(options.model)}`);
  }

  // Never the shared daemon. `codex agents` / `remote-control` is a managed,
  // self-updating package: Barry would be holding a handle to a
  // process that can replace itself under a pinned session. Barry runs its own
  // `codex app-server` per session instead.
  lines.push("daemon_auto_start = false");
  // The binary updates itself at startup otherwise, which breaks the pin every
  // declared guarantee was verified against.
  lines.push("check_for_update_on_startup = false");
  // Any client's turn runs under the same policy as Barry's thread, including
  // a turn typed in an attached TUI. Barry's PreToolUse hook is the gate.
  lines.push(`approval_policy = ${tomlString("never")}`);
  lines.push(`sandbox_mode = ${tomlString("danger-full-access")}`);
  if (options.instructions) {
    lines.push(`developer_instructions = ${tomlString(options.instructions)}`);
  }
  lines.push("");

  for (const [key, value] of Object.entries(toolGateConfig({ allowedNativeTools: [...options.allowedNativeTools ?? []], deniedTools: [...options.deniedTools ?? []] }))) {
    lines.push(`${key} = ${JSON.stringify(value)}`);
  }
  lines.push("");

  // ---- tables ----

  if (options.modelProviderToml) {
    lines.push(options.modelProviderToml);
    lines.push("");
  }

  // Every session has a fresh home, so without these a model-migration
  // prompt the user already answered would take the first input of every TUI.
  if (options.answeredMigrations?.length) {
    lines.push("[notice.model_migrations]");
    lines.push(...options.answeredMigrations);
    lines.push("");
  }

  if (options.trustedProject) {
    // Without this the TUI opens "Trust this folder?" on attach, and whatever
    // is typed or injected lands in that dialog rather than the conversation —
    // observed during the research, where injected text navigated a menu.
    // The key must be the REALPATH: codex canonicalises the cwd before looking
    // it up, so a symlinked path never matches.
    lines.push(`[projects.${tomlString(options.trustedProject)}]`);
    lines.push(`trust_level = ${tomlString("trusted")}`);
    lines.push("");
  }

  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    lines.push('omit_tools_from = ["deferred", "code_mode"]');
    if (server.url) lines.push(`url = ${tomlString(server.url)}`);
    if (server.bearer_token_env_var) {
      lines.push(`bearer_token_env_var = ${tomlString(server.bearer_token_env_var)}`);
    }
    if (server.env_http_headers) {
      lines.push(`env_http_headers = ${tomlInlineTable(server.env_http_headers)}`);
    }
    if (server.command) lines.push(`command = ${tomlString(server.command)}`);
    if (server.args) lines.push(`args = [${server.args.map(tomlString).join(", ")}]`);
    if (server.env_vars) lines.push(`env_vars = [${server.env_vars.map(tomlString).join(", ")}]`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Where the user's own codex keeps its config: their `CODEX_HOME`, or `~/.codex`. */
export function userCodexConfigPath(env: Record<string, string | undefined>): string {
  return join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"), "config.toml");
}

/** The `"from" = "to"` lines of the user's `[notice.model_migrations]` table, or none. */
function answeredModelMigrations(userConfigPath: string): string[] {
  if (!existsSync(userConfigPath)) return [];
  const answered: string[] = [];
  let inTable = false;
  for (const line of readFileSync(userConfigPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) inTable = trimmed === "[notice.model_migrations]";
    else if (inTable && /^"[^"]+"\s*=\s*"[^"]+"$/.test(trimmed)) answered.push(trimmed);
  }
  return answered;
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function sanitizeEnvSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9]/g, "_").replace(/_+/g, "_").toUpperCase();
  return sanitized || "SERVER";
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
    .join(", ")} }`;
}
