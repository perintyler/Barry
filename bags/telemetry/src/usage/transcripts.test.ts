import { describe, it, expect } from "vitest";
import {
  parseTranscriptLine, costOf, priceFor, PRICING,
  pairToolCalls, TOOL_DURATION_CEILING_MS, HUMAN_BLOCKING_TOOLS,
} from "./transcripts.js";

// Recover transcript costs from vendor-recorded usage without pretending they were measured live.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-212

const line = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant",
  requestId: "req_abc",
  timestamp: "2026-08-25T12:00:00.000Z",
  message: {
    model: "claude-opus-5",
    usage: {
      input_tokens: 2,
      output_tokens: 233,
      cache_read_input_tokens: 26_760,
      cache_creation_input_tokens: 11_631,
    },
  },
  ...over,
});

describe("parseTranscriptLine", () => {
  it("extracts usage including the cache split", () => {
    const rec = parseTranscriptLine(line());
    expect(rec).toMatchObject({
      requestId: "req_abc",
      model: "claude-opus-5",
      inputTokens: 2,
      outputTokens: 233,
      // The provider adapters drop these. They are the majority of the bill's
      // input side — one real transcript showed 1,152,413 cache-read against 52
      // fresh input.
      cacheReadTokens: 26_760,
      cacheWriteTokens: 11_631,
    });
  });

  it("ignores lines that carry no usage", () => {
    expect(parseTranscriptLine(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeNull();
    expect(parseTranscriptLine("not json")).toBeNull();
    // A half-written tail of a file the vendor is still appending to.
    expect(parseTranscriptLine('{"type":"assistant","message":{"usage":')).toBeNull();
  });

  it("ignores a record with no usable timestamp", () => {
    expect(parseTranscriptLine(line({ timestamp: "not-a-date" }))).toBeNull();
  });

  // Vendor request IDs deduplicate turns appearing in multiple resumed-session transcripts.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-122
  it("falls back to a stable key when requestId is absent", () => {
    const a = parseTranscriptLine(line({ requestId: undefined, sessionId: "s1" }));
    const b = parseTranscriptLine(line({ requestId: undefined, sessionId: "s1" }));
    expect(a?.requestId).toBe(b?.requestId);
  });
});

describe("costOf", () => {
  it("prices a turn from its token mix", () => {
    const rec = parseTranscriptLine(line())!;
    // (2*5 + 233*25 + 26760*0.5 + 11631*6.25) / 1e6
    expect(costOf(rec)).toBeCloseTo(0.091909, 6);
  });

  // Unpriced models return no cost rather than falsely claiming their calls were free.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-123
  it("returns undefined for a model with no price", () => {
    // `<synthetic>` rather than a real model id on purpose: it is the one entry
    // that must NEVER acquire a price, so this fixture cannot rot the way the
    // previous one did — it named claude-fable-5, and silently stopped testing
    // the unpriced path the moment Fable 5 was given a rate.
    const rec = parseTranscriptLine(line({ message: { model: "<synthetic>", usage: { input_tokens: 1 } } }))!;
    expect(costOf(rec)).toBeUndefined();
  });

  // Keep literal model-specific pricing so a generic family mapping cannot silently halve spend.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-124
  it("prices fable-5 at its own rates, not the Opus family's", () => {
    expect(PRICING["claude-fable-5"]).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    const rec = parseTranscriptLine(
      line({
        message: {
          model: "claude-fable-5",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
          },
        },
      }),
    )!;
    // 10 + 50 + 1 + 12.5
    expect(costOf(rec)).toBeCloseTo(73.5, 6);
  });

  it("prices opus-4-8", () => {
    expect(PRICING["claude-opus-4-8"]).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it("returns undefined when the model is unknown entirely", () => {
    const rec = parseTranscriptLine(line({ message: { usage: { input_tokens: 1 } } }))!;
    expect(rec.model).toBeUndefined();
    expect(costOf(rec)).toBeUndefined();
  });

  // Use the longest known model prefix so build-date suffixes retain the correct pricing family.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-125
  it("prices a dated build of a known model", () => {
    expect(priceFor("claude-opus-5-20260801")).toEqual(PRICING["claude-opus-5"]);
  });

  it("does not price a model that merely shares a word", () => {
    expect(priceFor("claude-haiku-9")).toBeUndefined();
  });
});

// Recover tool duration only from a matched invocation/result pair.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-213

const toolUse = (over: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid: "parent-1",
  timestamp: "2026-08-25T12:00:00.000Z",
  message: {
    content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
  },
  ...over,
});

const toolResult = (over: Record<string, unknown> = {}, block: Record<string, unknown> = {}) => ({
  type: "user",
  uuid: "child-1",
  parentUuid: "parent-1",
  timestamp: "2026-08-25T12:00:01.231Z",
  message: {
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", ...block }],
  },
  ...over,
});

describe("pairToolCalls", () => {
  it("derives a duration from the tool_use/tool_result timestamp delta", () => {
    const calls = pairToolCalls([toolUse(), toolResult()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolUseId: "toolu_1", name: "Bash", durationMs: 1231 });
  });

  // A result needs its parent invocation to recover a tool name; unpaired results cannot create rows.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-126
  it("drops a result whose parent is absent", () => {
    expect(pairToolCalls([toolResult()])).toEqual([]);
  });

  // Pair parallel results by invocation ID rather than by their order.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-127
  it("pairs parallel calls by id rather than by position", () => {
    const parent = {
      type: "assistant", uuid: "p", timestamp: "2026-08-25T12:00:00.000Z",
      message: { content: [
        { type: "tool_use", id: "a", name: "Read" },
        { type: "tool_use", id: "b", name: "Grep" },
      ] },
    };
    const calls = pairToolCalls([
      parent,
      { uuid: "r2", parentUuid: "p", timestamp: "2026-08-25T12:00:00.500Z",
        message: { content: [{ type: "tool_result", tool_use_id: "b" }] } },
      { uuid: "r1", parentUuid: "p", timestamp: "2026-08-25T12:00:00.200Z",
        message: { content: [{ type: "tool_result", tool_use_id: "a" }] } },
    ]);
    expect(calls.map((c) => [c.name, c.durationMs])).toEqual([["Grep", 500], ["Read", 200]]);
  });

  // Parse quoted error flags explicitly; Boolean("False") incorrectly marks successful calls as errors.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-214
  it("reads is_error whether the vendor writes a boolean or a quoted string", () => {
    // The encoding in today's transcripts.
    expect(pairToolCalls([toolUse(), toolResult({}, { is_error: false })])[0].isError).toBe(false);
    expect(pairToolCalls([toolUse(), toolResult({}, { is_error: true })])[0].isError).toBe(true);
    // Tolerated, not currently observed.
    expect(pairToolCalls([toolUse(), toolResult({}, { is_error: "False" })])[0].isError).toBe(false);
    expect(pairToolCalls([toolUse(), toolResult({}, { is_error: "True" })])[0].isError).toBe(true);
  });

  // An absent outcome remains unknown instead of increasing measured success coverage.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-128
  it("leaves is_error undefined when the transcript recorded none", () => {
    expect(pairToolCalls([toolUse(), toolResult()])[0].isError).toBeUndefined();
  });

  // Clamp transcript wall-clock deltas so host sleep cannot become multi-day tool latency.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-215
  it("drops a duration that spans a host sleep", () => {
    const calls = pairToolCalls([
      toolUse(),
      toolResult({ timestamp: "2026-08-29T20:25:09.151Z" }), // +4.35 days, the real max
    ]);
    expect(calls).toEqual([]);
  });

  it("keeps a slow but plausible call, and drops one just over the ceiling", () => {
    const at = (ms: number) => new Date(Date.parse("2026-08-25T12:00:00.000Z") + ms).toISOString();
    expect(pairToolCalls([toolUse(), toolResult({ timestamp: at(TOOL_DURATION_CEILING_MS) })])).toHaveLength(1);
    expect(pairToolCalls([toolUse(), toolResult({ timestamp: at(TOOL_DURATION_CEILING_MS + 1) })])).toEqual([]);
  });

  /** A clock step between the two writes; nonsense rather than merely extreme. */
  it("drops a negative duration", () => {
    expect(pairToolCalls([toolUse(), toolResult({ timestamp: "2026-08-25T11:59:59.000Z" })])).toEqual([]);
  });

  // Stable invocation IDs make repeated transcript ingestion idempotent.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-129
  it("yields a stable id across repeated reads", () => {
    const a = pairToolCalls([toolUse(), toolResult()]);
    const b = pairToolCalls([toolUse(), toolResult()]);
    expect(a[0].toolUseId).toBe(b[0].toolUseId);
  });

  it("ignores records that are not tool traffic", () => {
    expect(pairToolCalls([
      { uuid: "p", timestamp: "2026-08-25T12:00:00.000Z", message: { content: "plain text" } },
      { uuid: "c", parentUuid: "p", timestamp: "2026-08-25T12:00:01.000Z", message: { content: [{ type: "text", text: "hi" }] } },
    ])).toEqual([]);
  });
});

// Human-response tools are excluded from system latency measurements.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-216
describe("human-blocking tools", () => {
  const at = (ms: number) => new Date(Date.parse("2026-08-25T12:00:00.000Z") + ms).toISOString();
  const call = (name: string, ms: number) => pairToolCalls([
    { uuid: "p", timestamp: "2026-08-25T12:00:00.000Z",
      message: { content: [{ type: "tool_use", id: "t", name }] } },
    { uuid: "c", parentUuid: "p", timestamp: at(ms),
      message: { content: [{ type: "tool_result", tool_use_id: "t" }] } },
  ]);

  it("excludes a prompt the user answered, however fast", () => {
    // Well under the ceiling, so the clamp alone would have kept it.
    expect(call("AskUserQuestion", 67_497)).toEqual([]);
    expect(call("ExitPlanMode", 900)).toEqual([]);
  });

  it("keeps tools that measure actual work", () => {
    expect(call("Read", 1278)).toHaveLength(1);
    expect(call("Bash", 67_497)).toHaveLength(1);
  });
});
