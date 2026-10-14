import type { NativeControl } from "../adapters/harnesses/index.js";
import type { SessionConfig } from "./index.js";
/** Every interface supplies the same effective harness configuration. Own mutable collections. */
export function configureSession(input: SessionConfig): SessionConfig {
  if (!input.sessionId || !input.cwd)
    throw new Error(
      "session configuration requires a session ID and working directory",
    );
  return {
    ...input,
    env: { ...input.env },
    mcpServers: Object.fromEntries(
      Object.entries(input.mcpServers).map(([name, server]) => [
        name,
        "command" in server
          ? {
              ...server,
              ...(server.args ? { args: [...server.args] } : {}),
              ...(server.env ? { env: { ...server.env } } : {}),
            }
          : {
              ...server,
              ...(server.headers ? { headers: { ...server.headers } } : {}),
            },
      ]),
    ),
    ...(input.deniedTools
      ? { deniedTools: [...new Set(input.deniedTools)] }
      : {}),
    ...(input.allowedNativeTools ? { allowedNativeTools: [...new Set(input.allowedNativeTools)] } : {}),
    ...(input.pluginDirs ? { pluginDirs: [...input.pluginDirs] } : {}),
    ...(input.projectRoots ? { projectRoots: [...input.projectRoots] } : {}),
    ...(input.extraArgs ? { extraArgs: [...input.extraArgs] } : {}),
    ...(input.telemetryHeaders
      ? { telemetryHeaders: { ...input.telemetryHeaders } }
      : {}),
    ...(input.resume ? { resume: { ...input.resume } } : {}),
    ...(input.egressSandbox
      ? {
          egressSandbox: {
            ...input.egressSandbox,
            allowDomains: [...input.egressSandbox.allowDomains],
            ...(input.egressSandbox.allowUnixSockets
              ? { allowUnixSockets: [...input.egressSandbox.allowUnixSockets] }
              : {}),
          },
        }
      : {}),
  };
}
export function assertSessionOwner(
  session: { identity_id?: number | null } | undefined,
  identity: number,
): void {
  if (!session) throw new Error("session not found");
  if (session.identity_id !== identity)
    throw new Error("session belongs to another identity");
}

/** Vendor spellings for a tool on an explicitly configured MCP server. */
export function isScopedMcpTool(tool: string, servers: readonly string[]): boolean {
  return servers.some(server => {
    const normalized = server.replace(/-/g, "_");
    return ["mcp__" + server + "__", "mcp__" + normalized + "__", normalized + "_"].some(prefix => tool.startsWith(prefix) && tool.length > prefix.length);
  });
}

/** Apply the non-negotiable native ceiling before any adapter starts work. */
export function configureHarnessSession(input: SessionConfig, nativeTools: readonly string[], native?: NativeControl): SessionConfig {
  const config = configureSession(input);
  if (config.extraArgs?.length) throw new Error("Raw adapter arguments cannot override Barry's tool policy");
  if (config.strictMcpConfig === false) throw new Error("Barry sessions cannot load unscoped vendor MCP configuration");
  if ((config.resume?.last || config.resume?.picker) && !config.resume?.harnessSessionId) throw new Error("Barry resume requires an exact recorded conversation ID");
  const names = Object.keys(config.mcpServers);
  if (names.some(name => !/^[A-Za-z0-9_-]+$/.test(name)) || new Set(names.map(name => name.replace(/-/g, "_"))).size !== names.length) throw new Error("MCP server names must be distinct after vendor normalization and cannot contain wildcards");
  const requested = new Set(config.allowedNativeTools ?? []);
  const callerDenied = new Set((config.deniedTools ?? []).map(tool => tool.toLowerCase()));
  const allowed = new Set(nativeTools.filter(tool => requested.has(tool) && native?.grantable.includes(tool) && !callerDenied.has(tool.toLowerCase())));
  for (const group of native?.inseparable ?? []) {
    if (!group.every(tool => allowed.has(tool))) for (const tool of group) allowed.delete(tool);
  }
  const deniedTools = [...new Set([...nativeTools.filter(tool => !allowed.has(tool)), ...(config.deniedTools ?? [])])];
  const denied = new Set(deniedTools.map(tool => tool.toLowerCase()));
  const decide = config.decide;
  return {
    ...config,
    strictMcpConfig: true,
    env: { ...config.env, BARRY_SESSION_ID: config.sessionId },
    deniedTools,
    allowedNativeTools: [...allowed],
    mcpServers: Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => {
      if ("command" in server) return [name, { ...server, env: { ...server.env, BARRY_SESSION_ID: config.sessionId } }];
      const url = new URL(server.url);
      if (url.pathname.includes("/mcp")) url.searchParams.set("sessionId", config.sessionId);
      return [name, { ...server, url: url.toString() }];
    })),
    decide: async (request) => {
      if (denied.has(request.tool.toLowerCase()) || (!allowed.has(request.tool) && !isScopedMcpTool(request.tool, names))) return { allow: false, reason: `${request.tool} is denied in this Barry session` };
      return decide ? decide(request) : { allow: true };
    },
  };
}

/**
 * The native tools a session may use (ADP-6): every adapter derived this the
 * same way, so it lives here once. `grantable` restricts to a declared subset
 * (pi); omit it to allow any requested native tool. `inseparable` groups drop
 * whole when any member is unavailable. Denials are case-insensitive, matching
 * the native policy and {@link configureHarnessSession}.
 */
export function allowedNative(
  config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">,
  nativeTools: readonly string[],
  native?: NativeControl,
): string[] {
  const requested = new Set(config.allowedNativeTools ?? []);
  const denied = new Set((config.deniedTools ?? []).map(tool => tool.toLowerCase()));
  const allowed = new Set(
    nativeTools.filter(tool =>
      requested.has(tool) &&
      (native?.grantable ? native.grantable.includes(tool) : true) &&
      !denied.has(tool.toLowerCase()),
    ),
  );
  for (const group of native?.inseparable ?? []) {
    if (!group.every(tool => allowed.has(tool))) for (const tool of group) allowed.delete(tool);
  }
  return [...allowed];
}

/**
 * The native tools a session must refuse: the complement of {@link allowedNative}
 * over the adapter's table, plus the caller's explicit denials (ADP-6).
 */
export function disallowedTools(
  config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">,
  nativeTools: readonly string[],
  native?: NativeControl,
): string[] {
  const allowed = new Set(allowedNative(config, nativeTools, native));
  return [...new Set([...nativeTools.filter(tool => !allowed.has(tool)), ...(config.deniedTools ?? [])])];
}
