/**
 * A fake Anthropic API, MCP server and OpenTelemetry receiver on one loopback
 * port, recording what a claude TUI sends. It records whether each request's
 * credential is the expected key, never the credential itself.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  /** Whether the request carried the expected key, some other credential, or none. */
  credential: "expected" | "other" | "none";
  stream: boolean;
  tools: string[];
  /** Everything the request sent, for checking what reached the model. */
  body: string;
}

export interface Probe {
  url: string;
  modelRequests: ModelRequest[];
  mcpCalls: Array<{ method: string; sessionId: string | null; tool?: string }>;
  release(): void;
  telemetryPaths: string[];
  close(): Promise<void>;
}

const REPLY = "PONG";

export async function startProbe(expectedKey: string): Promise<Probe> {
  const modelRequests: ModelRequest[] = [];
  const mcpCalls: Probe["mcpCalls"] = [];
  const telemetryPaths: string[] = [];

  let callNumber = 0;
  const held = new Set<() => void>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://probe");
      if (url.pathname === "/mcp") return answerMcp(req, res, raw, url, mcpCalls);
      if (url.pathname.startsWith("/v1/logs") || url.pathname.startsWith("/v1/traces")) {
        telemetryPaths.push(url.pathname);
        return json(res, {});
      }
      if (url.pathname.endsWith("/count_tokens")) return json(res, { input_tokens: 10 });
      if (!url.pathname.endsWith("/v1/messages")) return json(res, { error: "not found" }, 404);
      const body = parse(raw);
      modelRequests.push({
        credential: credentialOf(req, expectedKey),
        stream: body.stream === true,
        tools: Array.isArray(body.tools) ? body.tools.map((tool: { name: string }) => tool.name) : [],
        body: raw,
      });
      const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
      const last = messages?.filter(m => m.role === "user").at(-1);
      const prompt = JSON.stringify(last?.content ?? "");
      const blocks = Array.isArray(last?.content) ? last.content : [];
      const tail = blocks.at(-1) as { type?: string; text?: string } | undefined;
      const finished = prompt.includes('"tool_result"') && !(tail?.type === "text" && /CALL_TOOL:|FORCE_BASH:|FORCE_READ:|HOLD/.test(tail.text ?? ""));
      const directive = tail?.type === "text" && /CALL_TOOL:|FORCE_BASH:|FORCE_READ:|HOLD/.test(tail.text ?? "") ? tail.text! : prompt;
      const tool = !finished ? directive.match(/CALL_TOOL:([\w]+)/)?.[1] : undefined;
      const bash = !finished ? directive.match(/FORCE_BASH:([^\s"\\]+)/)?.[1] : undefined;
      const read = !finished ? directive.match(/FORCE_READ:([^\s"\\]+)/)?.[1] : undefined;
      const reply = read ? { type: "tool_use", id: `call_read_${++callNumber}`, name: "Read", input: { file_path: read } } : tool ? { type: "tool_use", id: `call_probe_${++callNumber}`, name: `mcp__probe__${tool}`, input: {} }
        : bash ? { type: "tool_use", id: `call_bash_${++callNumber}`, name: "Bash", input: { command: `touch ${bash}` } }
        : { type: "text", text: finished ? prompt : REPLY };
      const answer = () => body.stream === true ? streamReply(res, body.model, reply) : json(res, message(body.model, reply));
      if (!finished && prompt.includes("HOLD")) {
        held.add(answer);
        res.on("close", () => held.delete(answer));
        return;
      }
      return answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    modelRequests,
    mcpCalls,
    telemetryPaths,
    release() { for (const answer of held) answer(); held.clear(); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function credentialOf(req: IncomingMessage, expectedKey: string): ModelRequest["credential"] {
  const given = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (given === undefined) return "none";
  return given === expectedKey ? "expected" : "other";
}

function answerMcp(req: IncomingMessage, res: ServerResponse, raw: string, url: URL, calls: Probe["mcpCalls"]): void {
  if (req.method !== "POST") return void res.writeHead(405).end();
  const request = parse(raw) as { id?: number; method?: string; params?: { protocolVersion?: string; name?: string } };
  calls.push({ method: request.method ?? "", sessionId: url.searchParams.get("sessionId"), tool: request.params?.name });
  if (request.id === undefined) return void res.writeHead(202).end();
  const result =
    request.method === "initialize"
      ? { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
      : request.method === "tools/list"
        ? { tools: ["probe_tool", "probe_refused"].map(name => ({ name, description: "Records that it ran.", inputSchema: { type: "object", properties: {} } })) }
        : request.method === "tools/call"
          ? { content: [{ type: "text", text: "probe-tool-ran" }] }
          : {};
  json(res, { jsonrpc: "2.0", id: request.id, result });
}

function message(model: unknown, reply: Record<string, unknown> = { type: "text", text: REPLY }) {
  return {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    model,
    content: [reply],
    stop_reason: reply.type === "tool_use" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 1 },
  };
}

function streamReply(res: ServerResponse, model: unknown, reply: Record<string, unknown>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { ...message(model, reply), content: [], stop_reason: null } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: reply.type === "tool_use" ? { ...reply, input: {} } : { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: reply.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: reply.text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: reply.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
