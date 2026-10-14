/**
 * Barry → OpenCode MCP server translation.
 *
 * Barry describes MCP servers as `{ type: "http", url }` or
 * `{ type: "stdio", command, args }`; OpenCode wants `{ type: "remote", url }`
 * or `{ type: "local", command: [...] }`, with headers and environment under
 * different keys.
 *
 * Shared because both modes translate the same servers: the hosted server's
 * config and the guest TUI's.
 *
 * Every server gets `codemode: false`. opencode 2.x otherwise offers an MCP
 * server's tools only inside Code Mode, through its `execute` tool — which
 * Barry denies, because `fetch` inside it reached the network with `webfetch`
 * denied. With Code Mode off they are ordinary tools named
 * `<server>_<tool>`, ruled on one by one (verified on 2.0.24).
 */

/**
 * A Barry MCP server entry as the CLI finds it — parsed from JSON on disk, so
 * every field arrives unvalidated. The typed callers pass a narrower shape and
 * are assignable to this.
 */
export interface BarryMcpServer {
  url?: unknown;
  headers?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

export type OpenCodeMcpServer = Record<string, unknown>;

/**
 * Translate one Barry MCP server entry, or return null when it is neither a
 * remote nor a local server. A caller that already knows its input is well
 * formed still gets null for an entry carrying neither `url` nor `command`,
 * which is the same thing both call sites did by falling through their
 * if/else.
 */
export function toOpenCodeMcpServer(server: BarryMcpServer): OpenCodeMcpServer | null {
  if (typeof server.url === "string") {
    const remote: OpenCodeMcpServer = { type: "remote", url: overIpv4(server.url), codemode: false };
    if (server.headers) remote.headers = server.headers;
    return remote;
  }

  if (server.command !== undefined) {
    // The CLI reads this from JSON where `command` may already be an array;
    // the typed runtime path always passes a string.
    const command = Array.isArray(server.command) ? (server.command as string[]) : [server.command as string];
    const args = Array.isArray(server.args) ? (server.args as string[]) : [];
    const local: OpenCodeMcpServer = { type: "local", command: [...command, ...args], codemode: false };
    if (server.env) local.environment = server.env;
    return local;
  }

  return null;
}

// Use IPv4 loopback because the supported vendor build does not fall back from IPv6 localhost.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-007
function overIpv4(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)localhost(?=[:/?#]|$)/i, "$1127.0.0.1");
}

/** Translate a whole `mcpServers` map, dropping entries that are neither kind. */
export function toOpenCodeMcpConfig(
  servers: Record<string, BarryMcpServer>,
): Record<string, OpenCodeMcpServer> {
  const mcp: Record<string, OpenCodeMcpServer> = {};
  for (const [name, server] of Object.entries(servers)) {
    const translated = toOpenCodeMcpServer(server);
    if (translated) mcp[name] = translated;
  }
  return mcp;
}
