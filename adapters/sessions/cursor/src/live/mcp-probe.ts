/**
 * A stand-in for Barry's MCP server: one tool, `probe_tool`, recording every
 * request with the session id from its URL. Cursor's model is its own, so
 * only this side of a live run is faked.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpProbe {
  url: string;
  calls: Array<{ method: string; sessionId: string | null }>;
  close(): Promise<void>;
}

export async function startMcpProbe(): Promise<McpProbe> {
  const calls: McpProbe["calls"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => answer(req, res, raw, new URL(req.url ?? "/", "http://probe"), calls));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function answer(req: IncomingMessage, res: ServerResponse, raw: string, url: URL, calls: McpProbe["calls"]): void {
  if (req.method !== "POST") return void res.writeHead(405).end();
  let request: { id?: number; method?: string; params?: { protocolVersion?: string } } = {};
  try {
    request = JSON.parse(raw || "{}") as typeof request;
  } catch {
    // Recorded as a call with no method.
  }
  calls.push({ method: request.method ?? "", sessionId: url.searchParams.get("sessionId") });
  if (request.id === undefined) return void res.writeHead(202).end();
  const result =
    request.method === "initialize"
      ? { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "probe_tool", description: "Records that it ran.", inputSchema: { type: "object", properties: {} } }] }
        : request.method === "tools/call"
          ? { content: [{ type: "text", text: "probe-tool-ran" }] }
          : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
