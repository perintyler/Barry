// Transcript recovery supplements recorded usage while retaining its inferred provenance.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-217

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

/** One assistant turn's usage, as the vendor recorded it. */
export interface TranscriptUsage {
  /** The vendor's request id — stable, so re-ingesting cannot double-count. */
  requestId: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ts: number;
}

// Malformed transcript lines must not abort recovery of other complete records.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-218
export function parseTranscriptLine(line: string): TranscriptUsage | null {
  let transcriptEntry: Record<string, unknown>;
  try {
    transcriptEntry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const message = transcriptEntry.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, number> | undefined;
  if (!usage) return null;

  const ts = typeof transcriptEntry.timestamp === "string" ? Date.parse(transcriptEntry.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;

  // requestId is the vendor's own idempotency key. Without one, fall back to a
  // composite that is still stable across re-reads of the same file.
  const requestId = typeof transcriptEntry.requestId === "string"
    ? transcriptEntry.requestId
    : `${transcriptEntry.sessionId ?? "?"}:${ts}`;

  return {
    requestId,
    model: typeof message?.model === "string" ? message.model : undefined,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    // The cache split the provider adapters discard. Cache reads are usually
    // the overwhelming majority — one transcript showed 1,152,413 cache-read
    // against 52 fresh input — and they are priced far lower, so a cost figure
    // without them is wrong by orders of magnitude rather than a few percent.
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    ts: Math.floor(ts / 1000),
  };
}

/** Every usage record in a transcript. Missing file yields an empty list. */
export async function readTranscript(file: string): Promise<TranscriptUsage[]> {
  if (!existsSync(file)) return [];
  const transcriptLines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const out: TranscriptUsage[] = [];
  for await (const line of transcriptLines) {
    const usageRecord = parseTranscriptLine(line);
    if (usageRecord) out.push(usageRecord);
  }
  return out;
}

// Bound inferred tool duration because transcript timestamps include sleep and human pauses.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-219
export const TOOL_DURATION_CEILING_MS = 300_000;

// Human-response tool duration measures response time and is excluded from latency rankings.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-220
export const HUMAN_BLOCKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// Pair an invocation with its matching result before inferring elapsed duration.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-221
export interface TranscriptToolCall {
  /** The vendor's `tool_use` id — stable, so re-ingesting cannot double-count. */
  toolUseId: string;
  name: string;
  durationMs: number;
  /** Undefined when the transcript recorded no error flag for this result. */
  isError?: boolean;
  ts: number;
}

/** A transcript record, as far as tool-pairing needs to understand one. */
interface TranscriptRecord {
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: { content?: unknown };
}

// Preserve unknown error state and parse actual Boolean or quoted Boolean flags deliberately.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-222
function parseErrorFlag(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (raw === "True" || raw === "true") return true;
  if (raw === "False" || raw === "false") return false;
  return undefined;
}

/** Content blocks of a record, or an empty list for any other shape. */
function contentBlocks(transcriptRecord: TranscriptRecord | undefined): Array<Record<string, unknown>> {
  const content = transcriptRecord?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null);
}

// Match tool results by invocation identity rather than assuming adjacent transcript records.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-223
export function pairToolCalls(records: unknown[]): TranscriptToolCall[] {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const r of records) {
    const transcriptRecord = r as TranscriptRecord;
    if (typeof transcriptRecord?.uuid === "string") byUuid.set(transcriptRecord.uuid, transcriptRecord);
  }

  const out: TranscriptToolCall[] = [];
  for (const r of records) {
    const transcriptRecord = r as TranscriptRecord;
    const parent = typeof transcriptRecord?.parentUuid === "string" ? byUuid.get(transcriptRecord.parentUuid) : undefined;
    if (!parent) continue;

    const endTs = typeof transcriptRecord.timestamp === "string" ? Date.parse(transcriptRecord.timestamp) : NaN;
    const startTs = typeof parent.timestamp === "string" ? Date.parse(parent.timestamp) : NaN;
    if (!Number.isFinite(endTs) || !Number.isFinite(startTs)) continue;

    // The parent's tool_use blocks, indexed by id. One assistant turn can issue
    // several tool calls, and their results arrive as separate records that all
    // name this same parent — so the id, not the position, is what pairs them.
    const uses = new Map<string, string>();
    for (const block of contentBlocks(parent)) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        uses.set(block.id, block.name);
      }
    }
    if (uses.size === 0) continue;

    for (const block of contentBlocks(transcriptRecord)) {
      if (block.type !== "tool_result") continue;
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      if (!toolUseId) continue;
      const name = uses.get(toolUseId);
      if (!name) continue;
      // Not a measurement of Barry at all — see HUMAN_BLOCKING_TOOLS.
      if (HUMAN_BLOCKING_TOOLS.has(name)) continue;

      const durationMs = endTs - startTs;
      // A negative delta means the two records disagree about ordering — a clock
      // step between them, or an out-of-order write. None appear in the current
      // corpus, but a negative duration is nonsense rather than merely extreme,
      // so it is dropped on the same reasoning as the over-ceiling case.
      if (durationMs < 0 || durationMs > TOOL_DURATION_CEILING_MS) continue;

      out.push({
        toolUseId,
        name,
        durationMs,
        isError: parseErrorFlag(block.is_error),
        ts: Math.floor(endTs / 1000),
      });
    }
  }
  return out;
}

// Whole-file transcript access supports matching results to earlier parent records.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-130
export async function readTranscriptToolCalls(file: string): Promise<TranscriptToolCall[]> {
  if (!existsSync(file)) return [];
  const transcriptLines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const records: unknown[] = [];
  for await (const line of transcriptLines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A half-written tail of a file the vendor is still appending to.
      continue;
    }
  }
  return pairToolCalls(records);
}

// Pricing uses per-million-token USD rates and distinguishes input, output and cache operations.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-224
export const PRICING_AS_OF = "2026-09-09";

// Use the declared cache-write duration; five-minute and one-hour writes have different rates.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-225
export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Deliberately absent: <synthetic>. Not a model and has no rate to look up —
  // it must stay uncosted rather than be assigned a plausible-looking zero.
  //
  // Two traps for whoever extends this table. Prefix matching means a longer id
  // starting with a priced key inherits that key's price: `claude-fable-5-1`
  // would silently bill at Fable 5's rates even though 5.1 cache reads are
  // 0.25, not 1. Add the more specific id explicitly — longest match wins, so
  // order does not matter, presence does. And ids namespaced by provider
  // (`anthropic/claude-fable-5`, from opencode) match nothing here, because the
  // prefix is the namespace; they land in the uncosted bucket unbilled.
};

/** Models seen in transcripts that have no price, for the dashboard to name. */
export function unpricedModels(seen: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const m of seen) if (m && !priceFor(m)) out.add(m);
  return [...out].sort();
}

/** Match a transcript's model string against the price table. */
export function priceFor(model?: string) {
  if (!model) return undefined;
  if (PRICING[model]) return PRICING[model];
  // Vendor model ids carry a date suffix (claude-opus-5-20260801); match the
  // longest known prefix so a new build of a priced model still costs.
  const hit = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? PRICING[hit] : undefined;
}

// Price only recorded usage components so omitted fields do not invent token counts.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-226
export type PriceableUsage = {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Cost in USD, or undefined when the model is not priced. */
export function costOf(usageRecord: PriceableUsage): number | undefined {
  const modelPrices = priceFor(usageRecord.model);
  if (!modelPrices) return undefined;
  return (
    (usageRecord.inputTokens * modelPrices.input +
      usageRecord.outputTokens * modelPrices.output +
      usageRecord.cacheReadTokens * modelPrices.cacheRead +
      usageRecord.cacheWriteTokens * modelPrices.cacheWrite) / 1_000_000
  );
}
