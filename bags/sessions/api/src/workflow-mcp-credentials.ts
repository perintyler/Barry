import type { McpServerConfig } from "@barry-rocks/sdk/sessions";
import { getServicePort } from "@barry-rocks/sdk/services";

/** Replace Barry's instance credential only on Barry's local MCP gateway entries. */
export function withWorkflowSessionCredential(
  servers: Record<string, McpServerConfig>,
  credential: string,
): Record<string, McpServerConfig> {
  const expectedAuthority = `127.0.0.1:${getServicePort("mcpBarry")}`;
  let replaced = 0;
  const result = Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    if (!("url" in server) || !server.url) return [name, server];
    let url: URL;
    try { url = new URL(server.url); } catch { return [name, server]; }
    if (url.protocol !== "http:" || url.host !== expectedAuthority || !/^\/mcp(?:\/ns\/[^/]+)?$/.test(url.pathname)) return [name, server];
    const headers = { ...(server.headers ?? {}) };
    delete headers.Authorization;
    delete headers.authorization;
    headers.Authorization = `Bearer ${credential}`;
    replaced++;
    return [name, { ...server, headers }];
  }));
  if (!replaced) throw new Error("workflow session has no scoped Barry MCP gateway");
  return result;
}
