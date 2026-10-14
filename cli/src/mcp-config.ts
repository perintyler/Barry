/**
 * MCP Configuration Generator
 *
 * Generates MCP server configurations. The barry server runs all local
 * tools in a single process. Remote/external servers are configured separately.
 */

import { getServicePort } from "@barry-rocks/sdk/services";
import type { McpConfig } from "./config.js";
import { join } from "node:path";
import { builtinBagsDir } from "@barry-rocks/sdk/internal/bags";
import { nodeTsArgv } from "@barry-rocks/sdk/internal/services";

/** The MCP server's entry: the `mcp` bag's `server` service, run directly for stdio. */
function mcpServerEntry(): string {
  const bags = builtinBagsDir();
  if (!bags) throw new Error("cannot start the MCP server over stdio: no builtin bags directory (set BARRY_BUILTIN_DIR)");
  return join(bags, "mcp", "src", "server-main.ts");
}

/**
 * Literal interactive defaults for the stdio runtime.
 */
function getBarryServerEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Interactive sessions get Claude Code's own question picker, which is a
  // better experience than the recorded-and-polled path. This is an explicit
  // opt-IN: the bag defaults to `web` because a background session has no
  // picker to fall back on.
  env.BARRY_QUESTION_MODE = "native";
  env.BASH_OUTPUT_LIMIT = "51200";
  env.BASH_DEFAULT_TIMEOUT = "120000";

  return env;
}

/**
 * Generate stdio-based MCP configuration
 */
export function generateStdioConfig(identityId?: number, harness?: string): McpConfig {
  if (identityId !== undefined && (!Number.isSafeInteger(identityId) || identityId <= 0)) {
    throw new TypeError("stdio identityId must be a positive local identity key");
  }
  const config: McpConfig = { mcpServers: {} };

  const [command, ...args] = nodeTsArgv(mcpServerEntry());
  config.mcpServers["barry"] = {
    command,
    args: [...args, "--stdio", ...(identityId === undefined ? [] : ["--identity-id", String(identityId)]), ...(harness === undefined ? [] : ["--harness", harness])],
    env: getBarryServerEnv(),
  };

  return config;
}

/**
 * Generate HTTP-based MCP configuration (Streamable HTTP transport)
 */
export function generateHttpConfig(): McpConfig {
  const config: McpConfig = { mcpServers: {} };

  // Barry server — direct Streamable HTTP (use environment-aware port).
  // The MCP server requires BARRY_SECRET; send it
  // as a bearer header so the agent's own connection is authenticated.
  config.mcpServers["barry"] = {
    type: "http",
    url: `http://127.0.0.1:${getServicePort("mcpBarry")}/mcp`,
    ...(process.env.BARRY_SECRET
      ? { headers: { Authorization: `Bearer ${process.env.BARRY_SECRET}` } }
      : {}),
  };

  return config;
}

/**
 * Baseline MCP entry for Cursor IDE (~/.cursor/mcp.json).
 * Uses HTTP to the local Barry MCP service. Auth comes from the user's
 * environment at connect time so the file does not embed BARRY_SECRET.
 */
export function generateCursorIdeConfig(): McpConfig {
  return {
    mcpServers: {
      barry: {
        type: "http",
        url: `http://127.0.0.1:${getServicePort("mcpBarry")}/mcp`,
        headers: {
          Authorization: "Bearer ${env:BARRY_SECRET}",
        },
      },
    },
  };
}

/**
 * Generate MCP configuration based on transport mode
 */
export function generateMcpConfig(transport: "http" | "sse" | "stdio", identityId?: number, harness?: string): McpConfig {
  return transport === "stdio" ? generateStdioConfig(identityId, harness) : generateHttpConfig();
}

/**
 * Get all MCP ports (for health checks)
 */
export function getAllMcpPorts(): Record<string, number> {
  const ports: Record<string, number> = {};

  // Barry server port (environment-aware)
  ports["barry"] = getServicePort("mcpBarry");

  return ports;
}

/**
 * Check if MCP servers are healthy
 */
export async function checkSseHealth(): Promise<{ healthy: string[]; unhealthy: string[] }> {
  const allPorts = getAllMcpPorts();

  const results = await Promise.all(
    Object.entries(allPorts).map(async ([name, port]) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          });
          return { name, ok: response.ok };
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return { name, ok: false };
      }
    }),
  );

  const healthy = results.filter((r) => r.ok).map((r) => r.name);
  const unhealthy = results.filter((r) => !r.ok).map((r) => r.name);

  return { healthy, unhealthy };
}
