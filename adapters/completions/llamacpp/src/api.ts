/**
 * llama.cpp server API: OpenAI-compatible `/v1/chat/completions` and `/v1/models`.
 *
 * Direct System-2 token calls and model discovery against a local llama-server.
 */
import {
  ModelUnavailableError,
  type CompletionModel,
  type TokenUsage,
} from "@barry-rocks/sdk/adapters/models";
import type { Endpoint, ListedModel } from "@barry-rocks/sdk/adapters/models";
import { postJson } from "@barry-rocks/sdk/http";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface LlamaChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LlamaChatCall {
  system?: string;
  prompt: string;
  model: string;
  json?: boolean;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}

export function normalizeV1Url(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  if (base.endsWith("/v1")) {
    return `${base}/${trimmedPath}`;
  }
  return `${base}/v1/${trimmedPath}`;
}

export function llamaChat(endpoint: Endpoint, call: LlamaChatCall): Promise<LlamaChatResponse> {
  const url = normalizeV1Url(endpoint.baseUrl, "chat/completions");
  return postJson<LlamaChatResponse>({
    url,
    headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
    timeoutMs: call.timeoutMs,
    body: {
      model: call.model,
      messages: [
        ...(call.system ? [{ role: "system", content: call.system }] : []),
        { role: "user", content: call.prompt },
      ],
      stream: false,
      ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
      ...(call.maxTokens === undefined ? {} : { max_tokens: call.maxTokens }),
      ...(call.json ? { response_format: { type: "json_object" } } : {}),
    },
    describeHttpError: (status, body) => {
      if (status === 404) return `llama.cpp: model "${call.model}" not found or endpoint not found at ${url}.`;
      if (status === 503) return `llama.cpp: server is busy or loading model (${body.slice(0, 100)}).`;
      return undefined;
    },
  });
}

export function usageOf(body: LlamaChatResponse): { usage?: TokenUsage } {
  if (!body.usage) return {};
  return {
    usage: {
      inputTokens: body.usage.prompt_tokens ?? 0,
      outputTokens: body.usage.completion_tokens ?? 0,
      totalTokens: body.usage.total_tokens,
    },
  };
}

export function llamacppCompletionModel(model: string, endpoint: Endpoint): CompletionModel {
  return {
    ref: `llamacpp/${model}`,
    structuredOutput: "native",
    async complete(request) {
      const body = await llamaChat(endpoint, {
        ...(request.system ? { system: request.system } : {}),
        prompt: request.prompt,
        model,
        json: request.schema !== undefined,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      });
      const text = body.choices?.[0]?.message?.content ?? "";
      return { text, servedModel: body.model ?? model, ...usageOf(body) };
    },
  };
}

export async function listLlamaModels(endpoint: Endpoint): Promise<ListedModel[]> {
  const url = normalizeV1Url(endpoint.baseUrl, "models");
  try {
    const res = await fetch(url, {
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new ModelUnavailableError(`llama.cpp: ${url} returned HTTP ${res.status}.`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).flatMap((m) => (typeof m.id === "string" ? [{ id: m.id }] : []));
  } catch (err) {
    if (err instanceof ModelUnavailableError) throw err;
    throw new ModelUnavailableError(`llama.cpp unreachable at ${endpoint.baseUrl} (is \`llama-server\` running?)`, err);
  }
}
