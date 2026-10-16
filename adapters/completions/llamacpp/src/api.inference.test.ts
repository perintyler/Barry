import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelUnavailableError } from "@barry-rocks/sdk/adapters/models";
import {
  LlamaInferenceFaultError,
  classifyLlamaUsage,
  llamaChat,
  llamacppCompletionModel,
  usageOf,
  type LlamaInferenceFaultV1,
  type LlamaUsageEvidenceV1,
} from "./api.js";

describe("llama.cpp Completion Adapter Inference Accounting & Endpoint Controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes known (including 0), partial, unknown, cached, and reasoning usage without double-counting", () => {
    // 1. Omitted -> unknown
    expect(usageOf({})).toEqual({});
    expect(classifyLlamaUsage({})).toMatchObject({
      usage_status: "unknown",
      usage_source: "unavailable",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      missing_fields: ["input_tokens", "output_tokens", "total_tokens"],
    });

    // 2. Partial -> partial (usageOf returns {} rather than fabricating 0)
    expect(usageOf({ usage: { prompt_tokens: 25 } })).toEqual({});
    expect(classifyLlamaUsage({ usage: { prompt_tokens: 25 } })).toMatchObject({
      usage_status: "partial",
      usage_source: "provider_final",
      input_tokens: 25,
      output_tokens: null,
      total_tokens: null,
      missing_fields: ["output_tokens", "total_tokens"],
    });

    // 3. Measured 0 -> known
    expect(
      usageOf({
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    ).toEqual({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });

    // 4. Cached prompt tokens and reasoning tokens with price schedule
    const detailed = classifyLlamaUsage(
      {
        id: "chatcmpl-llama-1",
        model: "qwen-2.5-coder",
        usage: {
          prompt_tokens: 300,
          completion_tokens: 100,
          total_tokens: 400,
          prompt_tokens_details: { cached_tokens: 200 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      },
      {
        runId: "run-llama-1",
        segmentId: "seg-llama-1",
        priceSchedule: {
          currency: "USD",
          input_cost_per_million: 1.0,
          output_cost_per_million: 2.0,
          cache_read_cost_per_million: 0.1,
          reasoning_cost_per_million: 2.0,
        },
      },
    );
    expect(detailed).toMatchObject({
      usage_status: "known",
      input_tokens: 100, // 300 prompt_tokens - 200 cached_tokens
      cache_read_tokens: 200,
      output_tokens: 100,
      reasoning_tokens: 40,
      total_tokens: 400,
      cost_source: "price_schedule",
    });
  });

  it("projects policy.max_output_tokens onto max_tokens and enforces max_calls/executionAccess pre-send", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: "chatcmpl-1",
        model: "qwen-7b",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const evidences: LlamaUsageEvidenceV1[] = [];
    const model = llamacppCompletionModel(
      "qwen-7b",
      { baseUrl: "http://127.0.0.1:8080", apiKey: "llama-secret-token" },
      {
        executionAccess: {
          execution_id: "exec-remote-1",
          execution_kind: "remote_worker",
          network_access: "direct",
        },
        policy: {
          schema_version: 1,
          run_id: "run-llama-2",
          segment_id: "seg-llama-2",
          provider_protocol: "openai-completions",
          model: "qwen-7b",
          max_output_tokens: 128,
          max_calls: 1,
          retry_posture: "never",
          fallback_posture: "forbid",
        },
        onUsageEvidence: (ev) => {
          evidences.push(ev);
        },
      },
    );

    const res1 = await model.complete({ prompt: "first call", maxTokens: 1024 });
    expect(res1.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(wireBody.max_tokens).toBe(128);
    expect(evidences).toHaveLength(1);

    // Second call exceeds max_calls: 1 -> refused pre-send without calling fetch
    await expect(model.complete({ prompt: "second call" })).rejects.toThrowError(
      LlamaInferenceFaultError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies 503 busy/loading, 429 with Retry-After, and redacts sensitive tokens from errors", async () => {
    const faults: LlamaInferenceFaultV1[] = [];
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after-ms": "1500" }),
      text: async () => "Loading model with Bearer secret-llama-key-999",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      llamaChat(
        { baseUrl: "http://127.0.0.1:8080", apiKey: "secret-llama-key-999" },
        {
          prompt: "ping",
          model: "qwen-7b",
          timeoutMs: 5_000,
          inference: {
            onFault: (f) => {
              faults.push(f);
            },
          },
        },
      ),
    ).rejects.toThrowError(ModelUnavailableError);

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      category: "provider_5xx",
      http_status: 503,
      request_phase: "response_headers",
      admission_certainty: "admitted",
      retry_after: {
        raw_header: "1500",
        format: "retry_after_ms",
        delay_ms: 1_500,
      },
    });
    expect(faults[0].sanitized_message).not.toContain("secret-llama-key-999");
  });
});
