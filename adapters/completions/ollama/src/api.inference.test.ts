import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelUnavailableError } from "@barry-rocks/sdk/adapters/models";
import {
  OllamaInferenceFaultError,
  classifyOllamaUsage,
  ollamaChat,
  ollamaCompletionModel,
  usageOf,
  type OllamaInferenceFaultV1,
  type OllamaUsageEvidenceV1,
} from "./api.js";

describe("Ollama Completion Adapter Inference Accounting & Endpoint Controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes known (including 0), partial, and unknown usage without fabricating 0", () => {
    // Omitted -> unknown
    expect(usageOf({})).toEqual({});
    expect(classifyOllamaUsage({})).toMatchObject({
      usage_status: "unknown",
      usage_source: "unavailable",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      missing_fields: ["input_tokens", "output_tokens", "total_tokens"],
    });

    // Partial -> partial, legacy usageOf returns {} instead of fabricating outputTokens: 0
    expect(usageOf({ prompt_eval_count: 18 })).toEqual({});
    expect(classifyOllamaUsage({ prompt_eval_count: 18 })).toMatchObject({
      usage_status: "partial",
      usage_source: "provider_final",
      input_tokens: 18,
      output_tokens: null,
      total_tokens: null,
      missing_fields: ["output_tokens", "total_tokens"],
    });

    // Measured 0 -> known
    expect(usageOf({ prompt_eval_count: 0, eval_count: 0 })).toEqual({
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(classifyOllamaUsage({ prompt_eval_count: 0, eval_count: 0 })).toMatchObject({
      usage_status: "known",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      missing_fields: [],
    });

    // Known with price schedule
    const known = classifyOllamaUsage(
      { model: "qwen3:8b", prompt_eval_count: 200, eval_count: 100 },
      {
        runId: "run-oll-1",
        segmentId: "seg-oll-1",
        priceSchedule: {
          currency: "USD",
          input_cost_per_million: 0.5,
          output_cost_per_million: 1.5,
        },
      },
    );
    expect(known).toMatchObject({
      usage_status: "known",
      input_tokens: 200,
      output_tokens: 100,
      total_tokens: 300,
      cost_source: "price_schedule",
    });
    expect(known.cost_usd).toBeCloseTo((200 * 0.5 + 100 * 1.5) / 1_000_000, 10);
  });

  it("projects policy.max_output_tokens onto options.num_predict and refuses unsupported policies pre-send", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        model: "qwen3:8b",
        message: { content: "local answer" },
        prompt_eval_count: 14,
        eval_count: 7,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const evidences: OllamaUsageEvidenceV1[] = [];
    const model = ollamaCompletionModel(
      "qwen3:8b",
      { baseUrl: "http://127.0.0.1:11434" },
      {
        executionAccess: {
          execution_id: "exec-sandbox-1",
          execution_kind: "sandbox",
          network_access: "routed_loopback",
        },
        policy: {
          schema_version: 1,
          run_id: "run-oll-2",
          segment_id: "seg-oll-2",
          provider_protocol: "ollama-chat",
          model: "qwen3:8b",
          max_output_tokens: 96,
          retry_posture: "never",
          fallback_posture: "forbid",
        },
        onUsageEvidence: (ev) => {
          evidences.push(ev);
        },
      },
    );

    const res = await model.complete({ prompt: "test num_predict", maxTokens: 512 });
    expect(res).toEqual({
      text: "local answer",
      servedModel: "qwen3:8b",
      usage: { inputTokens: 14, outputTokens: 7 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const wireBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(wireBody.options.num_predict).toBe(96);
    expect(evidences).toHaveLength(1);
    expect(evidences[0].total_tokens).toBe(21);

    // Refuses expired deadline pre-send without network call
    fetchMock.mockClear();
    const faults: OllamaInferenceFaultV1[] = [];
    await expect(
      ollamaChat(
        { baseUrl: "http://127.0.0.1:11434" },
        {
          prompt: "late call",
          model: "qwen3:8b",
          json: false,
          timeoutMs: 5_000,
          inference: {
            now: () => 10_000,
            policy: {
              schema_version: 1,
              run_id: "run-oll-3",
              segment_id: "seg-oll-3",
              provider_protocol: "ollama-chat",
              model: "qwen3:8b",
              deadline: { epoch_ms: 9_000 },
              retry_posture: "never",
              fallback_posture: "forbid",
            },
            onFault: (f) => {
              faults.push(f);
            },
          },
        },
      ),
    ).rejects.toThrowError(OllamaInferenceFaultError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(faults[0]).toMatchObject({
      category: "timeout",
      request_phase: "pre_send",
      admission_certainty: "not_sent",
    });
  });

  it("classifies 404 missing model, 429 rate-limit with Retry-After, and malformed JSON", async () => {
    const faults: OllamaInferenceFaultV1[] = [];
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "model not found",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ollamaChat(
        { baseUrl: "http://127.0.0.1:11434" },
        {
          prompt: "missing model",
          model: "missing:7b",
          json: false,
          timeoutMs: 5_000,
          inference: {
            onFault: (f) => {
              faults.push(f);
            },
          },
        },
      ),
    ).rejects.toThrowError(ModelUnavailableError);
    expect(faults[0].http_status).toBe(404);
    expect(faults[0].terminal_for_segment).toBe(true);

    // Malformed JSON on 200 OK
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    });
    await expect(
      ollamaChat(
        { baseUrl: "http://127.0.0.1:11434" },
        {
          prompt: "bad json",
          model: "qwen3:8b",
          json: false,
          timeoutMs: 5_000,
          inference: {
            onFault: (f) => {
              faults.push(f);
            },
          },
        },
      ),
    ).rejects.toThrowError(OllamaInferenceFaultError);
    expect(faults[1]).toMatchObject({
      category: "malformed_response",
      request_phase: "post_stream",
      admission_certainty: "admitted",
    });
  });
});
