// Keep service registry, persisted conversation and credentials session-local; disable project config and use standalone guest mode.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-009

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bagDataDir, writePrivateFile } from "@barry-rocks/sdk/services";

/** The directories one Barry session's opencode keeps its state in. */
export interface OpenCodeHome {
  /** The home itself, holding the three below. */
  root: string;
  /** `XDG_DATA_HOME`: the conversation, and no stored credentials. */
  data: string;
  /** `XDG_STATE_HOME`: the TUI's own state, such as recently used models. */
  state: string;
  /** `XDG_CONFIG_HOME`: empty, so no global config or service registry is shared. */
  config: string;
}

/**
 * The session's opencode home, created `0700`.
 *
 * Named by a digest of the Barry session id, as codex's home is, so the same
 * session finds the same conversation again. Under the opencode bag's data
 * dir by default; `root` is for tests, which may not touch the real instance.
 */
export function openCodeHome(barrySessionId: string, root: string = join(bagDataDir("opencode"), "sessions")): OpenCodeHome {
  const dir = join(root, createHash("sha256").update(barrySessionId).digest("hex").slice(0, 16));
  const home = { root: dir, data: join(dir, "data"), state: join(dir, "state"), config: join(dir, "config") };
  for (const path of [home.data, home.state, home.config]) mkdirSync(path, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * A fresh private runtime directory for one process: 0700, and short, since
 * opencode may bind sockets in it. The launcher removes it.
 */
export function prepareRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "barry-oc-"));
}

// Translate identity keys to the vendor’s provider variables; Z.ai requires ZHIPU_API_KEY.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-010
const PROVIDER_KEYS: ReadonlyArray<{ provider: string; reads: string; from: readonly string[] }> = [
  { provider: "anthropic", reads: "ANTHROPIC_API_KEY", from: ["ANTHROPIC_API_KEY"] },
  { provider: "openai", reads: "OPENAI_API_KEY", from: ["OPENAI_API_KEY"] },
  { provider: "openrouter", reads: "OPENROUTER_API_KEY", from: ["OPENROUTER_API_KEY"] },
  { provider: "zai", reads: "ZHIPU_API_KEY", from: ["Z_AI_API_KEY", "ZAI_API_KEY", "ZHIPU_API_KEY"] },
  { provider: "opencode", reads: "OPENCODE_API_KEY", from: ["OPENCODE_API_KEY"] },
];

/**
 * The providers the identity's environment holds a key for, and those keys
 * under the names opencode reads.
 */
export function providerKeys(env: Readonly<Record<string, string | undefined>>): { providers: string[]; env: Record<string, string> } {
  const providers: string[] = [];
  const keys: Record<string, string> = {};
  for (const { provider, reads, from } of PROVIDER_KEYS) {
    const key = from.map((name) => env[name]).find((value) => typeof value === "string" && value.length > 0);
    if (!key) continue;
    providers.push(provider);
    keys[reads] = key;
  }
  return { providers, env: keys };
}

/**
 * The providers a session may use: those it holds a key for, and its model's
 * own — which may need none (a local one), and otherwise fails for want of
 * one, as it should.
 */
export function enabledProviders(env: Readonly<Record<string, string | undefined>>, model?: string): string[] {
  const providers = providerKeys(env).providers;
  const own = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
  return own && !providers.includes(own) ? [...providers, own] : providers;
}

/** A permission rule in opencode's own words. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** A name as opencode writes it into a permission action (its `Os`, 2.0.24): hyphens kept. */
function actionSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The rules every Barry session runs under: every native action denied, the
 * session's own MCP servers' tools let through, and each denied tool denied
 * by name. opencode applies the LAST rule that matches.
 *
 * `barryTools` is how Barry's tools are let through: `ask` puts every call to
 * Barry (hosted, where Barry answers), `allow` runs them (guest, where there
 * is nobody of Barry's to ask).
 *
 * `*` also denies `execute`, Code Mode's runtime. That is deliberate:
 * `fetch` inside it reached the network with `webfetch` denied (verified on
 * 2.0.24), so allowing it would let any call past every network bound.
 */
export function permissionRules(
  servers: readonly string[],
  deniedTools: readonly string[],
  allowedNativeTools: readonly string[],
  barryTools: "ask" | "allow",
): PermissionRule[] {
  if (servers.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))) throw new Error("OpenCode MCP server names cannot contain permission wildcards");
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...servers.map((name): PermissionRule => ({ action: `${actionSegment(name)}_*`, resource: "*", effect: barryTools })),
    ...[...new Set(allowedNativeTools.filter(tool => ["shell", "read", "grep", "glob", "edit", "write", "patch", "webfetch", "websearch"].includes(tool)).map(tool => ["write", "patch"].includes(tool) ? "edit" : tool))].map((action): PermissionRule => ({ action, resource: "*", effect: barryTools })),
    ...deniedTools.map((tool): PermissionRule => ({ action: openCodeAction(tool, servers), resource: "*", effect: "deny" })),
  ];
}

/** Barry's `mcp__<server>__<tool>` as the action opencode checks; a native name as it is. */
function openCodeAction(tool: string, servers: readonly string[]): string {
  if (["write", "patch"].includes(tool)) return "edit";
  const match = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!match) return tool;
  const [, server, name] = match;
  // Barry may already have normalized a hyphen away; the server's own name is
  // what opencode writes.
  const own = servers.find((candidate) => candidate === server || candidate.replace(/-/g, "_") === server) ?? server;
  return `${actionSegment(own)}_${actionSegment(name)}`;
}

/**
 * An action opencode asked about, in Barry's words: `<server>_<tool>` on one
 * of the session's servers becomes `mcp__<server>__<tool>`, the name Barry's
 * rulings and denied tools use. Anything else, a native action, is as it is.
 * The longest server name wins, so `a_b_x` on servers `a` and `a_b` is `a_b`'s.
 */
export function barryToolName(action: string, servers: readonly string[]): string {
  const server = [...servers]
    .sort((a, b) => b.length - a.length)
    .find((name) => action.startsWith(`${actionSegment(name)}_`) && action.length > actionSegment(name).length + 1);
  return server ? `mcp__${server}__${action.slice(actionSegment(server).length + 1)}` : action;
}

/** What a session's opencode is configured with. */
export interface SessionConfigOptions {
  /** Its MCP servers, already in opencode's shape (`mcp-config.ts`). */
  mcp: Record<string, Record<string, unknown>>;
  permissions: readonly PermissionRule[];
  /** The providers it may use. Empty means none. */
  providers: readonly string[];
  /** `provider/model`. The TUI takes no `--model`, so config is the only way in. */
  model?: string;
}

/**
 * The config document, in 2.x's own shape.
 *
 * Its own shape because the 1.x one is translated on load, and the
 * translation drops what it does not know: an MCP server's `codemode: false`
 * vanished under the 1.x `mcp` key and survives under `mcp.servers`.
 */
export function sessionConfig(options: SessionConfigOptions): Record<string, unknown> {
  return {
    ...(options.model ? { model: options.model } : {}),
    // The 1.x key, translated on load into `provider.use` policies that
    // allow these and deny the rest; an empty list denies every provider.
    enabled_providers: [...options.providers],
    permissions: [...options.permissions],
    mcp: { servers: options.mcp },
    share: "disabled",
  };
}

export interface OpenCodeEnvOptions {
  home: OpenCodeHome;
  runtimeDir: string;
  config: Record<string, unknown>;
  /** The identity's environment, for its provider keys. */
  identityEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * The variables an opencode process gets on top of the identity's own: its
 * home, a private runtime dir, the session's config, and the identity's
 * provider keys under the names opencode reads.
 */
export function openCodeEnv(options: OpenCodeEnvOptions): Record<string, string> {
  const configPath = join(options.runtimeDir, "opencode.json");
  writePrivateFile(configPath, JSON.stringify(options.config));
  return {
    ...providerKeys(options.identityEnv).env,
    XDG_DATA_HOME: options.home.data,
    XDG_STATE_HOME: options.home.state,
    XDG_CONFIG_HOME: options.home.config,
    XDG_RUNTIME_DIR: options.runtimeDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    // The binary updates itself at startup otherwise, which breaks the pin
    // every declared guarantee was verified against.
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG: configPath,
  };
}

/**
 * The environment for a vendor TUI attaching to Barry's server.
 *
 * Deliberately not the server's. It carries the password (the client needs it
 * to authenticate) and the same runtime dir, but no `OPENCODE_CONFIG`
 * — sending config here would imply it takes effect, and it does not. That
 * false implication is exactly what made E6 invisible.
 */
export function clientEnv(runtimeDir: string, password: string): Record<string, string> {
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

/** The arguments that attach a vendor TUI to Barry's server. */
export function attachArgs(baseUrl: string, sessionId: string): string[] {
  return ["--server", baseUrl, "--session", sessionId];
}

/** The arguments for Barry's own server process. */
export function serveArgs(port: number): string[] {
  // Bound to loopback explicitly: an engine holding a session's whole
  // conversation has no business listening on a routable interface.
  return ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
}
