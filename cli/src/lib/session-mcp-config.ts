/**
 * The MCP servers an agent session connects to.
 *
 * Shared by `barry start` and `barry session run` so a one-shot run gets the
 * same servers an interactive session does.
 */
import { getServicePort } from "@barry-rocks/sdk/services";
import { resolveSessionNamespaces } from "@barry-rocks/sdk/internal/sessions";
import { ALWAYS_ON_MCP_SERVERS } from "@barry-rocks/sdk/bags";
import type { McpConfig } from "../config.js";
import { generateMcpConfig } from "../mcp-config.js";

/** Preserve session-derived tool prefixes while MCP discovery is unavailable. */
export function guestSessionMcpConfig(namespaces: string[], sessionId: string): Promise<McpConfig> {
  return sessionMcpConfig(namespaces, sessionId, namespaces);
}

export async function sessionMcpConfig(
  toolNames: Iterable<string>,
  sessionId?: string,
  namespaces?: Iterable<string>,
): Promise<McpConfig> {
  const fullConfig = generateMcpConfig("http");
  const config: McpConfig = { mcpServers: {} };

  for (const name of ALWAYS_ON_MCP_SERVERS) {
    if (fullConfig.mcpServers[name]) {
      config.mcpServers[name] = { ...fullConfig.mcpServers[name] };
    }
  }

  for (const toolName of toolNames) {
    if (fullConfig.mcpServers[toolName]) {
      config.mcpServers[toolName] = fullConfig.mcpServers[toolName];
    }
    // Namespace-only names (not separate MCP servers) are filtered server-side — no warning needed
    // Bag MCP servers are proxied through the barry server, not connected directly
  }

  // Append sessionId to the barry server URL so server-side bound filtering works
  if (sessionId) {
    const barry = config.mcpServers["barry"];
    const barryBaseUrl = barry?.url?.split("?")[0] ?? `http://127.0.0.1:${getServicePort("mcpBarry")}/mcp`;
    const barryHeaders = barry && "headers" in barry
      ? (barry as { headers?: Record<string, string> }).headers
      : undefined;

    // Register per-namespace MCP server entries. Each namespace gets its own
    // endpoint so Claude sees proper tool prefixes (mcp__linear__ticket_get
    // instead of mcp__barry__ticket_get) — the prefix comes from the config key.
    // Every entry targets the same MCP process; this costs handshakes, not
    // processes.
    //
    // The list comes from the server, which knows the session's real tool set
    // (bags + selected_namespaces + barry + bound). The caller's
    // bag-derived list is only a fallback.
    const resolvedNamespaces = await resolveSessionNamespaces(sessionId, {
      fallback: namespaces ? [...namespaces] : [],
    });

    // A namespace whose key is already taken (notably `barry` itself, which is
    // an always-on server name) cannot get its own entry, so it stays on the
    // aggregate endpoint and must NOT be excluded from it.
    const splitNamespaces = resolvedNamespaces.filter((ns) => !config.mcpServers[ns]);

    for (const ns of splitNamespaces) {
      config.mcpServers[ns] = {
        type: "http" as const,
        url: `${barryBaseUrl}/ns/${ns}?sessionId=${sessionId}`,
        ...(barryHeaders ? { headers: barryHeaders } : {}),
      };
    }

    // Tell the aggregate endpoint which namespaces moved, so it stops serving
    // them too — otherwise every split tool reaches the agent twice.
    if (barry?.url) {
      const params = new URLSearchParams({ sessionId });
      if (splitNamespaces.length > 0) params.set("split", splitNamespaces.join(","));
      config.mcpServers["barry"] = { ...barry, url: `${barryBaseUrl}?${params.toString()}` };
    }
  }

  return config;
}
