/**
 * Ollama's native API: `/api/chat`, `/api/embed`, `/api/tags`.
 *
 * The auxiliary path — one-shot answers and vectors. A coding session reaches
 * Ollama through its Anthropic-compatible API instead, via a harness.
 *
 * This is also the daemon transport the other kind packages reuse: one daemon
 * speaks three kinds, and two copies of a diagnostic-bearing transport mislead
 * independently — the reason `ollamaChat` and `usageOf` are exported rather
 * than copied into `adapters/decisions` and `adapters/embeddings`.
 */
import {
  ModelUnavailableError,
  type CompletionModel,
  type TokenUsage,
} from "@barry-rocks/sdk/adapters/models";
import type { Endpoint, ListedModel } from "@barry-rocks/sdk/adapters/models";
import { describeFetchFailure } from "@barry-rocks/sdk/http";

/**
 * Short by default: most callers are periodic jobs, so holding ~4GB of
 * weights between ticks is waste. A cold start costs ~3s for a small model
 * and far more for a large one under load, so a caller on a longer timer
 * sets `keepAliveMs` instead.
 */
export const KEEP_ALIVE = "60s";

/** Ollama's duration form for a request's keep-alive, whole seconds. */
function keepAlive(ms: number | undefined): string {
  return ms === undefined ? KEEP_ALIVE : `${Math.max(1, Math.ceil(ms / 1000))}s`;
}
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ChatResponse {
  message?: { content?: string };
  model?: string;
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number | null;
  eval_count?: number | null;
}

export interface OllamaPriceScheduleV1 {
  currency: "USD";
  input_cost_per_million: number;
  output_cost_per_million: number;
}

export interface OllamaInferencePolicyV1 {
  schema_version: 1;
  run_id: string;
  segment_id: string;
  provider_protocol: "ollama-chat";
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
  price_schedule?: OllamaPriceScheduleV1;
}

export interface OllamaProviderCapabilitiesV1 {
  supports_max_output_tokens?: boolean;
  supports_token_counting?: boolean;
  estimated_input_tokens?: number;
  model_max_output_tokens?: number;
}

export interface OllamaExecutionAccessV1 {
  execution_id: string;
  execution_kind: "local_process" | "sandbox" | "container" | "remote_worker";
  network_access: "direct" | "routed_loopback" | "brokered" | "none";
}

export interface OllamaUsageEvidenceV1 {
  schema_version: 1;
  run_id: string;
  segment_id: string;
  model_call_id: string;
  evidence_stage: "delta" | "snapshot" | "final";
  sequence: number;
  provider: string;
  protocol: "ollama-chat";
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

export interface OllamaRetryAfterObservationV1 {
  raw_header: string;
  format: "delta_seconds" | "http_date" | "retry_after_ms" | "unparseable";
  delay_ms: number | null;
}

export interface OllamaInferenceFaultV1 {
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
  retry_after: OllamaRetryAfterObservationV1 | null;
  terminal_for_segment: boolean;
  sanitized_message: string;
  provider_request_id: string | null;
}

export class OllamaInferenceFaultError extends Error {
  readonly fault: OllamaInferenceFaultV1;
  constructor(fault: OllamaInferenceFaultV1, cause?: unknown) {
    super(fault.sanitized_message, cause !== undefined ? { cause } : undefined);
    this.name = "OllamaInferenceFaultError";
    this.fault = fault;
  }
}

export interface OllamaInferenceOptions {
  policy?: OllamaInferencePolicyV1;
  capabilities?: OllamaProviderCapabilitiesV1;
  executionAccess?: OllamaExecutionAccessV1;
  modelCallId?: string;
  callIndex?: number;
  signal?: AbortSignal;
  now?: () => number;
  onUsageEvidence?: (evidence: OllamaUsageEvidenceV1) => void | Promise<void>;
  onFault?: (fault: OllamaInferenceFaultV1) => void | Promise<void>;
}

export function redactOllamaSensitiveText(input: string): string {
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

export function parseOllamaRetryAfter(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  nowMs: number = Date.now(),
): OllamaRetryAfterObservationV1 | null {
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

export function classifyOllamaUsage(
  body: ChatResponse,
  options?: {
    runId?: string;
    segmentId?: string;
    modelCallId?: string;
    model?: string;
    priceSchedule?: OllamaPriceScheduleV1;
    now?: () => Date;
  },
): OllamaUsageEvidenceV1 {
  const observedAt = (options?.now?.() ?? new Date()).toISOString();
  const model = body.model ?? options?.model ?? "unknown";
  const missing: string[] = [];
  let malformed = false;

  if (
    body.prompt_eval_count !== undefined &&
    body.prompt_eval_count !== null &&
    !isValidTokenCount(body.prompt_eval_count)
  ) {
    malformed = true;
    missing.push("input_tokens");
  }
  if (
    body.eval_count !== undefined &&
    body.eval_count !== null &&
    !isValidTokenCount(body.eval_count)
  ) {
    malformed = true;
    missing.push("output_tokens");
  }

  const inputTokens = isValidTokenCount(body.prompt_eval_count)
    ? body.prompt_eval_count
    : null;
  const outputTokens = isValidTokenCount(body.eval_count)
    ? body.eval_count
    : null;

  if (inputTokens === null && !missing.includes("input_tokens")) {
    missing.push("input_tokens");
  }
  if (outputTokens === null && !missing.includes("output_tokens")) {
    missing.push("output_tokens");
  }

  const totalTokens =
    inputTokens !== null && outputTokens !== null && !malformed
      ? inputTokens + outputTokens
      : null;
  if (totalTokens === null) {
    missing.push("total_tokens");
  }

  const usageStatus: "known" | "partial" | "unknown" =
    inputTokens !== null && outputTokens !== null && !malformed
      ? "known"
      : inputTokens !== null || outputTokens !== null
        ? "partial"
        : "unknown";

  let costUsd: number | null = null;
  let costSource: OllamaUsageEvidenceV1["cost_source"] = "unavailable";
  if (usageStatus === "known" && options?.priceSchedule) {
    costUsd =
      (inputTokens! * options.priceSchedule.input_cost_per_million +
        outputTokens! * options.priceSchedule.output_cost_per_million) /
      1_000_000;
    costSource = "price_schedule";
  }

  return {
    schema_version: 1,
    run_id: options?.runId ?? "unscoped-run",
    segment_id: options?.segmentId ?? "unscoped-segment",
    model_call_id: options?.modelCallId ?? "call-1",
    evidence_stage: "final",
    sequence: 1,
    provider: "ollama",
    protocol: "ollama-chat",
    model,
    usage_status: usageStatus,
    usage_source: usageStatus === "unknown" ? "unavailable" : "provider_final",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    cost_source: costSource,
    missing_fields: missing,
    observed_at: observedAt,
  };
}

function evaluateOllamaPreSend(
  call: { model: string; maxTokens?: number; timeoutMs: number },
  options?: OllamaInferenceOptions,
): { maxTokens?: number; timeoutMs: number } {
  const nowMs = options?.now?.() ?? Date.now();
  if (options?.executionAccess?.network_access === "none") {
    throw new OllamaInferenceFaultError({
      schema_version: 1,
      category: "policy_violation",
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: `Execution placement "${options.executionAccess.execution_id}" (${options.executionAccess.execution_kind}) has network_access="none" and cannot reach Ollama endpoint.`,
      provider_request_id: null,
    });
  }

  const policy = options?.policy;
  if (!policy) {
    return { maxTokens: call.maxTokens, timeoutMs: call.timeoutMs };
  }

  const failPolicy = (
    message: string,
    category: OllamaInferenceFaultV1["category"] = "policy_violation",
  ): never => {
    throw new OllamaInferenceFaultError({
      schema_version: 1,
      category,
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: redactOllamaSensitiveText(message),
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
      failPolicy(`Endpoint does not support max_output_tokens (options.num_predict) enforcement.`);
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

export async function ollamaChat(
  endpoint: Endpoint,
  call: {
    system?: string;
    prompt: string;
    model: string;
    json: boolean;
    timeoutMs: number;
    temperature?: number;
    maxTokens?: number;
    keepAliveMs?: number;
    inference?: OllamaInferenceOptions;
  },
): Promise<ChatResponse> {
  const nowFn = call.inference?.now ?? Date.now;
  const recordFault = async (fault: OllamaInferenceFaultV1): Promise<OllamaInferenceFaultV1> => {
    await call.inference?.onFault?.(fault);
    return fault;
  };

  let evaluated: { maxTokens?: number; timeoutMs: number };
  try {
    evaluated = evaluateOllamaPreSend(call, call.inference);
  } catch (err) {
    if (err instanceof OllamaInferenceFaultError) {
      await recordFault(err.fault);
    }
    throw err;
  }

  const url = `${endpoint.baseUrl}/api/chat`;
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
        sanitized_message: "Ollama request aborted before dispatch.",
        provider_request_id: null,
      });
      throw new OllamaInferenceFaultError(fault);
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: call.model,
          messages: [
            ...(call.system ? [{ role: "system", content: call.system }] : []),
            { role: "user", content: call.prompt },
          ],
          stream: false,
          // qwen3 emits <think> blocks by default; they add latency and would
          // otherwise land inside the answer text.
          think: false,
          ...(call.json ? { format: "json" } : {}),
          keep_alive: keepAlive(call.keepAliveMs),
          options: {
            ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
            ...(evaluated.maxTokens === undefined ? {} : { num_predict: evaluated.maxTokens }),
          },
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
      const retryAfter = parseOllamaRetryAfter(res.headers, nowFn());
      const sanitizedSnippet = redactOllamaSensitiveText(text.slice(0, 200));

      // A missing model is a setup problem, not a transient one — reported as
      // unavailable so a sweep stops instead of failing item by item.
      if (res.status === 404) {
        const message = `Ollama: model "${call.model}" is not pulled — run \`ollama pull ${call.model}\`.`;
        await recordFault({
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
        throw new ModelUnavailableError(message);
      }

      const category: OllamaInferenceFaultV1["category"] =
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

      const message = `HTTP ${res.status} from ${url}: ${sanitizedSnippet}`;
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
      throw Object.assign(new Error(message), { fault, retryAfter });
    }

    let parsed: ChatResponse;
    try {
      parsed = await Promise.race([res.json() as Promise<ChatResponse>, timeout]);
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
        sanitized_message: `Malformed JSON response from ${url}: ${redactOllamaSensitiveText(
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
        )}`,
        provider_request_id: null,
      });
      throw new OllamaInferenceFaultError(fault, jsonErr);
    }

    if (call.inference?.onUsageEvidence || call.inference?.policy) {
      const evidence = classifyOllamaUsage(parsed, {
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
    if (err instanceof OllamaInferenceFaultError || err instanceof ModelUnavailableError) {
      throw err;
    }
    if ((err as { fault?: OllamaInferenceFaultV1 })?.fault) {
      throw err;
    }
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      const sanitized = redactOllamaSensitiveText(
        describeFetchFailure(err, url, evaluated.timeoutMs),
      );
      const fault = await recordFault({
        schema_version: 1,
        category: callerAborted && !timedOut ? "aborted" : "timeout",
        http_status: observedStatus,
        request_phase: headersReceived ? "streaming_body" : "request_sent",
        admission_certainty: headersReceived ? "admitted" : "unknown",
        retry_after: parseOllamaRetryAfter(observedHeaders, nowFn()),
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
    const sanitized = redactOllamaSensitiveText(
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

export function usageOf(body: ChatResponse): { usage?: TokenUsage } {
  const evidence = classifyOllamaUsage(body);
  if (
    evidence.usage_status !== "known" ||
    evidence.input_tokens === null ||
    evidence.output_tokens === null
  ) {
    return {};
  }
  return {
    usage: {
      inputTokens: evidence.input_tokens,
      outputTokens: evidence.output_tokens,
    },
  };
}

export function ollamaCompletionModel(
  model: string,
  endpoint: Endpoint,
  inference?: OllamaInferenceOptions,
): CompletionModel {
  let callCounter = 0;
  return {
    ref: `ollama/${model}`,
    // Whether /api/chat honours a schema beyond `format: "json"` is
    // unmeasured; "native" would switch off the validate-and-retry net.
    structuredOutput: "prompted",
    async complete(request) {
      callCounter += 1;
      const body = await ollamaChat(endpoint, {
        ...(request.system ? { system: request.system } : {}),
        prompt: request.prompt,
        model,
        json: request.schema !== undefined,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.keepAliveMs === undefined ? {} : { keepAliveMs: request.keepAliveMs }),
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
      return { text: body.message?.content ?? "", servedModel: body.model ?? model, ...usageOf(body) };
    },
  };
}

/** What the daemon has pulled — the real catalog; the curated list is only a hint. */
export async function listPulled(endpoint: Endpoint): Promise<ListedModel[]> {
  try {
    const res = await fetch(`${endpoint.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new ModelUnavailableError(`Ollama: /api/tags returned HTTP ${res.status}.`);
    const body = (await res.json()) as {
      models?: Array<{ name?: string; size?: number; details?: { parameter_size?: string } }>;
    };
    return (body.models ?? []).flatMap((m) =>
      typeof m.name === "string"
        ? [
            {
              id: m.name,
              ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
              ...(m.size === undefined ? {} : { sizeBytes: m.size }),
            },
          ]
        : [],
    );
  } catch (err) {
    if (err instanceof ModelUnavailableError) throw err;
    throw new ModelUnavailableError(`Ollama unreachable at ${endpoint.baseUrl} (is \`ollama serve\` running?)`, err);
  }
}

