/**
 * A fake OpenAI Responses API and MCP server on one loopback port, recording
 * what codex sends. It records which known key each request carried, never
 * the credential itself.
 *
 * The model is scripted by the last input: `CALL_PROBE` calls Barry's probe
 * tool, `NATIVE_PROBE:apply_patch` forces a native call that Barry's hook must
 * refuse, `ECHO:<word>` answers `echoed <word>`, and anything else gets a
 * plain reply.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelRequest {
  /** The name of the known key the request carried, or "none" / "other". */
  credential: string;
  /** Whether Barry's guidance reached the request. */
  guided: boolean;
  tools: string[];
  toolSpecs: unknown[];
  lastInput: string;
}

export interface Probe {
  url: string;
  modelRequests: ModelRequest[];
  mcpCalls: Array<{ method: string; sessionId: string | null }>;
  release(): void;
  close(): Promise<void>;
}

export async function startProbe(keys: Record<string, string>, options: { guidance: string; sentinel: string }): Promise<Probe> {
  const modelRequests: ModelRequest[] = [];
  const held = new Set<() => void>();
  const mcpCalls: Probe["mcpCalls"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://probe");
      if (url.pathname === "/mcp") return answerMcp(req, res, raw, url, mcpCalls);
      if (!url.pathname.endsWith("/responses")) return void res.writeHead(404).end();
      const input = parse(raw);
      const history = Array.isArray(input.input) ? (input.input as Array<Record<string, unknown>>) : [];
      modelRequests.push({
        credential: credentialOf(req, keys),
        guided: raw.includes(options.guidance),
        tools: (Array.isArray(input.tools) ? (input.tools as Array<Record<string, unknown>>) : []).map((tool) => `${String(tool.type)}:${String(tool.name)}`),
        toolSpecs: Array.isArray(input.tools) ? input.tools : [],
        lastInput: JSON.stringify(history.at(-1) ?? "").slice(0, 400),
      });
      const respond = () => { held.delete(respond); if (!res.destroyed) reply(res, input, history, options.sentinel); };
      if (JSON.stringify(history.at(-1)).includes("HOLD_PROBE")) {
        held.add(respond);
        res.once("close", () => held.delete(respond));
      } else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, modelRequests, mcpCalls, release: () => { for (const respond of [...held]) respond(); }, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function credentialOf(req: IncomingMessage, keys: Record<string, string>): string {
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!given) return "none";
  return Object.entries(keys).find(([, key]) => key === given)?.[0] ?? "other";
}

function reply(res: ServerResponse, input: Record<string, unknown>, history: Array<Record<string, unknown>>, sentinel: string): void {
  const last = JSON.stringify(history.at(-1) ?? "");
  const answered = ["function_call_output", "custom_tool_call_output"].includes(String(history.at(-1)?.type));
  const tools = Array.isArray(input.tools) ? (input.tools as Array<Record<string, unknown>>) : [];
  // Codex sends MCP tools either grouped under a namespace or flat, by model.
  const namespace = tools.find((tool) => tool.type === "namespace" && String(tool.name).includes("probe"));
  const flat = tools.find((tool) => String(tool.name ?? "").includes("probe_tool"));
  const call = (fields: Record<string, unknown>): Record<string, unknown> => ({ id: "fc_" + randomUUID(), call_id: "call_" + randomUUID(), ...fields });
  const output = last.includes("Generate a concise, single-line task")
    ? message("Probe task")
    : answered
    ? message("Tool finished: " + last)
    : last.includes("NATIVE_PROBE:exec_command")
      ? call({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `touch ${sentinel}-shell` }) })
      : last.includes("NATIVE_PROBE:view_image")
        ? call({ type: "function_call", name: "view_image", arguments: JSON.stringify({ path: sentinel + ".png" }) })
        : last.includes("NATIVE_PROBE:apply_patch")
      ? call({ type: "custom_tool_call", name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${sentinel}\n+native executed\n*** End Patch\n` })
      : last.includes("CALL_PROBE") && namespace
        ? call({ type: "function_call", name: "probe_tool", namespace: namespace.name, arguments: "{}" })
        : last.includes("CALL_PROBE") && flat
          ? call({ type: "function_call", name: flat.name, arguments: "{}" })
          : /ECHO:(\w[\w-]*)/.test(last)
            ? message(`echoed ${/ECHO:(\w[\w-]*)/.exec(last)![1]}`)
            : message("PONG");
  const response = { id: "resp_" + randomUUID(), object: "response", status: "completed", model: input.model, output: [output], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("response.created", { response: { ...response, status: "in_progress", output: [] } });
  send("response.output_item.added", { output_index: 0, item: output });
  if (output.type === "message") {
    send("response.content_part.added", { output_index: 0, content_index: 0, item_id: output.id, part: { type: "output_text", text: "", annotations: [] } });
    send("response.output_text.delta", { output_index: 0, content_index: 0, item_id: output.id, delta: (output.content as Array<{ text: string }>)[0].text });
  }
  send("response.output_item.done", { output_index: 0, item: output });
  send("response.completed", { response });
  res.end();
}

function message(text: string): Record<string, unknown> {
  return { type: "message", id: "msg_" + randomUUID(), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
}

function answerMcp(req: IncomingMessage, res: ServerResponse, raw: string, url: URL, calls: Probe["mcpCalls"]): void {
  if (req.method !== "POST") return void res.writeHead(405).end();
  const request = parse(raw) as { id?: number; method?: string; params?: { protocolVersion?: string } };
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

function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
