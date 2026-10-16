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
import { describeFetchFailure } from "@barry-rocks/sdk/http";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface LlamaUsageBlock {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
  } | null;
  completion_tokens_details?: {
    reasoning_tokens?: number | null;
  } | null;
}

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
  usage?: LlamaUsageBlock | null;
}

export interface LlamaPriceScheduleV1 {
  currency: "USD";
  input_cost_per_million: number;
  output_cost_per_million: number;
  reasoning_cost_per_million?: number;
  cache_read_cost_per_million?: number;
}

export interface LlamaInferencePolicyV1 {
  schema_version: 1;
  run_id: string;
  segment_id: string;
  provider_protocol: "openai-completions";
  model: string;
  max_output_tokens?: number;
  max_input_tokens?: number;
  max_cost?: {
    currency: "USD";
    amount: number;
    enforcement: "strict_pre_send" | "post_hoc_only";
  };
  deadline?: {
    epoch_ms: number;
  };
  max_calls?: number;
  retry_posture: "never" | "safe_pre_admission_only" | "caller_managed";
  fallback_posture: "forbid";
  price_schedule?: LlamaPriceScheduleV1;
}

export interface LlamaProviderCapabilitiesV1 {
  supports_max_output_tokens?: boolean;
  supports_token_counting?: boolean;
  estimated_input_tokens?: number;
  model_max_output_tokens?: number;
}

export interface LlamaExecutionAccessV1 {
  execution_id: string;
  execution_kind: "local_process" | "sandbox" | "container" | "remote_worker";
  network_access: "direct" | "routed_loopback" | "brokered" | "none";
}

export interface LlamaUsageEvidenceV1 {
  schema_version: 1;
  run_id: string;
  segment_id: string;
  model_call_id: string;
  evidence_stage: "delta" | "snapshot" | "final";
  sequence: number;
  provider: string;
  protocol: "openai-completions";
  model: string;
  usage_status: "known" | "partial" | "unknown";
  usage_source: "provider_final" | "unavailable";
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_source: "provider_reported" | "price_schedule" | "estimated_authorized" | "unavailable";
  missing_fields: string[];
  observed_at: string;
}

export interface LlamaRetryAfterObservationV1 {
  raw_header: string;
  format: "delta_seconds" | "http_date" | "retry_after_ms" | "unparseable";
  delay_ms: number | null;
}

export interface LlamaInferenceFaultV1 {
  schema_version: 1;
  category:
    | "rate_limited"
    | "quota_exhausted"
    | "auth_failed"
    | "permission_denied"
    | "provider_overloaded"
    | "provider_5xx"
    | "timeout"
    | "aborted"
    | "malformed_response"
    | "policy_violation"
    | "transport_failure";
  http_status: number | null;
  request_phase:
    | "pre_send"
    | "connect"
    | "request_sent"
    | "response_headers"
    | "streaming_body"
    | "post_stream";
  admission_certainty: "not_sent" | "unknown" | "admitted";
  retry_after: LlamaRetryAfterObservationV1 | null;
  terminal_for_segment: boolean;
  sanitized_message: string;
  provider_request_id: string | null;
}

export class LlamaInferenceFaultError extends Error {
  readonly fault: LlamaInferenceFaultV1;
  constructor(fault: LlamaInferenceFaultV1, cause?: unknown) {
    super(fault.sanitized_message, cause !== undefined ? { cause } : undefined);
    this.name = "LlamaInferenceFaultError";
    this.fault = fault;
  }
}

export interface LlamaInferenceOptions {
  policy?: LlamaInferencePolicyV1;
  capabilities?: LlamaProviderCapabilitiesV1;
  executionAccess?: LlamaExecutionAccessV1;
  modelCallId?: string;
  callIndex?: number;
  signal?: AbortSignal;
  now?: () => number;
  onUsageEvidence?: (evidence: LlamaUsageEvidenceV1) => void | Promise<void>;
  onFault?: (fault: LlamaInferenceFaultV1) => void | Promise<void>;
}

export interface LlamaChatCall {
  system?: string;
  prompt: string;
  model: string;
  json?: boolean;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
  inference?: LlamaInferenceOptions;
}

export function redactLlamaSensitiveText(input: string): string {
  if (!input) return "";
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/gi, "[REDACTED_API_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED_API_KEY]")
    .replace(
      /(["']?(?:x-api-key|api[_-]?key|authorization|secret|token|password)["']?\s*[:=]\s*["']?)([^"'\s,}]+)(["']?)/gi,
      "$1[REDACTED]$3",
    )
    .slice(0, 300);
}

export function parseLlamaRetryAfter(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  nowMs: number = Date.now(),
): LlamaRetryAfterObservationV1 | null {
  if (!headers) return null;
  const getHeader = (name: string): string | null => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name);
    }
    const record = headers as Record<string, string | undefined>;
    for (const [k, v] of Object.entries(record)) {
      if (k.toLowerCase() === name.toLowerCase() && typeof v === "string") {
        return v;
      }
    }
    return null;
  };

  const msRaw = getHeader("retry-after-ms");
  if (msRaw !== null && msRaw.trim() !== "") {
    const trimmed = msRaw.trim();
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return { raw_header: trimmed, format: "retry_after_ms", delay_ms: Math.ceil(parsed) };
    }
    return { raw_header: trimmed, format: "unparseable", delay_ms: null };
  }

  const raw = getHeader("retry-after");
  if (raw === null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { raw_header: trimmed, format: "delta_seconds", delay_ms: Math.ceil(seconds * 1000) };
    }
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return { raw_header: trimmed, format: "http_date", delay_ms: Math.max(0, dateMs - nowMs) };
  }
  return { raw_header: trimmed, format: "unparseable", delay_ms: null };
}

function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function classifyLlamaUsage(
  body: LlamaChatResponse,
  options?: {
    runId?: string;
    segmentId?: string;
    modelCallId?: string;
    model?: string;
    priceSchedule?: LlamaPriceScheduleV1;
    now?: () => Date;
  },
): LlamaUsageEvidenceV1 {
  const observedAt = (options?.now?.() ?? new Date()).toISOString();
  const model = body.model ?? options?.model ?? "unknown";
  const base = {
    schema_version: 1 as const,
    run_id: options?.runId ?? "unscoped-run",
    segment_id: options?.segmentId ?? "unscoped-segment",
    model_call_id: options?.modelCallId ?? body.id ?? "call-1",
    evidence_stage: "final" as const,
    sequence: 1,
    provider: "llamacpp",
    protocol: "openai-completions" as const,
    model,
    observed_at: observedAt,
  };

  if (!body.usage || typeof body.usage !== "object") {
    return {
      ...base,
      usage_status: "unknown",
      usage_source: "unavailable",
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
      cost_usd: null,
      cost_source: "unavailable",
      missing_fields: ["input_tokens", "output_tokens", "total_tokens"],
    };
  }

  const missing: string[] = [];
  let malformed = false;

  const rawPrompt = body.usage.prompt_tokens;
  const rawCompletion = body.usage.completion_tokens;
  const rawTotal = body.usage.total_tokens;
  const rawCached = body.usage.prompt_tokens_details?.cached_tokens;
  const rawReasoning = body.usage.completion_tokens_details?.reasoning_tokens;

  if (rawPrompt !== undefined && rawPrompt !== null && !isValidTokenCount(rawPrompt)) {
    malformed = true;
    missing.push("input_tokens");
  }
  if (rawCompletion !== undefined && rawCompletion !== null && !isValidTokenCount(rawCompletion)) {
    malformed = true;
    missing.push("output_tokens");
  }
  if (rawTotal !== undefined && rawTotal !== null && !isValidTokenCount(rawTotal)) {
    malformed = true;
    missing.push("total_tokens");
  }
  if (rawCached !== undefined && rawCached !== null && !isValidTokenCount(rawCached)) {
    malformed = true;
    missing.push("cache_read_tokens");
  }
  if (rawReasoning !== undefined && rawReasoning !== null && !isValidTokenCount(rawReasoning)) {
    malformed = true;
    missing.push("reasoning_tokens");
  }

  const promptTokens = isValidTokenCount(rawPrompt) ? rawPrompt : null;
  const completionTokens = isValidTokenCount(rawCompletion) ? rawCompletion : null;
  const cacheReadTokens = isValidTokenCount(rawCached) ? rawCached : null;
  const reasoningTokens = isValidTokenCount(rawReasoning) ? rawReasoning : null;

  // In OpenAI-compatible usage, prompt_tokens includes cached_tokens; non-cached input is
  // promptTokens - cacheReadTokens when cacheReadTokens is reported.
  const inputTokens =
    promptTokens !== null
      ? cacheReadTokens !== null
        ? Math.max(0, promptTokens - cacheReadTokens)
        : promptTokens
      : null;
  const outputTokens = completionTokens;

  if (inputTokens === null && !missing.includes("input_tokens")) missing.push("input_tokens");
  if (outputTokens === null && !missing.includes("output_tokens")) missing.push("output_tokens");

  const totalTokens =
    !malformed && isValidTokenCount(rawTotal)
      ? rawTotal
      : !malformed && promptTokens !== null && outputTokens !== null
        ? promptTokens + outputTokens
        : null;
  if (totalTokens === null && !missing.includes("total_tokens")) {
    missing.push("total_tokens");
  }

  const hasAny =
    inputTokens !== null ||
    outputTokens !== null ||
    cacheReadTokens !== null ||
    reasoningTokens !== null;
  const usageStatus: "known" | "partial" | "unknown" =
    inputTokens !== null && outputTokens !== null && !malformed
      ? "known"
      : hasAny
        ? "partial"
        : "unknown";

  let costUsd: number | null = null;
  let costSource: LlamaUsageEvidenceV1["cost_source"] = "unavailable";
  if (usageStatus === "known" && options?.priceSchedule) {
    const schedule = options.priceSchedule;
    const cacheReadOk =
      (cacheReadTokens ?? 0) === 0 || schedule.cache_read_cost_per_million !== undefined;
    const reasoningOk =
      (reasoningTokens ?? 0) === 0 || schedule.reasoning_cost_per_million !== undefined;
    if (cacheReadOk && reasoningOk) {
      costUsd =
        (inputTokens! * schedule.input_cost_per_million +
          outputTokens! * schedule.output_cost_per_million +
          (cacheReadTokens ?? 0) * (schedule.cache_read_cost_per_million ?? 0) +
          (reasoningTokens ?? 0) * (schedule.reasoning_cost_per_million ?? 0)) /
        1_000_000;
      costSource = "price_schedule";
    } else {
      missing.push("cost_usd");
    }
  }

  return {
    ...base,
    usage_status: usageStatus,
    usage_source: usageStatus === "unknown" ? "unavailable" : "provider_final",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: null,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    cost_source: costSource,
    missing_fields: missing,
  };
}

export function normalizeV1Url(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  if (base.endsWith("/v1")) {
    return `${base}/${trimmedPath}`;
  }
  return `${base}/v1/${trimmedPath}`;
}

function evaluateLlamaPreSend(
  call: LlamaChatCall,
  options?: LlamaInferenceOptions,
): { maxTokens?: number; timeoutMs: number } {
  const nowMs = options?.now?.() ?? Date.now();
  if (options?.executionAccess?.network_access === "none") {
    throw new LlamaInferenceFaultError({
      schema_version: 1,
      category: "policy_violation",
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: `Execution placement "${options.executionAccess.execution_id}" (${options.executionAccess.execution_kind}) has network_access="none" and cannot reach llama.cpp endpoint.`,
      provider_request_id: null,
    });
  }

  const policy = options?.policy;
  if (!policy) {
    return { maxTokens: call.maxTokens, timeoutMs: call.timeoutMs };
  }

  const failPolicy = (
    message: string,
    category: LlamaInferenceFaultV1["category"] = "policy_violation",
  ): never => {
    throw new LlamaInferenceFaultError({
      schema_version: 1,
      category,
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: redactLlamaSensitiveText(message),
      provider_request_id: null,
    });
  };

  if (policy.model !== call.model) {
    failPolicy(`Inference policy model "${policy.model}" does not match requested model "${call.model}".`);
  }

  if (policy.max_calls !== undefined) {
    const callIndex = options?.callIndex ?? 1;
    if (callIndex > policy.max_calls) {
      failPolicy(`Inference policy max_calls (${policy.max_calls}) exceeded at call ${callIndex}.`);
    }
  }

  let timeoutMs = call.timeoutMs;
  if (policy.deadline !== undefined) {
    const remaining = policy.deadline.epoch_ms - nowMs;
    if (remaining <= 0) {
      failPolicy(
        `Inference policy deadline (${policy.deadline.epoch_ms}) expired before dispatch (now=${nowMs}).`,
        "timeout",
      );
    }
    timeoutMs = Math.min(timeoutMs, remaining);
  }

  let maxTokens = call.maxTokens;
  if (policy.max_output_tokens !== undefined) {
    if (!Number.isInteger(policy.max_output_tokens) || policy.max_output_tokens <= 0) {
      failPolicy(`Inference policy max_output_tokens must be a positive integer.`);
    }
    if (options?.capabilities?.supports_max_output_tokens === false) {
      failPolicy(`Endpoint does not support max_output_tokens enforcement.`);
    }
    if (
      options?.capabilities?.model_max_output_tokens !== undefined &&
      policy.max_output_tokens > options.capabilities.model_max_output_tokens
    ) {
      failPolicy(
        `Inference policy max_output_tokens (${policy.max_output_tokens}) exceeds model ceiling (${options.capabilities.model_max_output_tokens}).`,
      );
    }
    maxTokens =
      maxTokens !== undefined
        ? Math.min(maxTokens, policy.max_output_tokens)
        : policy.max_output_tokens;
  }

  if (policy.max_input_tokens !== undefined) {
    const estimatedInput = options?.capabilities?.estimated_input_tokens;
    if (
      !options?.capabilities?.supports_token_counting ||
      estimatedInput === undefined
    ) {
      return failPolicy(
        `Inference policy specifies max_input_tokens (${policy.max_input_tokens}), but pre-send token counting is unavailable.`,
      );
    }
    if (estimatedInput > policy.max_input_tokens) {
      return failPolicy(
        `Estimated input tokens (${estimatedInput}) exceed policy max_input_tokens (${policy.max_input_tokens}).`,
      );
    }
  }

  if (policy.max_cost !== undefined && policy.max_cost.enforcement === "strict_pre_send") {
    const schedule = policy.price_schedule;
    if (!schedule) {
      return failPolicy(`Strict pre-send max_cost requires a retained price_schedule.`);
    }
    const boundInput = policy.max_input_tokens ?? options?.capabilities?.estimated_input_tokens;
    const boundOutput = policy.max_output_tokens;
    if (boundInput === undefined || boundOutput === undefined) {
      return failPolicy(`Strict pre-send max_cost requires bounded input tokens and max_output_tokens.`);
    }
    const maxCostUsd =
      (boundInput * schedule.input_cost_per_million +
        boundOutput * schedule.output_cost_per_million) /
      1_000_000;
    if (maxCostUsd > policy.max_cost.amount) {
      return failPolicy(
        `Pre-send upper-bound cost ($${maxCostUsd.toFixed(6)}) exceeds strict max_cost ($${policy.max_cost.amount.toFixed(6)}).`,
      );
    }
  }

  return { maxTokens, timeoutMs };
}

export async function llamaChat(endpoint: Endpoint, call: LlamaChatCall): Promise<LlamaChatResponse> {
  const nowFn = call.inference?.now ?? Date.now;
  const recordFault = async (fault: LlamaInferenceFaultV1): Promise<LlamaInferenceFaultV1> => {
    await call.inference?.onFault?.(fault);
    return fault;
  };

  let evaluated: { maxTokens?: number; timeoutMs: number };
  try {
    evaluated = evaluateLlamaPreSend(call, call.inference);
  } catch (err) {
    if (err instanceof LlamaInferenceFaultError) {
      await recordFault(err.fault);
    }
    throw err;
  }

  const url = normalizeV1Url(endpoint.baseUrl, "chat/completions");
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, evaluated.timeoutMs);

  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  if (call.inference?.signal) {
    if (call.inference.signal.aborted) {
      clearTimeout(timer);
      const fault = await recordFault({
        schema_version: 1,
        category: "aborted",
        http_status: null,
        request_phase: "pre_send",
        admission_certainty: "not_sent",
        retry_after: null,
        terminal_for_segment: true,
        sanitized_message: "llama.cpp request aborted before dispatch.",
        provider_request_id: null,
      });
      throw new LlamaInferenceFaultError(fault);
    }
    call.inference.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });

  let headersReceived = false;
  let observedStatus: number | null = null;
  let observedHeaders: Headers | undefined;

  try {
    const res = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: call.model,
          messages: [
            ...(call.system ? [{ role: "system", content: call.system }] : []),
            { role: "user", content: call.prompt },
          ],
          stream: false,
          ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
          ...(evaluated.maxTokens === undefined ? {} : { max_tokens: evaluated.maxTokens }),
          ...(call.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      }),
      timeout,
    ]);
    headersReceived = true;
    observedStatus = res.status;
    observedHeaders = res.headers;

    if (!res.ok) {
      let text = "";
      try {
        text = await Promise.race([res.text(), timeout]);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
      }
      const retryAfter = parseLlamaRetryAfter(res.headers, nowFn());
      const sanitizedBody = redactLlamaSensitiveText(text);

      if (res.status === 404) {
        const message = `llama.cpp: model "${call.model}" not found or endpoint not found at ${url}.`;
        const fault = await recordFault({
          schema_version: 1,
          category: "transport_failure",
          http_status: 404,
          request_phase: "response_headers",
          admission_certainty: "admitted",
          retry_after: retryAfter,
          terminal_for_segment: true,
          sanitized_message: message,
          provider_request_id: null,
        });
        throw Object.assign(new ModelUnavailableError(message), { fault, retryAfter });
      }

      if (res.status === 503) {
        const message = `llama.cpp: server is busy or loading model (${sanitizedBody.slice(0, 100)}).`;
        const fault = await recordFault({
          schema_version: 1,
          category: "provider_5xx",
          http_status: 503,
          request_phase: "response_headers",
          admission_certainty: "admitted",
          retry_after: retryAfter,
          terminal_for_segment: false,
          sanitized_message: message,
          provider_request_id: null,
        });
        throw Object.assign(new ModelUnavailableError(message), { fault, retryAfter });
      }

      const category: LlamaInferenceFaultV1["category"] =
        res.status === 401
          ? "auth_failed"
          : res.status === 403
            ? "permission_denied"
            : res.status === 429
              ? "rate_limited"
              : res.status === 529
                ? "provider_overloaded"
                : res.status >= 500
                  ? "provider_5xx"
                  : "transport_failure";

      const message = `HTTP ${res.status} from ${url}: ${sanitizedBody.slice(0, 200)}`;
      const fault = await recordFault({
        schema_version: 1,
        category,
        http_status: res.status,
        request_phase: "response_headers",
        admission_certainty: "admitted",
        retry_after: retryAfter,
        terminal_for_segment: res.status === 401 || res.status === 403,
        sanitized_message: message,
        provider_request_id: null,
      });
      if (res.status === 401 || res.status === 403) {
        throw Object.assign(new ModelUnavailableError(message), { fault, retryAfter });
      }
      throw Object.assign(new Error(message), { fault, retryAfter });
    }

    let parsed: LlamaChatResponse;
    try {
      parsed = await Promise.race([res.json() as Promise<LlamaChatResponse>, timeout]);
    } catch (jsonErr) {
      if (controller.signal.aborted || (jsonErr instanceof Error && jsonErr.name === "AbortError")) {
        throw jsonErr;
      }
      const fault = await recordFault({
        schema_version: 1,
        category: "malformed_response",
        http_status: res.status,
        request_phase: "post_stream",
        admission_certainty: "admitted",
        retry_after: null,
        terminal_for_segment: false,
        sanitized_message: `Malformed JSON response from ${url}: ${redactLlamaSensitiveText(
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
        )}`,
        provider_request_id: null,
      });
      throw new LlamaInferenceFaultError(fault, jsonErr);
    }

    if (call.inference?.onUsageEvidence || call.inference?.policy) {
      const evidence = classifyLlamaUsage(parsed, {
        runId: call.inference.policy?.run_id,
        segmentId: call.inference.policy?.segment_id,
        modelCallId: call.inference.modelCallId,
        model: call.model,
        priceSchedule: call.inference.policy?.price_schedule,
        now: () => new Date(nowFn()),
      });
      await call.inference.onUsageEvidence?.(evidence);
    }

    return parsed;
  } catch (err) {
    if (err instanceof LlamaInferenceFaultError || err instanceof ModelUnavailableError) {
      throw err;
    }
    if ((err as { fault?: LlamaInferenceFaultV1 })?.fault) {
      throw err;
    }
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      const sanitized = redactLlamaSensitiveText(
        describeFetchFailure(err, url, evaluated.timeoutMs),
      );
      const fault = await recordFault({
        schema_version: 1,
        category: callerAborted && !timedOut ? "aborted" : "timeout",
        http_status: observedStatus,
        request_phase: headersReceived ? "streaming_body" : "request_sent",
        admission_certainty: headersReceived ? "admitted" : "unknown",
        retry_after: parseLlamaRetryAfter(observedHeaders, nowFn()),
        terminal_for_segment: callerAborted && !timedOut,
        sanitized_message: sanitized,
        provider_request_id: null,
      });
      throw Object.assign(new ModelUnavailableError(sanitized, err), { fault });
    }
    if (headersReceived) throw err;
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const isConnectFailure =
      code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH";
    const sanitized = redactLlamaSensitiveText(
      describeFetchFailure(err, url, evaluated.timeoutMs),
    );
    const fault = await recordFault({
      schema_version: 1,
      category: "transport_failure",
      http_status: null,
      request_phase: isConnectFailure ? "connect" : "request_sent",
      admission_certainty: "unknown",
      retry_after: null,
      terminal_for_segment: false,
      sanitized_message: sanitized,
      provider_request_id: null,
    });
    throw Object.assign(new ModelUnavailableError(sanitized, err), { fault });
  } finally {
    clearTimeout(timer);
    if (call.inference?.signal) {
      call.inference.signal.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function usageOf(body: LlamaChatResponse): { usage?: TokenUsage } {
  const evidence = classifyLlamaUsage(body);
  if (
    evidence.usage_status !== "known" ||
    evidence.input_tokens === null ||
    evidence.output_tokens === null
  ) {
    return {};
  }
  const rawTotal =
    body.usage && isValidTokenCount(body.usage.total_tokens)
      ? body.usage.total_tokens
      : undefined;
  return {
    usage: {
      inputTokens: evidence.input_tokens,
      outputTokens: evidence.output_tokens,
      totalTokens: rawTotal,
      ...(evidence.cache_read_tokens !== null
        ? { cacheReadTokens: evidence.cache_read_tokens }
        : {}),
    },
  };
}

export function llamacppCompletionModel(
  model: string,
  endpoint: Endpoint,
  inference?: LlamaInferenceOptions,
): CompletionModel {
  let callCounter = 0;
  return {
    ref: `llamacpp/${model}`,
    structuredOutput: "native",
    async complete(request) {
      callCounter += 1;
      const body = await llamaChat(endpoint, {
        ...(request.system ? { system: request.system } : {}),
        prompt: request.prompt,
        model,
        json: request.schema !== undefined,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(inference
          ? {
              inference: {
                ...inference,
                callIndex: inference.callIndex ?? callCounter,
                modelCallId:
                  inference.modelCallId ??
                  (inference.policy
                    ? `${inference.policy.segment_id}:call-${callCounter}`
                    : `call-${callCounter}`),
              },
            }
          : {}),
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

