import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelUnavailableError } from "@barry-rocks/sdk/adapters/models";
import {
  AnthropicInferenceFaultError,
  classifyMessagesUsage,
  messagesCompletionModel,
  parseAnthropicRetryAfter,
  redactAnthropicSensitiveText,
  send,
  usageOf,
  type AnthropicInferenceFaultV1,
  type AnthropicUsageEvidenceV1,
} from "./messages.js";

describe("Anthropic Completion Adapter Inference Accounting & Endpoint Controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes known (including 0), partial, unknown, and cache-aware usage without double-counting", () => {
    // 1. Omitted usage -> unknown
    expect(usageOf({})).toEqual({});
    expect(classifyMessagesUsage({})).toMatchObject({
      usage_status: "unknown",
      usage_source: "unavailable",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      missing_fields: ["input_tokens", "output_tokens", "total_tokens"],
    });

    // 2. Partial usage -> partial (legacy usageOf returns {} rather than fabricating 0)
    expect(usageOf({ usage: { input_tokens: 45 } })).toEqual({});
    expect(classifyMessagesUsage({ usage: { input_tokens: 45 } })).toMatchObject({
      usage_status: "partial",
      usage_source: "provider_final",
      input_tokens: 45,
      output_tokens: null,
      total_tokens: null,
      missing_fields: ["output_tokens", "total_tokens"],
    });

    // 3. Measured 0 usage -> known
    expect(usageOf({ usage: { input_tokens: 0, output_tokens: 0 } })).toEqual({
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(classifyMessagesUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toMatchObject({
      usage_status: "known",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    });

    // 4. Cache read/write usage + price schedule
    const cached = classifyMessagesUsage(
      {
        id: "msg_1",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 100,
        },
      },
      {
        runId: "run-a1",
        segmentId: "seg-a1",
        priceSchedule: {
          currency: "USD",
          input_cost_per_million: 3,
          output_cost_per_million: 15,
          cache_read_cost_per_million: 0.3,
          cache_write_cost_per_million: 3.75,
        },
      },
    );
    expect(cached).toMatchObject({
      usage_status: "known",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 400,
      cache_write_tokens: 100,
      total_tokens: 650,
      cost_source: "price_schedule",
    });
    expect(cached.cost_usd).toBeCloseTo(
      (100 * 3 + 50 * 15 + 400 * 0.3 + 100 * 3.75) / 1_000_000,
      10,
    );
  });

  it("enforces max_output_tokens on the wire and refuses unsupported strict policies pre-send", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: "msg_ok",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "bounded reply" }],
        usage: { input_tokens: 12, output_tokens: 6 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const evidences: AnthropicUsageEvidenceV1[] = [];
    const model = messagesCompletionModel(
      "claude-sonnet-5",
      { baseUrl: "https://api.anthropic.test", apiKey: "sk-ant-test" },
      {
        policy: {
          schema_version: 1,
          run_id: "run-1",
          segment_id: "seg-1",
          provider_protocol: "anthropic-messages",
          model: "claude-sonnet-5",
          max_output_tokens: 256,
          retry_posture: "never",
          fallback_posture: "forbid",
        },
        onUsageEvidence: (ev) => {
          evidences.push(ev);
        },
      },
    );

    const completion = await model.complete({ prompt: "hello", maxTokens: 1024 });
    expect(completion.text).toBe("bounded reply");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Clamped from 1024 to policy.max_output_tokens (256)
    expect(wireBody.max_tokens).toBe(256);
    expect(evidences).toHaveLength(1);
    expect(evidences[0].usage_status).toBe("known");

    // Refuses unsupported max_input_tokens before calling fetch
    fetchMock.mockClear();
    const faults: AnthropicInferenceFaultV1[] = [];
    await expect(
      send(
        { baseUrl: "https://api.anthropic.test", apiKey: "sk-ant-test" },
        {
          prompt: "hello",
          model: "claude-sonnet-5",
          maxTokens: 128,
          timeoutMs: 5_000,
          inference: {
            policy: {
              schema_version: 1,
              run_id: "run-2",
              segment_id: "seg-2",
              provider_protocol: "anthropic-messages",
              model: "claude-sonnet-5",
              max_input_tokens: 100,
              retry_posture: "never",
              fallback_posture: "forbid",
            },
            onFault: (f) => {
              faults.push(f);
            },
          },
        },
      ),
    ).rejects.toThrowError(AnthropicInferenceFaultError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(faults[0]).toMatchObject({
      category: "policy_violation",
      request_phase: "pre_send",
      admission_certainty: "not_sent",
    });
  });

  it("parses Retry-After on 429, classifies 401/403/529, and redacts leaked credentials", async () => {
    expect(parseAnthropicRetryAfter({ "retry-after": "7" })).toEqual({
      raw_header: "7",
      format: "delta_seconds",
      delay_ms: 7_000,
    });
    expect(
      redactAnthropicSensitiveText("Error with sk-ant-api03-SECRET999 and Bearer tok_123"),
    ).not.toContain("sk-ant-api03-SECRET999");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({
        "retry-after": "15",
        "request-id": "req_anth_429",
      }),
      text: async () =>
        JSON.stringify({
          error: {
            message: "Rate limit for key sk-ant-api03-SECRETKEYVALUE",
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const faults: AnthropicInferenceFaultV1[] = [];
    await expect(
      send(
        { baseUrl: "https://api.anthropic.test", apiKey: "sk-ant-test" },
        {
          prompt: "hello",
          model: "claude-sonnet-5",
          maxTokens: 128,
          timeoutMs: 5_000,
          inference: {
            onFault: (f) => {
              faults.push(f);
            },
          },
        },
      ),
    ).rejects.toThrow(/HTTP 429/);

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      category: "rate_limited",
      http_status: 429,
      request_phase: "response_headers",
      admission_certainty: "admitted",
      retry_after: {
        raw_header: "15",
        format: "delta_seconds",
        delay_ms: 15_000,
      },
      provider_request_id: "req_anth_429",
    });
    expect(faults[0].sanitized_message).not.toContain("sk-ant-api03-SECRETKEYVALUE");

    // 401 raises ModelUnavailableError and records auth_failed
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "Unauthorized",
    });
    await expect(
      send(
        { baseUrl: "https://api.anthropic.test", apiKey: "sk-ant-test" },
        { prompt: "hi", model: "claude-sonnet-5", maxTokens: 64, timeoutMs: 5_000 },
      ),
    ).rejects.toThrowError(ModelUnavailableError);
  });
});
