/**
 * Barry's MCP server config, as pi's `registerMcpServer` takes it.
 *
 * pi speaks stdio and streamable HTTP; the legacy SSE transport is rejected
 * outright by pi itself, so an `sse` server is refused here rather than
 * registered as something it is not — a server Barry names but pi cannot
 * reach reads as configured while connecting to nothing.
 */
import type { McpServerConfig as BarryMcpServerConfig } from "@barry-rocks/sdk/sessions";

/** pi's server config, narrowed to the fields Barry's carries. */
export interface PiMcpStdioConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface PiMcpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type PiMcpConfig = (PiMcpStdioConfig | PiMcpHttpConfig) & { exposure?: "direct" };

export class McpTransportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTransportRefused";
  }
}

/** One Barry server entry as pi's config shape, or a refusal naming why. */
export function toPiMcpConfig(name: string, server: BarryMcpServerConfig): PiMcpConfig {
  if ("type" in server && server.type === "http") return httpConfig(server);
  if ("type" in server && server.type === "sse") {
    throw new McpTransportRefused(
      `pi does not support the SSE transport, so MCP server ${name} (${server.url}) cannot be registered`,
    );
  }
  if ("command" in server) {
    return stdioConfig(server);
  }
  throw new McpTransportRefused(`Unknown MCP server configuration for ${name}`);
}

function httpConfig(server: { url: string; headers?: Record<string, string> }): PiMcpHttpConfig {
  const config: PiMcpHttpConfig = { type: "http", url: server.url };
  const headers = server.headers;
  if (headers && Object.keys(headers).length > 0) config.headers = { ...headers };
  return config;
}

function stdioConfig(server: { command: string; args?: string[]; env?: Record<string, string> }): PiMcpStdioConfig {
  const config: PiMcpStdioConfig = { type: "stdio", command: server.command };
  if (server.args?.length) config.args = [...server.args];
  const env = server.env;
  if (env && Object.keys(env).length > 0) {
    // pi resolves `${NAME}` in env values itself; the values Barry hands it
    // are already resolved, so they pass through whole.
    config.env = { ...env };
  }
  return config;
}

/** The whole record, in pi's shape, with a refusal for anything pi refuses. */
export function toPiMcpConfigs(servers: Record<string, BarryMcpServerConfig>): Record<string, PiMcpConfig> {
  const configs: Record<string, PiMcpConfig> = {};
  for (const [name, server] of Object.entries(servers)) configs[name] = { ...toPiMcpConfig(name, server), exposure: "direct" };
  return configs;
}
