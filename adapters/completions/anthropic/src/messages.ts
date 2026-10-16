/**
 * The Anthropic Messages API over plain HTTP, rather than through
 * `@anthropic-ai/sdk`: every caller today is a background job, and a vendor SDK
 * here would recreate the weight that once kept bookkeeping on a private
 * transport of its own.
 */
import {
  ModelUnavailableError,
  type CompletionModel,
  type TokenUsage,
} from "@barry-rocks/sdk/adapters/models";
import type { Endpoint } from "@barry-rocks/sdk/adapters/models";
import { describeFetchFailure } from "@barry-rocks/sdk/http";

const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface MessagesUsageBlock {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface MessagesResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: MessagesUsageBlock | null;
}

export interface AnthropicPriceScheduleV1 {
  currency: "USD";
  input_cost_per_million: number;
  output_cost_per_million: number;
  cache_read_cost_per_million?: number;
  cache_write_cost_per_million?: number;
}

export interface AnthropicInferencePolicyV1 {
  schema_version: 1;
  run_id: string;
  segment_id: string;
  provider_protocol: "anthropic-messages";
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
  price_schedule?: AnthropicPriceScheduleV1;
}

export interface AnthropicProviderCapabilitiesV1 {
  supports_max_output_tokens?: boolean;
  supports_token_counting?: boolean;
  estimated_input_tokens?: number;
  model_max_output_tokens?: number;
}

export interface AnthropicExecutionAccessV1 {
  execution_id: string;
  execution_kind: "local_process" | "sandbox" | "container" | "remote_worker";
  network_access: "direct" | "routed_loopback" | "brokered" | "none";
}

export interface AnthropicUsageEvidenceV1 {
  schema_version: 1;
  run_id: string;
  segment_id: string;
  model_call_id: string;
  evidence_stage: "delta" | "snapshot" | "final";
  sequence: number;
  provider: string;
  protocol: "anthropic-messages";
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

export interface AnthropicRetryAfterObservationV1 {
  raw_header: string;
  format: "delta_seconds" | "http_date" | "retry_after_ms" | "unparseable";
  delay_ms: number | null;
}

export interface AnthropicInferenceFaultV1 {
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
  retry_after: AnthropicRetryAfterObservationV1 | null;
   terminal_for_segment: boolean;
  sanitized_message: string;
  provider_request_id: string | null;
}

export class AnthropicInferenceFaultError extends Error {
  readonly fault: AnthropicInferenceFaultV1;
  constructor(fault: AnthropicInferenceFaultV1, cause?: unknown) {
    super(fault.sanitized_message, cause !== undefined ? { cause } : undefined);
    this.name = "AnthropicInferenceFaultError";
    this.fault = fault;
  }
}

export interface AnthropicInferenceOptions {
  policy?: AnthropicInferencePolicyV1;
  capabilities?: AnthropicProviderCapabilitiesV1;
  executionAccess?: AnthropicExecutionAccessV1;
  modelCallId?: string;
  callIndex?: number;
  signal?: AbortSignal;
  now?: () => number;
  onUsageEvidence?: (evidence: AnthropicUsageEvidenceV1) => void | Promise<void>;
  onFault?: (fault: AnthropicInferenceFaultV1) => void | Promise<void>;
}

export function redactAnthropicSensitiveText(input: string): string {
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

export function parseAnthropicRetryAfter(
  headers: Headers | Record<string, string | undefined> | null | undefined,
  nowMs: number = Date.now(),
): AnthropicRetryAfterObservationV1 | null {
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

export function classifyMessagesUsage(
  body: MessagesResponse,
  options?: {
    runId?: string;
    segmentId?: string;
    modelCallId?: string;
    model?: string;
    priceSchedule?: AnthropicPriceScheduleV1;
    now?: () => Date;
  },
): AnthropicUsageEvidenceV1 {
  const observedAt = (options?.now?.() ?? new Date()).toISOString();
  const model = body.model ?? options?.model ?? "unknown";
  const base = {
    schema_version: 1 as const,
    run_id: options?.runId ?? "unscoped-run",
    segment_id: options?.segmentId ?? "unscoped-segment",
    model_call_id: options?.modelCallId ?? body.id ?? "call-1",
    evidence_stage: "final" as const,
    sequence: 1,
    provider: "anthropic",
    protocol: "anthropic-messages" as const,
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
  const rawInput = body.usage.input_tokens;
  const rawOutput = body.usage.output_tokens;
  const rawCacheRead = body.usage.cache_read_input_tokens;
  const rawCacheWrite = body.usage.cache_creation_input_tokens;

  let malformed = false;
  if (rawInput !== undefined && rawInput !== null && !isValidTokenCount(rawInput)) {
    malformed = true;
    missing.push("input_tokens");
  }
  if (rawOutput !== undefined && rawOutput !== null && !isValidTokenCount(rawOutput)) {
    malformed = true;
    missing.push("output_tokens");
  }
  if (rawCacheRead !== undefined && rawCacheRead !== null && !isValidTokenCount(rawCacheRead)) {
    malformed = true;
    missing.push("cache_read_tokens");
  }
  if (rawCacheWrite !== undefined && rawCacheWrite !== null && !isValidTokenCount(rawCacheWrite)) {
    malformed = true;
    missing.push("cache_write_tokens");
  }

  const inputTokens = isValidTokenCount(rawInput) ? rawInput : null;
  const outputTokens = isValidTokenCount(rawOutput) ? rawOutput : null;
  const cacheReadTokens = isValidTokenCount(rawCacheRead) ? rawCacheRead : null;
  const cacheWriteTokens = isValidTokenCount(rawCacheWrite) ? rawCacheWrite : null;

  if (inputTokens === null && !missing.includes("input_tokens")) missing.push("input_tokens");
  if (outputTokens === null && !missing.includes("output_tokens")) missing.push("output_tokens");

  // Anthropic reports input_tokens as non-cached input tokens; total tokens adds
  // input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens without double-counting.
  const totalTokens =
    inputTokens !== null && outputTokens !== null && !malformed
      ? inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
      : null;
  if (totalTokens === null) missing.push("total_tokens");

  const hasAny =
    inputTokens !== null ||
    outputTokens !== null ||
    cacheReadTokens !== null ||
    cacheWriteTokens !== null;
  const usageStatus: "known" | "partial" | "unknown" =
    inputTokens !== null && outputTokens !== null && !malformed
      ? "known"
      : hasAny
        ? "partial"
        : "unknown";

  let costUsd: number | null = null;
  let costSource: AnthropicUsageEvidenceV1["cost_source"] = "unavailable";
  if (usageStatus === "known" && options?.priceSchedule) {
    const schedule = options.priceSchedule;
    const cacheReadOk =
      (cacheReadTokens ?? 0) === 0 || schedule.cache_read_cost_per_million !== undefined;
    const cacheWriteOk =
      (cacheWriteTokens ?? 0) === 0 || schedule.cache_write_cost_per_million !== undefined;
    if (cacheReadOk && cacheWriteOk) {
      costUsd =
        (inputTokens! * schedule.input_cost_per_million +
          outputTokens! * schedule.output_cost_per_million +
          (cacheReadTokens ?? 0) * (schedule.cache_read_cost_per_million ?? 0) +
          (cacheWriteTokens ?? 0) * (schedule.cache_write_cost_per_million ?? 0)) /
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
    reasoning_tokens: null,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    cost_source: costSource,
    missing_fields: missing,
  };
}

export function usageOf(body: MessagesResponse): { usage?: TokenUsage } {
  const evidence = classifyMessagesUsage(body);
  if (evidence.usage_status !== "known" || evidence.input_tokens === null || evidence.output_tokens === null) {
    return {};
  }
  return {
    usage: {
      inputTokens: evidence.input_tokens,
      outputTokens: evidence.output_tokens,
      ...(evidence.cache_read_tokens !== null || evidence.cache_write_tokens !== null
        ? {
            totalTokens: evidence.total_tokens ?? undefined,
            ...(evidence.cache_read_tokens !== null
              ? { cacheReadTokens: evidence.cache_read_tokens }
              : {}),
            ...(evidence.cache_write_tokens !== null
              ? { cacheWriteTokens: evidence.cache_write_tokens }
              : {}),
          }
        : {}),
    },
  };
}

function evaluateAnthropicPreSend(
  call: { model: string; maxTokens: number; timeoutMs: number },
  options?: AnthropicInferenceOptions,
): { maxTokens: number; timeoutMs: number } {
  const nowMs = options?.now?.() ?? Date.now();
  if (options?.executionAccess?.network_access === "none") {
    throw new AnthropicInferenceFaultError({
      schema_version: 1,
      category: "policy_violation",
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: `Execution placement "${options.executionAccess.execution_id}" (${options.executionAccess.execution_kind}) has network_access="none" and cannot reach Anthropic inference endpoint.`,
      provider_request_id: null,
    });
  }

  const policy = options?.policy;
  if (!policy) {
    return { maxTokens: call.maxTokens, timeoutMs: call.timeoutMs };
  }

  const failPolicy = (message: string, category: AnthropicInferenceFaultV1["category"] = "policy_violation"): never => {
    throw new AnthropicInferenceFaultError({
      schema_version: 1,
      category,
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: redactAnthropicSensitiveText(message),
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
    maxTokens = Math.min(maxTokens, policy.max_output_tokens);
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
      return failPolicy(
        `Strict pre-send max_cost requires bounded input tokens and max_output_tokens.`,
      );
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

export async function send(
  endpoint: Endpoint,
  call: {
    system?: string;
    prompt: string;
    model: string;
    maxTokens: number;
    temperature?: number;
    timeoutMs: number;
    inference?: AnthropicInferenceOptions;
  },
): Promise<MessagesResponse> {
  const nowFn = call.inference?.now ?? Date.now;
  const recordFault = async (fault: AnthropicInferenceFaultV1): Promise<AnthropicInferenceFaultV1> => {
    await call.inference?.onFault?.(fault);
    return fault;
  };

  let evaluated: { maxTokens: number; timeoutMs: number };
  try {
    evaluated = evaluateAnthropicPreSend(call, call.inference);
  } catch (err) {
    if (err instanceof AnthropicInferenceFaultError) {
      await recordFault(err.fault);
    }
    throw err;
  }

  if (!endpoint.apiKey) {
    const msg =
      "Anthropic: ANTHROPIC_API_KEY is not set. Put the key in an identity's vault: " +
      "barry vault set-env ANTHROPIC_API_KEY <value> --source vault";
    await recordFault({
      schema_version: 1,
      category: "auth_failed",
      http_status: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retry_after: null,
      terminal_for_segment: true,
      sanitized_message: msg,
      provider_request_id: null,
    });
    throw new ModelUnavailableError(msg);
  }

  const url = `${endpoint.baseUrl}/v1/messages`;
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
        sanitized_message: "Anthropic request aborted before dispatch.",
        provider_request_id: null,
      });
      throw new AnthropicInferenceFaultError(fault);
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
          "x-api-key": endpoint.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: call.model,
          max_tokens: evaluated.maxTokens,
          ...(call.system ? { system: call.system } : {}),
          ...(call.temperature === undefined ? {} : { temperature: call.temperature }),
          messages: [{ role: "user", content: call.prompt }],
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
      const retryAfter = parseAnthropicRetryAfter(res.headers, nowFn());
      const requestId =
        typeof res.headers?.get === "function"
          ? res.headers.get("request-id") ?? res.headers.get("x-request-id")
          : null;
      const sanitizedSnippet = redactAnthropicSensitiveText(text.slice(0, 200));

      if (res.status === 401) {
        const message = "Anthropic: ANTHROPIC_API_KEY was rejected (401).";
        await recordFault({
          schema_version: 1,
          category: "auth_failed",
          http_status: 401,
          request_phase: "response_headers",
          admission_certainty: "admitted",
          retry_after: retryAfter,
          terminal_for_segment: true,
          sanitized_message: message,
          provider_request_id: requestId,
        });
        throw new ModelUnavailableError(message);
      }

      if (res.status === 403) {
        const message = `HTTP 403 from ${url}: ${sanitizedSnippet}`;
        await recordFault({
          schema_version: 1,
          category: "permission_denied",
          http_status: 403,
          request_phase: "response_headers",
          admission_certainty: "admitted",
          retry_after: retryAfter,
          terminal_for_segment: true,
          sanitized_message: message,
          provider_request_id: requestId,
        });
        throw new ModelUnavailableError(message);
      }

      const category: AnthropicInferenceFaultV1["category"] =
        res.status === 429
          ? /quota|insufficient|credit|billing/i.test(sanitizedSnippet)
            ? "quota_exhausted"
            : "rate_limited"
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
        terminal_for_segment: category === "quota_exhausted",
        sanitized_message: message,
        provider_request_id: requestId,
      });
      throw Object.assign(new Error(message), { fault, retryAfter });
    }

    let parsed: MessagesResponse;
    try {
      parsed = await Promise.race([res.json() as Promise<MessagesResponse>, timeout]);
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
        sanitized_message: `Malformed JSON response from ${url}: ${redactAnthropicSensitiveText(
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
        )}`,
        provider_request_id:
          typeof res.headers?.get === "function"
            ? res.headers.get("request-id") ?? res.headers.get("x-request-id")
            : null,
      });
      throw new AnthropicInferenceFaultError(fault, jsonErr);
    }

    if (call.inference?.onUsageEvidence || call.inference?.policy) {
      const evidence = classifyMessagesUsage(parsed, {
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
    if (err instanceof AnthropicInferenceFaultError || err instanceof ModelUnavailableError) {
      throw err;
    }
    if ((err as { fault?: AnthropicInferenceFaultV1 })?.fault) {
      throw err;
    }
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      const sanitized = redactAnthropicSensitiveText(
        describeFetchFailure(err, url, evaluated.timeoutMs),
      );
      const fault = await recordFault({
        schema_version: 1,
        category: callerAborted && !timedOut ? "aborted" : "timeout",
        http_status: observedStatus,
        request_phase: headersReceived ? "streaming_body" : "request_sent",
        admission_certainty: headersReceived ? "admitted" : "unknown",
        retry_after: parseAnthropicRetryAfter(observedHeaders, nowFn()),
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
    const sanitized = redactAnthropicSensitiveText(
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

export function textOf(body: MessagesResponse): string {
  return (body.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export function messagesCompletionModel(
  model: string,
  endpoint: Endpoint,
  inference?: AnthropicInferenceOptions,
): CompletionModel {
  let callCounter = 0;
  return {
    ref: `anthropic/${model}`,
    // The API can be steered to JSON, but no schema parameter is sent, so the
    // validate-and-retry fallback stays on until a dated live verification.
    structuredOutput: "prompted",
    async complete(request) {
      callCounter += 1;
      const body = await send(endpoint, {
        ...(request.system ? { system: request.system } : {}),
        prompt: request.prompt,
        model,
        maxTokens:
          request.maxTokens ??
          inference?.policy?.max_output_tokens ??
          DEFAULT_MAX_TOKENS,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
      return { text: textOf(body), servedModel: body.model ?? model, ...usageOf(body) };
    },
  };
}

