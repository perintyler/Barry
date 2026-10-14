/**
 * A fake Google Gemini API and MCP server on one loopback port,
 * recording what an agy TUI sends. It records whether each request's
 * credential is the expected key, never the credential itself.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  /** Whether the request carried the expected key, some other credential, or none. */
  credential: "expected" | "other" | "none";
  rawKey?: string;
  url: string;
  body: string;
  parsedBody: Record<string, unknown>;
}

export interface Probe {
  url: string;
  modelRequests: ModelRequest[];
  mcpCalls: Array<{ method: string; tool?: string; sessionId: string | null }>;
  release(): void;
  holding(): boolean;
  close(): Promise<void>;
}

export const REPLY = "PINEAPPLE_OK";

export async function startProbe(expectedKey: string): Promise<Probe> {
  const modelRequests: ModelRequest[] = [];
  const mcpCalls: Probe["mcpCalls"] = [];

  const held = new Set<() => void>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://probe");
      if (url.pathname === "/mcp") {
        return answerMcp(req, res, raw, mcpCalls, url);
      }

      // Gemini streamGenerateContent endpoint
      if (url.pathname.includes("streamGenerateContent")) {
        const apiKey = req.headers["x-goog-api-key"] as string | undefined;
        const credential: ModelRequest["credential"] =
          apiKey === expectedKey ? "expected" : apiKey ? "other" : "none";

        const parsedBody = parse(raw);
        modelRequests.push({
          credential,
          rawKey: apiKey,
          url: req.url ?? "",
          body: raw,
          parsedBody,
        });

        const contents = parsedBody.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }> | undefined;
        const last = contents?.at(-1);
        const latestInput = contents?.filter(c => c.role === "user" && JSON.stringify(c.parts).includes("<USER_REQUEST>")).at(-1);
        const prompt = JSON.stringify(last?.parts?.some(p => "functionResponse" in p) ? last.parts : latestInput?.parts ?? last?.parts ?? []);
        const done = prompt.includes("functionResponse");
        const tool = !done ? prompt.match(/CALL_TOOL:([\w]+)/)?.[1] : undefined;
        const shell = !done ? prompt.match(/FORCE_SHELL:([^\s"\\]+)/)?.[1] : undefined;
        const encoded = !done ? prompt.match(/FORCE_NATIVE:([A-Za-z0-9+/=]+)/)?.[1] : undefined;
        const native = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString()) : undefined;
        const part = native ? { functionCall: native } : tool ? { functionCall: { name: "call_mcp_tool", args: { ServerName: "probe", ToolName: tool, Arguments: {}, toolSummary: "Probe call", toolAction: "Calling probe" } } }
          : shell ? { functionCall: { name: "run_command", args: { CommandLine: `touch ${shell}`, Cwd: shell.slice(0, shell.lastIndexOf("/")), WaitMsBeforeAsync: 0, toolSummary: "Shell probe", toolAction: "Probing shell" } } }
          : prompt.includes("STRUCTURED") ? { functionCall: { name: "finish", args: { ok: true, toolSummary: "Structured reply", toolAction: "Finishing reply" } } } : { text: REPLY };
        const answer = () => {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Connection": "close" });
          res.write("data: " + JSON.stringify({ candidates: [{ content: { parts: [part], role: "model" }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }) + "\n\n");
          res.end();
        };
        if (!done && prompt.includes("HOLD")) { held.add(answer); res.on("close", () => held.delete(answer)); return; }
        return answer();
      }

      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    modelRequests,
    mcpCalls,
    holding: () => held.size > 0,
    release() { for (const answer of held) answer(); held.clear(); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function answerMcp(req: IncomingMessage, res: ServerResponse, raw: string, calls: Probe["mcpCalls"], url: URL): void {
  if (req.method !== "POST") return void res.writeHead(405).end();
  const request = parse(raw) as { id?: number; method?: string; params?: { name?: string; protocolVersion?: string } };
  calls.push({ method: request.method ?? "", tool: request.params?.name, sessionId: url.searchParams.get("sessionId") });
  if (request.id === undefined) return void res.writeHead(202).end();
  const result =
    request.method === "initialize"
      ? { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : request.method === "tools/list"
        ? { tools: [{ name: "probe_tool", description: "Records that it ran.", inputSchema: { type: "object", properties: {} } }] }
        : request.method === "tools/call"
          ? { content: [{ type: "text", text: "probe-tool-ran" }] }
          : {};
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}

function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
