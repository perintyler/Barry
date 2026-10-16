import { describe, expect, it } from "vitest";
import {
  classifyInferenceFault,
  parseRetryAfterHeader,
  redactSensitiveText,
} from "./inference-fault.js";
import { InferencePolicyViolationError } from "./inference-bounds.js";

describe("InferenceFaultV1 classification, Retry-After parsing, and secret redaction", () => {
  it("parses Retry-After in delta-seconds, HTTP-date, retry-after-ms, and unparseable forms", () => {
    const nowMs = Date.parse("2026-10-16T12:00:00.000Z");

    expect(parseRetryAfterHeader({ "retry-after": "15" }, nowMs)).toEqual({
      source: "retry-after-seconds",
      delay_ms: 15_000,
      retry_at_epoch_ms: nowMs + 15_000,
    });

    expect(
      parseRetryAfterHeader({ "Retry-After": "Fri, 16 Oct 2026 12:00:45 GMT" }, nowMs),
    ).toEqual({
      source: "retry-after-http-date",
      delay_ms: 45_000,
      retry_at_epoch_ms: nowMs + 45_000,
    });

    expect(parseRetryAfterHeader({ "retry-after-ms": "2750" }, nowMs)).toEqual({
      source: "retry-after-ms",
      delay_ms: 2_750,
      retry_at_epoch_ms: nowMs + 2_750,
    });

    expect(parseRetryAfterHeader({ "retry-after": "not-a-date-or-number" }, nowMs)).toBeNull();
  });

  it("classifies 401, 403, 429 rate limit, 503, and 529 overloaded", () => {
    const nowMs = 1_700_000_000_000;

    const f401 = classifyInferenceFault({
      error: new Error("401 Unauthorized"),
      status: 401,
      requestPhase: "after_headers",
      nowMs,
    });
    expect(f401.category).toBe("auth_rejected");
    expect(f401.retryable_by_policy).toBe(false);
    expect(f401.safe_to_reschedule).toBe(false);
    expect(f401.admission_certainty).toBe("acknowledged");

    const f403 = classifyInferenceFault({
      error: new Error("403 Forbidden"),
      status: 403,
      requestPhase: "after_headers",
      nowMs,
    });
    expect(f403.category).toBe("forbidden");
    expect(f403.safe_to_reschedule).toBe(false);

    const f429Rate = classifyInferenceFault({
      error: new Error("429 Too Many Requests: rate limit reached"),
      status: 429,
      headers: { "retry-after": "8" },
      requestPhase: "after_headers",
      nowMs,
    });
    expect(f429Rate.category).toBe("rate_limited");
    expect(f429Rate.retryable_by_policy).toBe(false);
    expect(f429Rate.safe_to_reschedule).toBe(true);
    expect(f429Rate.retry_after).toEqual({
      source: "retry-after-seconds",
      delay_ms: 8_000,
      retry_at_epoch_ms: nowMs + 8_000,
    });

    const f529 = classifyInferenceFault({
      error: new Error("529 Overloaded"),
      status: 529,
      requestPhase: "after_headers",
      nowMs,
    });
    expect(f529.category).toBe("provider_overloaded");
    expect(f529.safe_to_reschedule).toBe(true);

    const f503 = classifyInferenceFault({
      error: new Error("503 Service Unavailable"),
      status: 503,
      requestPhase: "after_headers",
      nowMs,
    });
    expect(f503.category).toBe("provider_5xx");
    expect(f503.safe_to_reschedule).toBe(false);
  });

  it("distinguishes pre_send, before_headers, and midstream phases and admission certainty", () => {
    const policyErr = new InferencePolicyViolationError(
      "unsupported_input_token_limit",
      "Tokenizer unavailable",
    );
    const fPolicy = classifyInferenceFault({ error: policyErr });
    expect(fPolicy.category).toBe("policy_refused");
    expect(fPolicy.refusal_code).toBe("unsupported_input_token_limit");
    expect(fPolicy.request_phase).toBe("pre_send");
    expect(fPolicy.admission_certainty).toBe("not_sent");
    expect(fPolicy.safe_to_reschedule).toBe(true);

    const connRefused = new Error("fetch failed: ECONNREFUSED");
    const fConn = classifyInferenceFault({
      error: connRefused,
      requestPhase: "before_headers",
    });
    expect(fConn.category).toBe("transport_unreachable");
    expect(fConn.request_phase).toBe("before_headers");
    expect(fConn.admission_certainty).toBe("possibly_sent");
    expect(fConn.safe_to_reschedule).toBe(false);

    const streamTruncated = classifyInferenceFault({
      error: new Error("terminated: premature close"),
      requestPhase: "midstream",
      admissionCertainty: "acknowledged",
    });
    expect(streamTruncated.category).toBe("stream_truncated");
    expect(streamTruncated.request_phase).toBe("midstream");
    expect(streamTruncated.admission_certainty).toBe("acknowledged");
    expect(streamTruncated.safe_to_reschedule).toBe(false);
  });

  it("redacts API keys, Bearer tokens, and authorization secrets from fault messages", () => {
    const raw =
      'Request failed with Authorization: Bearer sk-ant-api03-SECRETKEY999888777 and x-api-key="sk-proj-1234567890abcdef"';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain("sk-ant-api03-SECRETKEY999888777");
    expect(redacted).not.toContain("sk-proj-1234567890abcdef");
    expect(redacted).toContain("[REDACTED]");

    const fault = classifyInferenceFault({
      error: new Error(raw),
      status: 401,
      requestPhase: "after_headers",
    });
    expect(fault.public_message).not.toContain("sk-ant-api03-SECRETKEY999888777");
    expect(fault.public_message).not.toContain("sk-proj-1234567890abcdef");
  });
});
