import {
  type InferencePolicyRefusalCodeV1,
  InferencePolicyViolationError,
} from "./inference-bounds.js";

export type RequestPhaseV1 =
  | "pre_send"
  | "before_headers"
  | "after_headers"
  | "midstream"
  | "post_usage_before_ack";

export type AdmissionCertaintyV1 =
  | "not_sent"
  | "possibly_sent"
  | "acknowledged";

export type InferenceFaultCategoryV1 =
  | "policy_refused"
  | "auth_rejected"
  | "forbidden"
  | "rate_limited"
  | "provider_overloaded"
  | "provider_5xx"
  | "model_unavailable"
  | "context_length_exceeded"
  | "invalid_request"
  | "transport_unreachable"
  | "timeout"
  | "aborted"
  | "malformed_response"
  | "stream_truncated"
  | "reconciliation_conflict"
  | "provider_error";

export interface RetryAfterObservationV1 {
  readonly source:
    | "retry-after-seconds"
    | "retry-after-http-date"
    | "retry-after-ms";
  readonly delay_ms: number;
  readonly retry_at_epoch_ms: number;
}

export interface InferenceFaultV1 {
  readonly schema: 1;
  readonly category: InferenceFaultCategoryV1;
  readonly status: number | null;
  readonly retry_after: RetryAfterObservationV1 | null;
  readonly request_phase: RequestPhaseV1;
  readonly admission_certainty: AdmissionCertaintyV1;
  /** Automatic adapter retry is always disabled under Work policy. */
  readonly retryable_by_policy: false;
  /**
   * True only when the call was definitely not admitted/executed (e.g.,
   * `pre_send` refusal or explicit `429` rate-limit rejection before execution).
   * False for any `before_headers` transport ambiguity, `midstream` failure,
   * or `post_usage_before_ack` fault.
   */
  readonly safe_to_reschedule: boolean;
  readonly refusal_code: InferencePolicyRefusalCodeV1 | null;
  readonly public_message: string;
}

export class InferenceClassifiedError extends Error {
  readonly fault: InferenceFaultV1;

  constructor(fault: InferenceFaultV1) {
    super(fault.public_message);
    this.name = "InferenceClassifiedError";
    this.fault = fault;
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{6,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bBasic\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:x-api-key|api[_-]?key|authorization|auth[_-]?token|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',;}{]+["']?/gi,
  /https?:\/\/[^/\s:@]+:[^/\s:@]+@[^\s/]+/gi,
];

const MAX_REDACTED_TEXT_LENGTH = 240;

export function redactSensitiveText(
  input: string,
  extraSecrets?: readonly string[],
): string {
  let sanitized = input;
  if (extraSecrets) {
    for (const secret of extraSecrets) {
      if (typeof secret === "string" && secret.trim().length >= 3) {
        sanitized = sanitized.split(secret).join("[REDACTED]");
        const trimmed = secret.trim();
        if (trimmed !== secret) {
          sanitized = sanitized.split(trimmed).join("[REDACTED]");
        }
      }
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized.length > MAX_REDACTED_TEXT_LENGTH) {
    return `${sanitized.slice(0, MAX_REDACTED_TEXT_LENGTH)}...`;
  }
  return sanitized;
}

function getHeaderCaseInsensitive(
  headers:
    | Headers
    | Record<string, string | readonly string[] | undefined | null>
    | undefined
    | null,
  targetName: string,
): string | null {
  if (!headers) return null;
  const lower = targetName.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    const val = (headers as Headers).get(targetName) ?? (headers as Headers).get(lower);
    return typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === "string" && v.trim().length > 0) {
        return v.trim();
      }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
        const first = v[0].trim();
        return first.length > 0 ? first : null;
      }
    }
  }
  return null;
}

export function parseRetryAfterHeader(
  headers:
    | Headers
    | Record<string, string | readonly string[] | undefined | null>
    | undefined
    | null,
  nowMs: number = Date.now(),
): RetryAfterObservationV1 | null {
  if (!headers) return null;

  const retryAfterMsRaw = getHeaderCaseInsensitive(headers, "retry-after-ms");
  if (retryAfterMsRaw !== null) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfterMsRaw)) {
      const ms = Math.ceil(Number.parseFloat(retryAfterMsRaw));
      if (Number.isSafeInteger(ms) && ms >= 0) {
        return {
          source: "retry-after-ms",
          delay_ms: ms,
          retry_at_epoch_ms: nowMs + ms,
        };
      }
    }
  }

  const retryAfterRaw = getHeaderCaseInsensitive(headers, "retry-after");
  if (retryAfterRaw === null) return null;

  // RFC 9110 §10.2.3: Retry-After is either delay-seconds (1*DIGIT) or HTTP-date
  if (/^\d+(?:\.\d+)?$/.test(retryAfterRaw)) {
    const seconds = Number.parseFloat(retryAfterRaw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const delayMs = Math.ceil(seconds * 1000);
      if (Number.isSafeInteger(delayMs)) {
        return {
          source: "retry-after-seconds",
          delay_ms: delayMs,
          retry_at_epoch_ms: nowMs + delayMs,
        };
      }
    }
    return null;
  }

  const parsedDateMs = Date.parse(retryAfterRaw);
  if (Number.isFinite(parsedDateMs) && parsedDateMs > 0) {
    const retryAtMs = Math.floor(parsedDateMs);
    const delayMs = Math.max(0, retryAtMs - nowMs);
    return {
      source: "retry-after-http-date",
      delay_ms: delayMs,
      retry_at_epoch_ms: retryAtMs,
    };
  }

  return null;
}

function extractStatusFromError(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  if (
    typeof obj.status === "number" &&
    Number.isInteger(obj.status) &&
    obj.status >= 100 &&
    obj.status <= 599
  ) {
    return obj.status;
  }
  if (
    typeof obj.statusCode === "number" &&
    Number.isInteger(obj.statusCode) &&
    obj.statusCode >= 100 &&
    obj.statusCode <= 599
  ) {
    return obj.statusCode;
  }
  const msg = typeof obj.message === "string" ? obj.message : "";
  const statusMatch =
    msg.match(/\bHTTP\s+(\d{3})\b/i) ??
    msg.match(/^(\d{3})\s+\b/) ??
    msg.match(/\((\d{3})\)/);
  if (statusMatch) {
    const code = Number.parseInt(statusMatch[1]!, 10);
    if (code >= 400 && code <= 599) {
      return code;
    }
  }
  return null;
}

function extractHeadersFromError(
  error: unknown,
): Headers | Record<string, string> | null {
  if (!error || typeof error !== "object") return null;
  const obj = error as Record<string, unknown>;
  if (obj.headers instanceof Headers) {
    return obj.headers;
  }
  if (
    obj.headers &&
    typeof obj.headers === "object" &&
    !Array.isArray(obj.headers)
  ) {
    return obj.headers as Record<string, string>;
  }
  return null;
}

function deriveAdmissionCertainty(
  phase: RequestPhaseV1,
  explicitCertainty?: AdmissionCertaintyV1,
): AdmissionCertaintyV1 {
  if (explicitCertainty) return explicitCertainty;
  switch (phase) {
    case "pre_send":
      return "not_sent";
    case "before_headers":
      return "possibly_sent";
    case "after_headers":
    case "midstream":
    case "post_usage_before_ack":
      return "acknowledged";
  }
}

function buildPublicFaultMessage(
  category: InferenceFaultCategoryV1,
  status: number | null,
  phase: RequestPhaseV1,
  refusalCode: InferencePolicyRefusalCodeV1 | null,
  retryAfter: RetryAfterObservationV1 | null,
): string {
  const statusSuffix = status !== null ? ` (HTTP ${status})` : "";
  const retrySuffix =
    retryAfter !== null ? ` [retry_after_ms=${retryAfter.delay_ms}]` : "";
  switch (category) {
    case "policy_refused":
      return `Inference refused before send: ${refusalCode ?? "invalid_policy"} (phase=${phase})`;
    case "auth_rejected":
      return `Inference authentication rejected${statusSuffix} (phase=${phase})`;
    case "forbidden":
      return `Inference access forbidden${statusSuffix} (phase=${phase})`;
    case "rate_limited":
      return `Inference endpoint rate-limited${statusSuffix}${retrySuffix} (phase=${phase})`;
    case "provider_overloaded":
      return `Inference provider overloaded${statusSuffix}${retrySuffix} (phase=${phase})`;
    case "provider_5xx":
      return `Inference provider server error${statusSuffix}${retrySuffix} (phase=${phase})`;
    case "model_unavailable":
      return `Inference model or endpoint route unavailable${statusSuffix} (phase=${phase})`;
    case "context_length_exceeded":
      return `Inference input exceeded provider context length${statusSuffix} (phase=${phase})`;
    case "invalid_request":
      return `Inference request rejected as invalid${statusSuffix} (phase=${phase})`;
    case "transport_unreachable":
      return `Inference endpoint unreachable before response headers (phase=${phase})`;
    case "timeout":
      return `Inference deadline or request timeout exceeded (phase=${phase})`;
    case "aborted":
      return `Inference cancelled by execution signal (phase=${phase})`;
    case "malformed_response":
      return `Inference provider returned malformed response payload (phase=${phase})`;
    case "stream_truncated":
      return `Inference response stream terminated before completion (phase=${phase})`;
    case "reconciliation_conflict":
      return `Inference usage accounting conflict during reconciliation (phase=${phase})`;
    case "provider_error":
      return `Inference provider error${statusSuffix} (phase=${phase})`;
  }
}

export interface ClassifyInferenceFaultInput {
  readonly error?: unknown;
  readonly errorMessage?: string;
  readonly status?: number | null;
  readonly headers?:
    | Headers
    | Record<string, string | readonly string[] | undefined | null>
    | null;
  readonly requestPhase?: RequestPhaseV1;
  readonly admissionCertainty?: AdmissionCertaintyV1;
  readonly aborted?: boolean;
  readonly deadlineExpired?: boolean;
  readonly nowMs?: number;
}

export function classifyInferenceFault(
  input: ClassifyInferenceFaultInput,
): InferenceFaultV1 {
  const err = input.error;
  if (err instanceof InferenceClassifiedError) {
    return err.fault;
  }

  if (err instanceof InferencePolicyViolationError) {
    const publicMessage = buildPublicFaultMessage(
      "policy_refused",
      null,
      "pre_send",
      err.code,
      null,
    );
    return {
      schema: 1,
      category: "policy_refused",
      status: null,
      retry_after: null,
      request_phase: "pre_send",
      admission_certainty: "not_sent",
      retryable_by_policy: false,
      safe_to_reschedule: true,
      refusal_code: err.code,
      public_message: publicMessage,
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const status = input.status ?? extractStatusFromError(err);
  const headers = input.headers ?? extractHeadersFromError(err);
  const retryAfter = parseRetryAfterHeader(headers, nowMs);

  let phase: RequestPhaseV1 =
    input.requestPhase ??
    (status !== null ? "after_headers" : "before_headers");

  const rawMsg =
    input.errorMessage ??
    (err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "");
  const lowerMsg = rawMsg.toLowerCase();
  const errName =
    err instanceof Error ? err.name.toLowerCase() : "";

  let category: InferenceFaultCategoryV1 = "provider_error";

  if (input.deadlineExpired || lowerMsg.includes("timed out") || lowerMsg.includes("timeout") || errName === "timeouterror") {
    category = "timeout";
  } else if (
    input.aborted ||
    errName === "aborterror" ||
    lowerMsg.includes("request was aborted") ||
    lowerMsg.includes("request aborted") ||
    lowerMsg.includes("operation aborted")
  ) {
    category = "aborted";
  } else if (
    err &&
    typeof err === "object" &&
    (err as Error).name === "UsageSinkConflictError"
  ) {
    category = "reconciliation_conflict";
    phase = "post_usage_before_ack";
  } else if (status !== null) {
    if (status === 401) {
      category = "auth_rejected";
    } else if (status === 403) {
      category = "forbidden";
    } else if (status === 404) {
      category = "model_unavailable";
    } else if (status === 408 || status === 504) {
      category = "timeout";
    } else if (status === 413) {
      category = "context_length_exceeded";
    } else if (status === 429) {
      category = "rate_limited";
    } else if (status === 529) {
      category = "provider_overloaded";
    } else if (status >= 500 && status <= 599) {
      if (lowerMsg.includes("overload") || lowerMsg.includes("overloaded_error")) {
        category = "provider_overloaded";
      } else {
        category = "provider_5xx";
      }
    } else if (status === 400 || status === 422) {
      if (
        lowerMsg.includes("context_length") ||
        lowerMsg.includes("context length") ||
        lowerMsg.includes("maximum context") ||
        lowerMsg.includes("prompt is too long") ||
        lowerMsg.includes("too many tokens")
      ) {
        category = "context_length_exceeded";
      } else if (
        lowerMsg.includes("model_not_found") ||
        lowerMsg.includes("model not found") ||
        lowerMsg.includes("does not exist")
      ) {
        category = "model_unavailable";
      } else {
        category = "invalid_request";
      }
    }
  } else {
    // No HTTP status observed: inspect phase and transport/parse failure patterns
    if (
      lowerMsg.includes("no api key") ||
      lowerMsg.includes("unauthorized") ||
      lowerMsg.includes("authentication_error") ||
      lowerMsg.includes("invalid x-api-key") ||
      lowerMsg.includes("invalid api key")
    ) {
      category = "auth_rejected";
    } else if (
      lowerMsg.includes("rate_limit") ||
      lowerMsg.includes("rate limit") ||
      lowerMsg.includes("too many requests")
    ) {
      category = "rate_limited";
    } else if (
      lowerMsg.includes("overloaded_error") ||
      lowerMsg.includes("overloaded")
    ) {
      category = "provider_overloaded";
    } else if (
      lowerMsg.includes("could not parse") ||
      lowerMsg.includes("unexpected token") ||
      lowerMsg.includes("invalid json") ||
      lowerMsg.includes("json parse") ||
      err instanceof SyntaxError
    ) {
      category = "malformed_response";
      if (phase === "before_headers") {
        phase = "midstream";
      }
    } else if (
      lowerMsg.includes("stream ended without") ||
      lowerMsg.includes("ended before message_stop") ||
      lowerMsg.includes("without finish_reason") ||
      lowerMsg.includes("without a stop reason") ||
      lowerMsg.includes("premature close") ||
      lowerMsg.includes("terminated")
    ) {
      category = "stream_truncated";
      if (phase === "before_headers" || phase === "after_headers") {
        phase = "midstream";
      }
    } else if (
      phase === "before_headers" &&
      (lowerMsg.includes("fetch failed") ||
        lowerMsg.includes("econnrefused") ||
        lowerMsg.includes("enotfound") ||
        lowerMsg.includes("econnreset") ||
        lowerMsg.includes("socket hang up") ||
        lowerMsg.includes("networkerror") ||
        lowerMsg.includes("connection error"))
    ) {
      category = "transport_unreachable";
    }
  }

  const admissionCertainty = deriveAdmissionCertainty(
    phase,
    input.admissionCertainty,
  );

  // Only pre_send refusals or explicit HTTP 429 / 401 / 403 / 404 before midstream
  // are known not to have executed model work.
  const safeToReschedule =
    admissionCertainty === "not_sent" ||
    (phase === "after_headers" &&
      (category === "rate_limited" ||
        category === "provider_overloaded"));

  const publicMessage = buildPublicFaultMessage(
    category,
    status,
    phase,
    null,
    retryAfter,
  );

  return {
    schema: 1,
    category,
    status,
    retry_after: retryAfter,
    request_phase: phase,
    admission_certainty: admissionCertainty,
    retryable_by_policy: false,
    safe_to_reschedule: safeToReschedule,
    refusal_code: null,
    public_message: publicMessage,
  };
}
