/**
 * A fake model and MCP server for driving the real opencode binary.
 *
 * One loopback HTTP server is both: an OpenAI-compatible chat endpoint whose
 * replies are scripted, and an MCP endpoint (JSON replies, no stream) with a
 * single tool, `probe_tool`. Each records what opencode sent, so a test reads
 * which tools the model was offered, which key authenticated, and which
 * session id reached the MCP server. The keys in these tests are fake.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatRequest {
  /** When it arrived, in ms since the probe started. */
  at: number;
  /** The bearer token, as sent. */
  auth: string | null;
  /** The tools the model was offered. */
  tools: string[];
  messages: Array<{ role: string; content: unknown }>;
}

export interface McpRequest {
  /** When it arrived, in ms since the probe started. */
  at: number;
  method: string | undefined;
  /** The `sessionId` in the URL opencode reached the server on. */
  sessionId: string | null;
  auth: string | null;
}

/** What the model does on one turn of the conversation. */
export interface ProbeStep {
  /** Call this tool; otherwise answer `text`, or "probe-ok". */
  call?: string;
  args?: Record<string, unknown>;
  text?: string;
  /** How long the reply takes. A real model takes seconds; opencode's timing depends on it. */
  delayMs?: number;
}

export interface Probe {
  /** `http://127.0.0.1:<port>`: the model at `/v1`, MCP at `/mcp`. */
  url: string;
  /** The conversation's requests, in order — not the title generator's. */
  chats: ChatRequest[];
  mcp: McpRequest[];
  /**
   * The model's steps: the n-th answers the conversation's n-th request.
   * Past the end it answers "probe-ok" at once. Starts a fresh recording.
   */
  script(steps: ProbeStep[]): void;
  close(): Promise<void>;
}

export async function startProbe(): Promise<Probe> {
  const chats: ChatRequest[] = [];
  const mcp: McpRequest[] = [];
  let steps: ProbeStep[] = [];
  const pending = new Set<NodeJS.Timeout>();
  const started = Date.now();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://probe");
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      const parsed = parseJson(body);

      if (url.pathname.startsWith("/mcp")) {
        if (req.method !== "POST") return void res.writeHead(405).end();
        const method = typeof parsed.method === "string" ? parsed.method : undefined;
        mcp.push({ at: Date.now() - started, method, sessionId: url.searchParams.get("sessionId"), auth });
        if (parsed.id === undefined) return void res.writeHead(202).end();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: mcpResult(method, parsed) }));
        return;
      }

      if (url.pathname.endsWith("/chat/completions")) {
        const messages = Array.isArray(parsed.messages) ? (parsed.messages as ChatRequest["messages"]) : [];
        const tools = Array.isArray(parsed.tools) ? parsed.tools.map((tool: { function?: { name?: string } }) => tool.function?.name ?? "") : [];
        // opencode titles a conversation with a separate request of its own.
        const title = messages.some((message) => message.role === "system" && String(message.content).startsWith("You are a title generator"));
        const step = title ? {} : (steps[chats.length] ?? {});
        if (!title) chats.push({ at: Date.now() - started, auth, tools, messages });
        const timer = setTimeout(() => {
          pending.delete(timer);
          reply(res, String(parsed.model ?? "probe"), step, chats.length);
        }, step.delayMs ?? 0);
        pending.add(timer);
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chats,
    mcp,
    script: (next) => {
      steps = next;
      chats.length = 0;
      mcp.length = 0;
    },
    close: async () => {
      for (const timer of pending) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mcpResult(method: string | undefined, request: Record<string, unknown>): unknown {
  if (method === "initialize") {
    const params = (request.params ?? {}) as { protocolVersion?: string };
    return { protocolVersion: params.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } };
  }
  if (method === "tools/list") return { tools: [{ name: "probe_tool", description: "probe", inputSchema: { type: "object", properties: {} } }] };
  if (method === "tools/call") return { content: [{ type: "text", text: "probe-tool-ran" }] };
  return {};
}

/** One streamed chat completion: a tool call, or text. */
function reply(res: http.ServerResponse, model: string, step: ProbeStep, turn: number): void {
  const id = `chatcmpl-${turn}`;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (step.call) {
    res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: step.call, arguments: JSON.stringify(step.args ?? {}) } }] }));
    res.write(chunk({}, "tool_calls"));
  } else {
    res.write(chunk({ role: "assistant", content: step.text ?? "probe-ok" }));
    res.write(chunk({}, "stop"));
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
