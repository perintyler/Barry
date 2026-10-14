import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "../tools/register.js";
import { resultCharLimitFromEnv } from "../tools/truncate.js";
import { createLogger } from "../logging/index.js";
import type { AnyToolDefinition } from "../tools/define-tool.js";

export interface StartBagServerOptions {
  name: string;
  version?: string;
  tools: AnyToolDefinition[];
}

export async function startBagServer(options: StartBagServerOptions): Promise<McpServer> {
  const { name, version = "1.0.0", tools } = options;

  // stdout carries the MCP protocol over stdio, so this server's own logs must
  // go to stderr — the default `createLogger` stdout sink would corrupt the
  // framing a client parses on stdout.
  const log = createLogger(name, { transport: "stderr" });

  const server = new McpServer({ name, version });
  // The consuming host chooses whether to cap results.
  registerTools(
    server,
    tools,
    process.env.BARRY_TOOL_RESULT_CHAR_LIMIT
      ? { resultCharLimit: resultCharLimitFromEnv() }
      : {},
  );

  // Expose tool metadata so Barry can enrich proxied tools without a manifest `tools:` section
  const metadata = tools.map((tool) => ({
    name: tool.name,
    namespace: tool.namespace,
    access: tool.access,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }));

  server.resource("tools-meta", "barry://tools-meta", (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(metadata),
      },
    ],
  }));

  const transport = new StdioServerTransport();
  try { await server.connect(transport); }
  catch (error) {
    log.error("bag-server.connect-failed", { error: error instanceof Error ? error.message : String(error) });
    await server.close();
    throw error;
  }
  log.info("bag-server.started", { name, version, tools: tools.length });

  return server;
}
