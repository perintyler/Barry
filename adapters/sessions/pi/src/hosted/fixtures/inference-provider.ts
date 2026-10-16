import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface RecordedProviderRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  parsedBody: Record<string, unknown> | null;
  receivedAtMs: number;
}

export interface AnthropicSseTurnScript {
  kind: "anthropic_sse";
  model?: string;
  id?: string;
  text?: string;
  thinkingText?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  stopReason?: "end_turn" | "max_tokens" | "tool_use";
  /**
   * Usage object emitted on `message_start`. Set to `null` or `undefined` to omit.
   */
  messageStartUsage?: Record<string, unknown> | null;
  /**
   * Usage object emitted on `message_delta`. Set to `null` or `undefined` to omit.
   */
  messageDeltaUsage?: Record<string, unknown> | null;
  /**
   * When true, destroys the response stream after `message_start` and initial delta
   * before `message_delta` / `message_stop`.
   */
  truncateMidstream?: boolean;
  delayBeforeHeadersMs?: number;
  delayBeforeBodyMs?: number;
  headers?: Record<string, string>;
}

export interface OpenAiSseTurnScript {
  kind: "openai_sse";
  model?: string;
  id?: string;
  text?: string;
  reasoningText?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason?: "stop" | "length" | "tool_calls";
  /**
   * Usage object emitted on the final chunk. Set to `null` or `undefined` to omit.
   */
  chunkUsage?: Record<string, unknown> | null;
  /**
   * Optional intermediate usage emitted on an earlier chunk.
   */
  intermediateUsage?: Record<string, unknown> | null;
  truncateMidstream?: boolean;
  delayBeforeHeadersMs?: number;
  delayBeforeBodyMs?: number;
  headers?: Record<string, string>;
}

export interface HttpErrorTurnScript {
  kind: "http_error";
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayBeforeHeadersMs?: number;
}

export interface MalformedBodyTurnScript {
  kind: "malformed_body";
  status?: number;
  contentType?: string;
  rawBody: string;
  headers?: Record<string, string>;
}

export interface SocketResetTurnScript {
  kind: "socket_reset";
  phase: "before_headers" | "after_headers";
  status?: number;
  headers?: Record<string, string>;
}

export type ScriptedProviderTurn =
  | AnthropicSseTurnScript
  | OpenAiSseTurnScript
  | HttpErrorTurnScript
  | MalformedBodyTurnScript
  | SocketResetTurnScript;

export interface LoopbackInferenceProvider {
  readonly baseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly openAiBaseUrl: string;
  readonly port: number;
  readonly requests: RecordedProviderRequest[];
  enqueue(...turns: ScriptedProviderTurn[]): void;
  setHandler(
    handler:
      | ((req: RecordedProviderRequest, index: number) => ScriptedProviderTurn | Promise<ScriptedProviderTurn>)
      | null,
  ): void;
  clearRequests(): void;
  close(): Promise<void>;
}

function isClientDisconnected(req: IncomingMessage, res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded || Boolean(req.socket?.destroyed);
}

function sleep(ms: number, res: ServerResponse): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    res.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function writeSseEvent(res: ServerResponse, event: string | null, data: unknown): void {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`data: ${payload}\n\n`);
}

export async function createLoopbackInferenceProvider(
  initialTurns: ScriptedProviderTurn[] = [],
): Promise<LoopbackInferenceProvider> {
  const queue: ScriptedProviderTurn[] = [...initialTurns];
  const requests: RecordedProviderRequest[] = [];
  const sockets = new Set<Socket>();
  let customHandler:
    | ((req: RecordedProviderRequest, index: number) => ScriptedProviderTurn | Promise<ScriptedProviderTurn>)
    | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      void handleRequest(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: string,
  ): Promise<void> {
    let parsedBody: Record<string, unknown> | null = null;
    if (rawBody.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedBody = parsed as Record<string, unknown>;
        }
      } catch {
        parsedBody = null;
      }
    }

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = v;
    }

    const recorded: RecordedProviderRequest = {
      method: req.method ?? "POST",
      path: req.url ?? "/",
      headers,
      rawBody,
      parsedBody,
      receivedAtMs: Date.now(),
    };
    const index = requests.push(recorded) - 1;

    let script: ScriptedProviderTurn | undefined;
    if (customHandler) {
      script = await customHandler(recorded, index);
    } else {
      script = queue.shift();
    }

    if (!script) {
      // Default fallback turn based on request path
      if ((req.url ?? "").includes("/messages")) {
        script = {
          kind: "anthropic_sse",
          text: "default loopback anthropic reply",
          messageStartUsage: { input_tokens: 10, output_tokens: 0 },
          messageDeltaUsage: { output_tokens: 5 },
        };
      } else {
        script = {
          kind: "openai_sse",
          text: "default loopback openai reply",
          chunkUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      }
    }

    if (script.kind === "socket_reset") {
      if (script.phase === "before_headers") {
        req.socket.destroy();
        return;
      }
      res.writeHead(script.status ?? 200, {
        "content-type": "text/event-stream",
        ...(script.headers ?? {}),
      });
      res.flushHeaders();
      req.socket.destroy();
      return;
    }

    if (script.kind === "http_error") {
      if (script.delayBeforeHeadersMs) {
        await sleep(script.delayBeforeHeadersMs, res);
      }
      if (isClientDisconnected(req, res)) return;
      const bodyStr =
        typeof script.body === "string"
          ? script.body
          : JSON.stringify(
              script.body ?? {
                error: {
                  type: "api_error",
                  message: `Simulated HTTP ${script.status}`,
                },
              },
            );
      res.writeHead(script.status, {
        "content-type": "application/json",
        ...(script.headers ?? {}),
      });
      res.end(bodyStr);
      return;
    }

    if (script.kind === "malformed_body") {
      res.writeHead(script.status ?? 200, {
        "content-type": script.contentType ?? "application/json",
        ...(script.headers ?? {}),
      });
      res.end(script.rawBody);
      return;
    }

    if (script.kind === "anthropic_sse") {
      if (script.delayBeforeHeadersMs) {
        await sleep(script.delayBeforeHeadersMs, res);
      }
      if (isClientDisconnected(req, res)) return;

      const modelId =
        script.model ??
        (typeof parsedBody?.model === "string" ? parsedBody.model : "claude-sonnet-5");
      const msgId = script.id ?? `msg_${index + 1}`;

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...(script.headers ?? {}),
      });
      res.flushHeaders();

      if (script.delayBeforeBodyMs) {
        await sleep(script.delayBeforeBodyMs, res);
      }
      if (isClientDisconnected(req, res)) return;

      const messageStartPayload: Record<string, unknown> = {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          ...(script.messageStartUsage !== undefined && script.messageStartUsage !== null
            ? { usage: script.messageStartUsage }
            : {}),
        },
      };
      writeSseEvent(res, "message_start", messageStartPayload);

      let blockIndex = 0;
      if (script.thinkingText !== undefined) {
        writeSseEvent(res, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "thinking", thinking: "" },
        });
        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "thinking_delta", thinking: script.thinkingText },
        });
        writeSseEvent(res, "content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        });
        blockIndex += 1;
      }

      if (script.text !== undefined || (!script.toolCalls?.length && script.thinkingText === undefined)) {
        const text = script.text ?? "";
        writeSseEvent(res, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        });
        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text },
        });
        if (script.truncateMidstream) {
          await sleep(15, res);
          req.socket.destroy();
          return;
        }
        writeSseEvent(res, "content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        });
        blockIndex += 1;
      } else if (script.truncateMidstream) {
        await sleep(15, res);
        req.socket.destroy();
        return;
      }

      if (script.toolCalls) {
        for (const tc of script.toolCalls) {
          writeSseEvent(res, "content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: {},
            },
          });
          writeSseEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(tc.input),
            },
          });
          writeSseEvent(res, "content_block_stop", {
            type: "content_block_stop",
            index: blockIndex,
          });
          blockIndex += 1;
        }
      }

      const stopReason =
        script.stopReason ??
        (script.toolCalls && script.toolCalls.length > 0 ? "tool_use" : "end_turn");

      writeSseEvent(res, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        ...(script.messageDeltaUsage !== undefined && script.messageDeltaUsage !== null
          ? { usage: script.messageDeltaUsage }
          : {}),
      });
      writeSseEvent(res, "message_stop", { type: "message_stop" });
      res.end();
      return;
    }

    if (script.kind === "openai_sse") {
      if (script.delayBeforeHeadersMs) {
        await sleep(script.delayBeforeHeadersMs, res);
      }
      if (isClientDisconnected(req, res)) return;

      const modelId =
        script.model ??
        (typeof parsedBody?.model === "string" ? parsedBody.model : "gpt-4o-mini");
      const chatId = script.id ?? `chatcmpl_${index + 1}`;

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...(script.headers ?? {}),
      });
      res.flushHeaders();

      if (script.delayBeforeBodyMs) {
        await sleep(script.delayBeforeBodyMs, res);
      }
      if (isClientDisconnected(req, res)) return;

      if (script.reasoningText !== undefined) {
        writeSseEvent(res, null, {
          id: chatId,
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", reasoning_content: script.reasoningText },
              finish_reason: null,
            },
          ],
          ...(script.intermediateUsage !== undefined && script.intermediateUsage !== null
            ? { usage: script.intermediateUsage }
            : {}),
        });
      }

      if (script.text !== undefined || (!script.toolCalls?.length && script.reasoningText === undefined)) {
        writeSseEvent(res, null, {
          id: chatId,
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: script.text ?? "" },
              finish_reason: null,
            },
          ],
          ...(script.intermediateUsage !== undefined &&
          script.intermediateUsage !== null &&
          script.reasoningText === undefined
            ? { usage: script.intermediateUsage }
            : {}),
        });
      }

      if (script.truncateMidstream) {
        await sleep(15, res);
        req.socket.destroy();
        return;
      }

      if (script.toolCalls && script.toolCalls.length > 0) {
        writeSseEvent(res, null, {
          id: chatId,
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: script.toolCalls.map((tc, idx) => ({
                  index: idx,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              },
              finish_reason: null,
            },
          ],
        });
      }

      const finishReason =
        script.finishReason ??
        (script.toolCalls && script.toolCalls.length > 0 ? "tool_calls" : "stop");

      writeSseEvent(res, null, {
        id: chatId,
        object: "chat.completion.chunk",
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
        ...(script.chunkUsage !== undefined && script.chunkUsage !== null
          ? { usage: script.chunkUsage }
          : {}),
      });
      res.end("data: [DONE]\n\n");
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    anthropicBaseUrl: `${baseUrl}/anthropic`,
    openAiBaseUrl: `${baseUrl}/v1`,
    port: address.port,
    requests,
    enqueue(...turns: ScriptedProviderTurn[]) {
      queue.push(...turns);
    },
    setHandler(handler) {
      customHandler = handler;
    },
    clearRequests() {
      requests.length = 0;
    },
    async close() {
      for (const s of sockets) {
        s.destroy();
      }
      sockets.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
