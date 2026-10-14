/**
 * In-process virtual completion bridge and loopback proxy.
 *
 * Exposes a dual-protocol HTTP bridge (OpenAI `/v1/chat/completions` +
 * Anthropic `/v1/messages`) so any coding harness can connect to a local
 * llama.cpp server with token logging, streaming, and format translation.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface BridgeOptions {
  /** Port to listen on. */
  port: number;
  /** Host to bind. Defaults to "127.0.0.1". */
  host?: string;
  /** Upstream llama-server base URL (e.g. "http://127.0.0.1:8081"). Optional. */
  upstreamUrl?: string;
  /** Default model ID to report. Defaults to "default". */
  modelId?: string;
  /** Callback fired for streamed token chunks. */
  onToken?: (token: string) => void;
  /** Callback fired when a completion completes with token usage. */
  onUsage?: (usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) => void;
}

export interface BridgeHandle {
  url: string;
  v1Url: string;
  port: number;
  close(): Promise<void>;
  server: Server;
}

function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
  res.end(body);
}

export function createLlamaBridgeServer(options: Omit<BridgeOptions, "port"> & { port?: number }): Server {
  const host = options.host ?? "127.0.0.1";
  const defaultModel = options.modelId ?? "default";

  return createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    const port = options.port ?? 80;
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

      // 1. Health check
      if (pathname === "/health" || pathname === "/v1/health") {
        let upstreamOk = false;
        if (options.upstreamUrl) {
          try {
            const probe = await fetch(`${options.upstreamUrl}/health`);
            upstreamOk = probe.ok;
          } catch {
            upstreamOk = false;
          }
        }
        writeJson(res, 200, {
          status: "ok",
          model: defaultModel,
          upstream: upstreamOk,
        });
        return;
      }

      // 2. Models list
      if (pathname === "/v1/models" || pathname === "/models") {
        writeJson(res, 200, {
          object: "list",
          data: [
            {
              id: defaultModel,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "llamacpp",
            },
          ],
        });
        return;
      }

      // 3. OpenAI Chat Completions
      if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
        try {
          const body = await parseJsonBody(req);
          const isStreaming = Boolean(body.stream);
          const model = typeof body.model === "string" ? body.model : defaultModel;

          if (options.upstreamUrl) {
            // Forward to upstream llama-server
            const upstreamRes = await fetch(`${options.upstreamUrl}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });

            if (isStreaming && upstreamRes.body) {
              res.writeHead(upstreamRes.status, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
              });

              const reader = upstreamRes.body.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                res.write(chunk);

                // Token parsing hook
                const lines = chunk.split("\n");
                for (const line of lines) {
                  if (line.startsWith("data: ") && !line.includes("[DONE]")) {
                    try {
                      const parsed = JSON.parse(line.slice(6));
                      const delta = parsed.choices?.[0]?.delta?.content;
                      if (delta && options.onToken) {
                        options.onToken(delta);
                      }
                      if (parsed.usage && options.onUsage) {
                        options.onUsage(parsed.usage);
                      }
                    } catch {
                      // ignore parse errors on partial chunks
                    }
                  }
                }
              }
              res.end();
              return;
            }

            const data = await upstreamRes.json();
            if (options.onUsage && (data)?.usage) {
              options.onUsage((data).usage);
            }
            writeJson(res, upstreamRes.status, data);
            return;
          }

          // Virtual completion response when no upstream server is configured
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            });

            const replyText = "Virtual completion from Barry llama bridge.";
            const chunkId = "chatcmpl-" + Math.random().toString(36).slice(2);

            res.write(
              `data: ${JSON.stringify({
                id: chunkId,
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null }],
              })}\n\n`,
            );

            if (options.onToken) options.onToken(replyText);

            res.write(
              `data: ${JSON.stringify({
                id: chunkId,
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
              })}\n\n`,
            );

            if (options.onUsage) options.onUsage({ promptTokens: 10, completionTokens: 8, totalTokens: 18 });

            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          const responseData = {
            id: "chatcmpl-" + Math.random().toString(36).slice(2),
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Virtual completion from Barry llama bridge." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          };
          if (options.onUsage) options.onUsage({ promptTokens: responseData.usage.prompt_tokens, completionTokens: responseData.usage.completion_tokens, totalTokens: responseData.usage.total_tokens });
          writeJson(res, 200, responseData);
          return;
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
      }

      // 4. Anthropic Messages API Translation
      if (pathname === "/v1/messages" || pathname === "/messages") {
        try {
          const body = await parseJsonBody(req);
          const isStreaming = Boolean(body.stream);
          const model = typeof body.model === "string" ? body.model : defaultModel;

          // Convert Anthropic messages to OpenAI messages
          const openAiMessages: Array<{ role: string; content: string }> = [];
          if (typeof body.system === "string") {
            openAiMessages.push({ role: "system", content: body.system });
          } else if (Array.isArray(body.system)) {
            const systemText = (body.system as Array<{ text?: string }>).map((s) => s.text ?? "").join("\n");
            if (systemText) openAiMessages.push({ role: "system", content: systemText });
          }

          if (Array.isArray(body.messages)) {
            for (const msg of body.messages as Array<{ role?: string; content?: unknown }>) {
              let text = "";
              if (typeof msg.content === "string") {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                text = (msg.content as Array<{ type?: string; text?: string }>)
                  .filter((b) => b.type === "text" && b.text)
                  .map((b) => b.text)
                  .join("\n");
              }
              openAiMessages.push({ role: msg.role ?? "user", content: text });
            }
          }

          let responseText = "Virtual completion from Barry llama bridge.";
          let promptTokens = 15;
          let completionTokens = 8;

          if (options.upstreamUrl) {
            // Send to upstream OpenAI completion
            const upstreamRes = await fetch(`${options.upstreamUrl}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                messages: openAiMessages,
                stream: false,
                max_tokens: body.max_tokens,
                temperature: body.temperature,
              }),
            });
            const upstreamData = (await upstreamRes.json());
            responseText = upstreamData.choices?.[0]?.message?.content ?? "";
            if (upstreamData.usage) {
              promptTokens = upstreamData.usage.prompt_tokens ?? promptTokens;
              completionTokens = upstreamData.usage.completion_tokens ?? completionTokens;
            }
          }

          if (options.onUsage) {
            options.onUsage({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
          }

          const msgId = "msg_" + Math.random().toString(36).slice(2);

          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            });

            // Anthropic SSE sequence
            res.write(
              `event: message_start\ndata: ${JSON.stringify({
                type: "message_start",
                message: {
                  id: msgId,
                  type: "message",
                  role: "assistant",
                  content: [],
                  model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: promptTokens, output_tokens: 1 },
                },
              })}\n\n`,
            );

            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              })}\n\n`,
            );

            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: responseText },
              })}\n\n`,
            );

            if (options.onToken) options.onToken(responseText);

            res.write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: 0,
              })}\n\n`,
            );

            res.write(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: completionTokens },
              })}\n\n`,
            );

            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            res.end();
            return;
          }

          // Non-streaming Anthropic response
          writeJson(res, 200, {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: responseText }],
            model,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: promptTokens, output_tokens: completionTokens },
          });
          return;
        } catch (err) {
          writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          return;
        }
      }

      // Not found
      writeJson(res, 404, { error: `Not found: ${pathname}` });
    });
}

export function createLlamaBridge(options: BridgeOptions): Promise<BridgeHandle> {
  const host = options.host ?? "127.0.0.1";
  const server = createLlamaBridgeServer(options);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : options.port;
      const baseUrl = `http://${host}:${actualPort}`;

      resolve({
        url: baseUrl,
        v1Url: `${baseUrl}/v1`,
        port: actualPort,
        server,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}
