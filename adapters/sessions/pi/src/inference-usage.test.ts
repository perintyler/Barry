import { describe, expect, it } from "vitest";
import { createDefaultExecutionBinding } from "./inference-bounds.js";
import {
  ProviderStreamUsageTracker,
  UsageSinkConflictError,
  buildUsageEvidence,
  calculateCostFromSchedule,
  createInMemoryUsageSink,
  normalizeRawProviderUsage,
  toLegacyTokenUsage,
} from "./inference-usage.js";

describe("Inference Usage Evidence and ProviderStreamUsageTracker", () => {
  it("distinguishes known (including measured 0), partial, unknown, and malformed provider usage", () => {
    // 1. Measured 0 tokens -> known (not unknown!)
    const zeroNorm = normalizeRawProviderUsage(
      { input_tokens: 0, output_tokens: 0 },
      { protocol: "anthropic-messages" },
    );
    expect(zeroNorm.status).toBe("known");
    expect(zeroNorm.input_tokens).toBe(0);
    expect(zeroNorm.output_tokens).toBe(0);
    expect(zeroNorm.total_tokens).toBe(0);
    expect(zeroNorm.unknown_reason).toBeNull();

    // 2. Omitted usage -> unknown (never fabricated as 0)
    const missingNorm = normalizeRawProviderUsage(null, {
      protocol: "anthropic-messages",
    });
    expect(missingNorm.status).toBe("unknown");
    expect(missingNorm.input_tokens).toBeNull();
    expect(missingNorm.output_tokens).toBeNull();
    expect(missingNorm.total_tokens).toBeNull();
    expect(missingNorm.unknown_reason).toBe("usage_missing");

    // 3. Partial usage -> partial (input known, output null)
    const partialNorm = normalizeRawProviderUsage(
      { input_tokens: 42 },
      { protocol: "anthropic-messages" },
    );
    expect(partialNorm.status).toBe("partial");
    expect(partialNorm.input_tokens).toBe(42);
    expect(partialNorm.output_tokens).toBeNull();
    expect(partialNorm.total_tokens).toBeNull();
    expect(partialNorm.unknown_reason).toBe("usage_incomplete");

    // 4. Malformed usage (negative / NaN / string) -> flagged as usage_malformed, not known
    const malformedNorm = normalizeRawProviderUsage(
      { input_tokens: -10, output_tokens: "invalid" },
      { protocol: "anthropic-messages" },
    );
    expect(malformedNorm.status).toBe("unknown");
    expect(malformedNorm.input_tokens).toBeNull();
    expect(malformedNorm.output_tokens).toBeNull();
    expect(malformedNorm.unknown_reason).toBe("usage_malformed");
  });

  it("accounts for cache read/write and reasoning tokens without double-counting across Anthropic and OpenAI", () => {
    // Anthropic: input_tokens is non-cached; total adds input + output + cache_read + cache_write
    const anthropicCached = normalizeRawProviderUsage(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 200,
      },
      { protocol: "anthropic-messages" },
    );
    expect(anthropicCached.status).toBe("known");
    expect(anthropicCached.input_tokens).toBe(100);
    expect(anthropicCached.output_tokens).toBe(50);
    expect(anthropicCached.cache_read_tokens).toBe(400);
    expect(anthropicCached.cache_write_tokens).toBe(200);
    expect(anthropicCached.total_tokens).toBe(750);
    expect(anthropicCached.input_includes_cache).toBe(false);

    // OpenAI: prompt_tokens includes cached_tokens; input_includes_cache is true so cost and total do not double-count
    const openAiCached = normalizeRawProviderUsage(
      {
        prompt_tokens: 500,
        completion_tokens: 120,
        total_tokens: 620,
        prompt_tokens_details: { cached_tokens: 300 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
      {
        protocol: "openai-completions",
        priceSchedule: {
          version: "oai-2026",
          currency: "USD",
          rates: {
            input_per_million: 2.0,
            output_per_million: 8.0,
            cache_read_per_million: 1.0,
          },
        },
      },
    );
    expect(openAiCached.status).toBe("known");
    expect(openAiCached.input_tokens).toBe(500);
    expect(openAiCached.cache_read_tokens).toBe(300);
    expect(openAiCached.output_tokens).toBe(120);
    expect(openAiCached.reasoning_tokens).toBe(40);
    expect(openAiCached.total_tokens).toBe(620);
    expect(openAiCached.input_includes_cache).toBe(true);
    // Uncached input = 500 - 300 = 200 @ $2/M ($0.0004) + 300 cached @ $1/M ($0.0003) + 120 output @ $8/M ($0.00096) = $0.00166
    expect(openAiCached.calculated_cost).toBeCloseTo(0.00166, 10);
  });

  it("tracks raw SSE events via ProviderStreamUsageTracker before pi-ai zero-initialization masks missing fields", () => {
    const binding = createDefaultExecutionBinding();

    // Case A: Stream emits no usage at all -> tracker reports status: "unknown" even if assistantMessage has pi-ai zeros
    const trackerNoUsage = new ProviderStreamUsageTracker({
      protocol: "openai-completions",
    });
    trackerNoUsage.observeStreamEvent({
      id: "chatcmpl-1",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
    });
    const noUsageSnap = trackerNoUsage.finalize({
      assistantMessage: { usage: { input: 0, output: 0, totalTokens: 0 } },
    });
    const noUsageEvidence = buildUsageEvidence({
      binding,
      session_id: "sess-1",
      turn_id: "turn-1",
      segment_id: "seg-1",
      model_call_id: "call-1",
      sequence: 1,
      observation_kind: "final",
      provider_response_id: trackerNoUsage.responseId,
      snapshot: noUsageSnap,
      final: true,
    });
    expect(noUsageEvidence.status).toBe("unknown");
    expect(noUsageEvidence.unknown_reason).toBe("usage_missing");
    expect(noUsageEvidence.input_tokens).toBeNull();
    expect(noUsageEvidence.output_tokens).toBeNull();
    expect(toLegacyTokenUsage(noUsageEvidence)).toBeUndefined();

    // Case B: Anthropic stream truncates after message_start before message_delta -> partial usage
    const trackerTruncated = new ProviderStreamUsageTracker({
      protocol: "anthropic-messages",
      priceSchedule: {
        version: "ant-2026",
        currency: "USD",
        rates: { input_per_million: 3, output_per_million: 15 },
      },
    });
    const startSnap = trackerTruncated.observeStreamEvent({
      type: "message_start",
      message: { id: "msg_01", usage: { input_tokens: 75, output_tokens: 0 } },
    });
    expect(startSnap).not.toBeNull();
    trackerTruncated.observeStreamEvent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    });
    const truncatedFinalSnap = trackerTruncated.finalize({ streamFailed: true });
    const partialEvidence = buildUsageEvidence({
      binding,
      session_id: "sess-1",
      turn_id: "turn-1",
      segment_id: "seg-1",
      model_call_id: "call-2",
      sequence: 1,
      observation_kind: "final",
      provider_response_id: trackerTruncated.responseId,
      snapshot: truncatedFinalSnap,
      final: true,
    });
    expect(partialEvidence.status).toBe("partial");
    expect(partialEvidence.input_tokens).toBe(75);
    expect(partialEvidence.output_tokens).toBeNull();
    expect(partialEvidence.unknown_reason).toBe("usage_incomplete");
    expect(toLegacyTokenUsage(partialEvidence)).toBeUndefined();

    // Case C: Complete Anthropic stream -> known usage
    trackerTruncated.observeStreamEvent({
      type: "message_delta",
      usage: { output_tokens: 25 },
    });
    trackerTruncated.observeStreamEvent({
      type: "message_stop",
    });
    const completeSnap = trackerTruncated.finalize({});
    const finalEvidence = buildUsageEvidence({
      binding,
      session_id: "sess-1",
      turn_id: "turn-1",
      segment_id: "seg-1",
      model_call_id: "call-2",
      sequence: 2,
      observation_kind: "final",
      provider_response_id: trackerTruncated.responseId,
      snapshot: completeSnap,
      final: true,
    });
    expect(finalEvidence.status).toBe("known");
    expect(finalEvidence.input_tokens).toBe(75);
    expect(finalEvidence.output_tokens).toBe(25);
    expect(finalEvidence.total_tokens).toBe(100);
    expect(finalEvidence.calculated_cost).toBeCloseTo((75 * 3 + 25 * 15) / 1_000_000, 10);
    expect(toLegacyTokenUsage(finalEvidence)).toEqual({
      inputTokens: 75,
      outputTokens: 25,
      totalTokens: 100,
      costUsd: finalEvidence.calculated_cost,
    });
  });

  it("refuses to compute cost from schedule when input or output tokens are missing", () => {
    const cost = calculateCostFromSchedule(
      {
        input_tokens: 100,
        output_tokens: null,
        reasoning_tokens: null,
        cache_read_tokens: 200,
        cache_write_tokens: null,
        input_includes_cache: false,
      },
      {
        version: "v1",
        currency: "USD",
        rates: {
          input_per_million: 3,
          output_per_million: 15,
        },
      },
    );
    expect(cost.calculated_cost).toBeNull();
    expect(cost.price_version).toBe("v1");
  });

  it("deduplicates identical events and rejects conflicting digests for same event_id in InMemoryUsageSink", async () => {
    const sink = createInMemoryUsageSink();
    const binding = createDefaultExecutionBinding();
    const snap1 = normalizeRawProviderUsage(
      { input_tokens: 10, output_tokens: 20 },
      { protocol: "anthropic-messages" },
    );
    const ev1 = buildUsageEvidence({
      binding,
      session_id: "sess-1",
      turn_id: "turn-1",
      segment_id: "seg-1",
      model_call_id: "call-1",
      sequence: 1,
      observation_kind: "final",
      snapshot: snap1,
      final: true,
    });

    const r1 = await sink.append(ev1);
    expect(r1.disposition).toBe("committed");

    const r2 = await sink.append(ev1); // idempotent replay of same event_id
    expect(r2.disposition).toBe("duplicate");
    expect(sink.records).toHaveLength(1);

    const snapConflict = normalizeRawProviderUsage(
      { input_tokens: 10, output_tokens: 99 },
      { protocol: "anthropic-messages" },
    );
    const conflictingEv = buildUsageEvidence({
      binding,
      session_id: "sess-1",
      turn_id: "turn-1",
      segment_id: "seg-1",
      model_call_id: "call-1",
      sequence: 1,
      observation_kind: "final",
      snapshot: snapConflict,
      final: true,
      event_id: ev1.event_id,
    });

    await expect(sink.append(conflictingEv)).rejects.toThrowError(
      UsageSinkConflictError,
    );
  });
});
