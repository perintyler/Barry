import type { Grants } from "@barry-rocks/sdk";
import type { McpServerConfig } from "@barry-rocks/sdk/sessions";
import { traits } from "@barry-rocks/identities-bag";
import { resolveSessionNamespaces } from "@barry-rocks/sdk/internal/sessions";
import { getServicePort } from "@barry-rocks/sdk/services";

function generateRuntimeMcpConfig(): Record<string, McpServerConfig> {
  // The barry MCP server listens on the mcpBarry port (engine uses
  // getServicePort("mcpBarry")). mcpSession was a retired separate server —
  // pointing here at its port sent sessions to a dead URL, silently
  // stripping every barry MCP tool from every session.
  //
  // 127.0.0.1, not localhost: services bind IPv4 loopback alone, and an agent
  // that resolves localhost to ::1 without falling back (opencode 2.0.14 did)
  // finds nothing there.
  const config: Record<string, McpServerConfig> = {
    barry: {
      type: "http",
      url: `http://127.0.0.1:${getServicePort("mcpBarry")}/mcp`,
      ...(process.env.BARRY_SECRET
        ? { headers: { Authorization: `Bearer ${process.env.BARRY_SECRET}` } }
        : {}),
    },
  };

  return config;
}

/**
 * Built per call, not once at load: the engine's address comes from the
 * registry and can move, and a module that read it at import time would throw
 * in any process that imports this before the instance has a registry.
 */
const runtimeMcpServers = (): Record<string, McpServerConfig> => generateRuntimeMcpConfig();

// Neither builder takes a bag's MCP servers. Every server a bag declares is
// reached through the engine proxy, which filters it by the session's grant;
// a direct entry here would hand the agent that bag with no filter at all.
export function buildMcpConfig(namespaces?: string[]): Record<string, McpServerConfig> {
  const filtered: Record<string, McpServerConfig> = {};

  const runtime = runtimeMcpServers();
  for (const name of traits.alwaysOn) {
    if (runtime[name]) filtered[name] = runtime[name];
  }
  // Register per-namespace MCP server entries. Each namespace gets its own
  // endpoint so the SDK sees proper tool prefixes (mcp__linear__ticket_get
  // instead of mcp__barry__ticket_get) — the prefix comes from the config key.
  // All entries target the same MCP process, so this costs handshakes, not
  // processes. sessionId is appended later in session-runtime.ts runTurn().
  if (namespaces) {
    const barryPort = getServicePort("mcpBarry");
    const barryHeaders = process.env.BARRY_SECRET
      ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` }
      : undefined;

    // A namespace whose key is already taken (notably `barry` itself, an
    // always-on server name) cannot get its own entry, so it stays on the
    // aggregate endpoint and must NOT be excluded from it.
    const splitNamespaces = namespaces.filter((ns) => !filtered[ns]);

    for (const ns of splitNamespaces) {
      filtered[ns] = {
        type: "http",
        url: `http://127.0.0.1:${barryPort}/mcp/ns/${ns}`,
        ...(barryHeaders ? { headers: barryHeaders } : {}),
      };
    }

    // Tell the aggregate endpoint which namespaces moved, so it stops serving
    // them too — otherwise every split tool reaches the agent twice, once under
    // each prefix. sessionId is appended later in session-runtime.ts runTurn().
    const barry = filtered.barry;
    if (splitNamespaces.length > 0 && barry && "url" in barry && barry.url) {
      const sep = barry.url.includes("?") ? "&" : "?";
      filtered.barry = { ...barry, url: `${barry.url}${sep}split=${splitNamespaces.join(",")}` };
    }
  }

  return filtered;
}

/**
 * The MCP servers a session starts with: the always-on servers, and an entry
 * per namespace it is granted. The MCP server's answer for the session is the
 * authority; the session's grants stand in when it cannot be reached (or the
 * session is not created yet), since without namespaces every tool collapses
 * onto mcp__barry__*.
 */
export async function sessionMcpServers(sessionId: string | undefined, grants: Grants): Promise<Record<string, McpServerConfig>> {
  const namespaces = await resolveSessionNamespaces(sessionId, { fallback: grants.namespaces });
  return buildMcpConfig(namespaces);
}
