import { createHash } from "node:crypto";
import type { TokenUsage } from "@barry-rocks/sdk/adapters/models";
import type {
  ExecutionBinding,
  PriceScheduleV1,
  ProviderProtocolV1,
} from "./inference-bounds.js";

export type UsageObservationKindV1 = "delta" | "snapshot" | "final";

export type UsageStatusV1 = "known" | "partial" | "unknown";

export type UsageUnknownReasonV1 =
  | "usage_missing"
  | "usage_malformed"
  | "usage_incomplete"
  | "call_failed_before_usage"
  | "stream_truncated_before_usage"
  | "aborted_before_usage"
  | (string & {});

export interface UsageEvidenceV1 {
  readonly schema: 1;
  readonly binding: ExecutionBinding;
  readonly session_id: string;
  readonly turn_id: string;
  readonly segment_id: string;
  readonly model_call_id: string;
  readonly event_id: string;
  readonly sequence: number;
  readonly observation_kind: UsageObservationKindV1;
  readonly provider_response_id: string | null;
  readonly status: UsageStatusV1;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly reported_cost: number | null;
  readonly currency: string | null;
  readonly calculated_cost: number | null;
  readonly price_version: string | null;
  readonly final: boolean;
  readonly unknown_reason: UsageUnknownReasonV1 | null;
}

export interface UsageSinkAppendResultV1 {
  readonly event_id: string;
  readonly digest: string;
  readonly disposition: "committed" | "duplicate";
}

export interface UsageSinkV1 {
  append(evidence: UsageEvidenceV1): Promise<UsageSinkAppendResultV1>;
}

export class UsageSinkConflictError extends Error {
  readonly event_id: string;
  readonly existing_digest: string;
  readonly incoming_digest: string;

  constructor(
    eventId: string,
    existingDigest: string,
    incomingDigest: string,
  ) {
    super(
      `Conflicting UsageEvidenceV1 payload for event_id ${eventId}: expected digest ${existingDigest}, got ${incomingDigest}`,
    );
    this.name = "UsageSinkConflictError";
    this.event_id = eventId;
    this.existing_digest = existingDigest;
    this.incoming_digest = incomingDigest;
  }
}

export interface NormalizedUsageSnapshotV1 {
  readonly status: UsageStatusV1;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly reported_cost: number | null;
  readonly currency: string | null;
  readonly calculated_cost: number | null;
  readonly price_version: string | null;
  readonly unknown_reason: UsageUnknownReasonV1 | null;
  readonly input_includes_cache: boolean;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    if (record[key] !== undefined) {
      out[key] = canonicalizeValue(record[key]);
    }
  }
  return out;
}

export function computeUsageEvidenceDigest(evidence: UsageEvidenceV1): string {
  const canonical = JSON.stringify(canonicalizeValue(evidence));
  return createHash("sha256").update(canonical).digest("hex");
}

export function createDeterministicUsageEventId(input: {
  binding: ExecutionBinding;
  segment_id: string;
  model_call_id: string;
  sequence: number;
  observation_kind: UsageObservationKindV1;
}): string {
  const raw = [
    input.binding.work_id,
    input.binding.attempt_id,
    String(input.binding.execution_fence),
    input.segment_id,
    input.model_call_id,
    String(input.sequence),
    input.observation_kind,
  ].join(":");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `uev_${input.model_call_id}_${input.sequence}_${hash}`;
}

export interface InMemoryUsageSinkV1 extends UsageSinkV1 {
  readonly records: ReadonlyArray<{
    readonly evidence: UsageEvidenceV1;
    readonly digest: string;
  }>;
}

export function createInMemoryUsageSink(): InMemoryUsageSinkV1 {
  const byEventId = new Map<
    string,
    { evidence: UsageEvidenceV1; digest: string }
  >();
  const ordered: Array<{ evidence: UsageEvidenceV1; digest: string }> = [];

  return {
    get records() {
      return ordered;
    },
    async append(evidence: UsageEvidenceV1): Promise<UsageSinkAppendResultV1> {
      const digest = computeUsageEvidenceDigest(evidence);
      const existing = byEventId.get(evidence.event_id);
      if (existing) {
        if (existing.digest !== digest) {
          throw new UsageSinkConflictError(
            evidence.event_id,
            existing.digest,
            digest,
          );
        }
        return {
          event_id: evidence.event_id,
          digest,
          disposition: "duplicate",
        };
      }
      const entry = { evidence: structuredClone(evidence), digest };
      byEventId.set(evidence.event_id, entry);
      ordered.push(entry);
      return {
        event_id: evidence.event_id,
        digest,
        disposition: "committed",
      };
    },
  };
}

interface ParsedTokenField {
  value: number | null;
  present: boolean;
  malformed: boolean;
}

function parseNonNegativeIntField(raw: unknown): ParsedTokenField {
  if (raw === undefined || raw === null) {
    return { value: null, present: false, malformed: false };
  }
  if (
    typeof raw === "number" &&
    Number.isSafeInteger(raw) &&
    raw >= 0
  ) {
    return { value: raw, present: true, malformed: false };
  }
  return { value: null, present: true, malformed: true };
}

interface ParsedCostField {
  value: number | null;
  present: boolean;
  malformed: boolean;
}

function parseNonNegativeCostField(raw: unknown): ParsedCostField {
  if (raw === undefined || raw === null) {
    return { value: null, present: false, malformed: false };
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return { value: raw, present: true, malformed: false };
  }
  return { value: null, present: true, malformed: true };
}

export function calculateCostFromSchedule(
  tokens: {
    input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    input_includes_cache: boolean;
  },
  schedule: PriceScheduleV1 | null | undefined,
): { calculated_cost: number | null; price_version: string | null } {
  if (!schedule) {
    return { calculated_cost: null, price_version: null };
  }
  if (tokens.input_tokens === null || tokens.output_tokens === null) {
    return { calculated_cost: null, price_version: schedule.version };
  }

  const cacheRead = tokens.cache_read_tokens ?? 0;
  const cacheWrite = tokens.cache_write_tokens ?? 0;
  const uncachedInput = tokens.input_includes_cache
    ? Math.max(0, tokens.input_tokens - cacheRead - cacheWrite)
    : tokens.input_tokens;

  const cacheReadRate =
    schedule.rates.cache_read_per_million ?? schedule.rates.input_per_million;
  const cacheWriteRate =
    schedule.rates.cache_write_per_million ?? schedule.rates.input_per_million;

  let outputCostTokens = tokens.output_tokens;
  let reasoningCost = 0;
  if (
    tokens.reasoning_tokens !== null &&
    schedule.rates.reasoning_per_million !== undefined &&
    schedule.rates.reasoning_per_million !== null
  ) {
    const boundedReasoning = Math.min(
      tokens.output_tokens,
      tokens.reasoning_tokens,
    );
    outputCostTokens = Math.max(0, tokens.output_tokens - boundedReasoning);
    reasoningCost = boundedReasoning * schedule.rates.reasoning_per_million;
  }

  const totalPerMillion =
    uncachedInput * schedule.rates.input_per_million +
    cacheRead * cacheReadRate +
    cacheWrite * cacheWriteRate +
    outputCostTokens * schedule.rates.output_per_million +
    reasoningCost;

  const calculatedCost = Number((totalPerMillion / 1_000_000).toFixed(12));
  return {
    calculated_cost: calculatedCost,
    price_version: schedule.version,
  };
}

export interface NormalizeRawUsageOptions {
  readonly protocol?: ProviderProtocolV1;
  readonly priceSchedule?: PriceScheduleV1 | null;
  readonly defaultUnknownReason?: UsageUnknownReasonV1;
  /**
   * When true, any `cost.total` on a Pi `Usage` object is treated as local
   * catalog calculation rather than provider-reported cost unless
   * `raw.reported_cost` is explicitly present.
   */
  readonly ignorePiLocalCost?: boolean;
}

export function normalizeRawProviderUsage(
  raw: unknown,
  options?: NormalizeRawUsageOptions,
): NormalizedUsageSnapshotV1 {
  const defaultMissingReason =
    options?.defaultUnknownReason ?? "usage_missing";

  if (raw === undefined || raw === null) {
    return {
      status: "unknown",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reported_cost: null,
      currency: null,
      calculated_cost: null,
      price_version: options?.priceSchedule?.version ?? null,
      unknown_reason: defaultMissingReason,
      input_includes_cache: false,
    };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: "unknown",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reported_cost: null,
      currency: null,
      calculated_cost: null,
      price_version: options?.priceSchedule?.version ?? null,
      unknown_reason: "usage_malformed",
      input_includes_cache: false,
    };
  }

  const obj = raw as Record<string, unknown>;

  // Detect which protocol shape is present
  const hasAnthropicFields =
    "input_tokens" in obj ||
    "output_tokens" in obj ||
    "cache_read_input_tokens" in obj ||
    "cache_creation_input_tokens" in obj;
  const hasOpenAiFields =
    "prompt_tokens" in obj ||
    "completion_tokens" in obj ||
    "prompt_tokens_details" in obj ||
    "completion_tokens_details" in obj;
  const hasOllamaFields =
    "prompt_eval_count" in obj || "eval_count" in obj;
  const hasPiFields =
    "input" in obj ||
    "output" in obj ||
    "totalTokens" in obj ||
    "cacheRead" in obj ||
    "cacheWrite" in obj;
  const hasBarryFields =
    "inputTokens" in obj ||
    "outputTokens" in obj ||
    "totalTokens" in obj;

  let inputField: ParsedTokenField = {
    value: null,
    present: false,
    malformed: false,
  };
  let outputField: ParsedTokenField = {
    value: null,
    present: false,
    malformed: false,
  };
  let totalField: ParsedTokenField = {
    value: null,
    present: false,
    malformed: false,
  };
  let reasoningField: ParsedTokenField = {
    value: null,
    present: false,
    malformed: false,
  };
  let cacheReadField: ParsedTokenField = {
    value: null,
    present: false,
    malformed: false,
  };
  let cacheWriteField: ParsedTokenField = {
    value: null,
    present: false,
    malformed: false,
  };
  let inputIncludesCache = false;

  if (hasAnthropicFields || options?.protocol === "anthropic-messages") {
    inputField = parseNonNegativeIntField(obj.input_tokens ?? obj.input);
    outputField = parseNonNegativeIntField(obj.output_tokens ?? obj.output);
    totalField = parseNonNegativeIntField(obj.total_tokens ?? obj.totalTokens);
    cacheReadField = parseNonNegativeIntField(
      obj.cache_read_input_tokens ?? obj.cache_read_tokens ?? obj.cacheRead,
    );
    cacheWriteField = parseNonNegativeIntField(
      obj.cache_creation_input_tokens ??
        obj.cache_write_tokens ??
        obj.cacheWrite,
    );
    const outputDetails =
      obj.output_tokens_details &&
      typeof obj.output_tokens_details === "object" &&
      !Array.isArray(obj.output_tokens_details)
        ? (obj.output_tokens_details as Record<string, unknown>)
        : undefined;
    reasoningField = parseNonNegativeIntField(
      outputDetails?.thinking_tokens ??
        obj.reasoning_tokens ??
        obj.reasoning,
    );
    inputIncludesCache = false;
  } else if (hasOpenAiFields || options?.protocol === "openai-completions") {
    const promptDetails =
      obj.prompt_tokens_details &&
      typeof obj.prompt_tokens_details === "object" &&
      !Array.isArray(obj.prompt_tokens_details)
        ? (obj.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const completionDetails =
      obj.completion_tokens_details &&
      typeof obj.completion_tokens_details === "object" &&
      !Array.isArray(obj.completion_tokens_details)
        ? (obj.completion_tokens_details as Record<string, unknown>)
        : undefined;

    if ("prompt_tokens" in obj || "completion_tokens" in obj) {
      inputField = parseNonNegativeIntField(obj.prompt_tokens);
      outputField = parseNonNegativeIntField(obj.completion_tokens);
      totalField = parseNonNegativeIntField(obj.total_tokens);
      cacheReadField = parseNonNegativeIntField(
        promptDetails?.cached_tokens ??
          obj.prompt_cache_hit_tokens ??
          obj.cached_tokens ??
          obj.cache_read_tokens,
      );
      cacheWriteField = parseNonNegativeIntField(
        promptDetails?.cache_write_tokens ?? obj.cache_write_tokens,
      );
      reasoningField = parseNonNegativeIntField(
        completionDetails?.reasoning_tokens ?? obj.reasoning_tokens,
      );
      inputIncludesCache = true;
    } else {
      inputField = parseNonNegativeIntField(obj.input);
      outputField = parseNonNegativeIntField(obj.output);
      totalField = parseNonNegativeIntField(obj.totalTokens ?? obj.total_tokens);
      cacheReadField = parseNonNegativeIntField(
        obj.cacheRead ?? obj.cache_read_tokens,
      );
      cacheWriteField = parseNonNegativeIntField(
        obj.cacheWrite ?? obj.cache_write_tokens,
      );
      reasoningField = parseNonNegativeIntField(
        obj.reasoning ?? obj.reasoning_tokens,
      );
      inputIncludesCache = false;
    }
  } else if (hasOllamaFields || options?.protocol === "ollama-chat") {
    inputField = parseNonNegativeIntField(obj.prompt_eval_count);
    outputField = parseNonNegativeIntField(obj.eval_count);
    totalField = parseNonNegativeIntField(obj.total_tokens);
    inputIncludesCache = false;
  } else if (hasPiFields) {
    inputField = parseNonNegativeIntField(obj.input);
    outputField = parseNonNegativeIntField(obj.output);
    totalField = parseNonNegativeIntField(obj.totalTokens);
    cacheReadField = parseNonNegativeIntField(obj.cacheRead);
    cacheWriteField = parseNonNegativeIntField(obj.cacheWrite);
    reasoningField = parseNonNegativeIntField(obj.reasoning);
    inputIncludesCache = false;
  } else if (hasBarryFields) {
    inputField = parseNonNegativeIntField(obj.inputTokens);
    outputField = parseNonNegativeIntField(obj.outputTokens);
    totalField = parseNonNegativeIntField(obj.totalTokens);
    inputIncludesCache = false;
  }

  let reportedCostField: ParsedCostField = {
    value: null,
    present: false,
    malformed: false,
  };
  let currency: string | null =
    typeof obj.currency === "string" && obj.currency.trim().length > 0
      ? obj.currency.trim()
      : null;

  if ("reported_cost" in obj) {
    reportedCostField = parseNonNegativeCostField(obj.reported_cost);
    if (reportedCostField.value !== null && !currency) {
      currency = "USD";
    }
  } else if ("total_cost" in obj) {
    reportedCostField = parseNonNegativeCostField(obj.total_cost);
    if (reportedCostField.value !== null && !currency) {
      currency = "USD";
    }
  } else if ("costUsd" in obj) {
    reportedCostField = parseNonNegativeCostField(obj.costUsd);
    if (reportedCostField.value !== null && !currency) {
      currency = "USD";
    }
  } else if (typeof obj.cost === "number") {
    reportedCostField = parseNonNegativeCostField(obj.cost);
    if (reportedCostField.value !== null && !currency) {
      currency = "USD";
    }
  } else if (
    !options?.ignorePiLocalCost &&
    obj.cost &&
    typeof obj.cost === "object" &&
    !Array.isArray(obj.cost)
  ) {
    const costObj = obj.cost as Record<string, unknown>;
    if ("total" in costObj) {
      const parsedTotal = parseNonNegativeCostField(costObj.total);
      if (parsedTotal.malformed) {
        reportedCostField = parsedTotal;
      } else if (parsedTotal.value !== null && parsedTotal.value > 0) {
        reportedCostField = parsedTotal;
        if (!currency) currency = "USD";
      }
    }
  }

  const anyMalformed =
    inputField.malformed ||
    outputField.malformed ||
    totalField.malformed ||
    reasoningField.malformed ||
    cacheReadField.malformed ||
    cacheWriteField.malformed ||
    reportedCostField.malformed;

  const inputTokens = inputField.value;
  const outputTokens = outputField.value;
  const reasoningTokens = reasoningField.value;
  const cacheReadTokens = cacheReadField.value;
  const cacheWriteTokens = cacheWriteField.value;

  // Compute total_tokens without double-counting cache tokens and without zero-filling missing halves
  let totalTokens: number | null = totalField.value;
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    if (inputIncludesCache) {
      // OpenAI prompt_tokens already includes cached_tokens
      totalTokens = inputTokens + outputTokens;
    } else {
      totalTokens =
        inputTokens +
        outputTokens +
        (cacheReadTokens ?? 0) +
        (cacheWriteTokens ?? 0);
    }
  }

  const anyKnownMetric =
    inputTokens !== null ||
    outputTokens !== null ||
    totalTokens !== null ||
    reasoningTokens !== null ||
    cacheReadTokens !== null ||
    cacheWriteTokens !== null ||
    reportedCostField.value !== null;

  let status: UsageStatusV1;
  let unknownReason: UsageUnknownReasonV1 | null = null;

  if (inputTokens !== null && outputTokens !== null && !anyMalformed) {
    status = "known";
  } else if (anyKnownMetric) {
    status = "partial";
    unknownReason = anyMalformed ? "usage_malformed" : "usage_incomplete";
  } else {
    status = "unknown";
    unknownReason = anyMalformed ? "usage_malformed" : defaultMissingReason;
  }

  const { calculated_cost, price_version } = calculateCostFromSchedule(
    {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_tokens: cacheReadTokens,
      cache_write_tokens: cacheWriteTokens,
      input_includes_cache: inputIncludesCache,
    },
    options?.priceSchedule,
  );

  return {
    status,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    reasoning_tokens: reasoningTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reported_cost: reportedCostField.value,
    currency: reportedCostField.value !== null ? currency : null,
    calculated_cost,
    price_version,
    unknown_reason: unknownReason,
    input_includes_cache: inputIncludesCache,
  };
}

export function buildUsageEvidence(input: {
  binding: ExecutionBinding;
  session_id: string;
  turn_id: string;
  segment_id: string;
  model_call_id: string;
  sequence: number;
  observation_kind: UsageObservationKindV1;
  provider_response_id?: string | null;
  snapshot: NormalizedUsageSnapshotV1;
  final: boolean;
  event_id?: string;
}): UsageEvidenceV1 {
  const eventId =
    input.event_id ??
    createDeterministicUsageEventId({
      binding: input.binding,
      segment_id: input.segment_id,
      model_call_id: input.model_call_id,
      sequence: input.sequence,
      observation_kind: input.observation_kind,
    });
  return {
    schema: 1,
    binding: input.binding,
    session_id: input.session_id,
    turn_id: input.turn_id,
    segment_id: input.segment_id,
    model_call_id: input.model_call_id,
    event_id: eventId,
    sequence: input.sequence,
    observation_kind: input.observation_kind,
    provider_response_id: input.provider_response_id ?? null,
    status: input.snapshot.status,
    input_tokens: input.snapshot.input_tokens,
    output_tokens: input.snapshot.output_tokens,
    total_tokens: input.snapshot.total_tokens,
    reasoning_tokens: input.snapshot.reasoning_tokens,
    cache_read_tokens: input.snapshot.cache_read_tokens,
    cache_write_tokens: input.snapshot.cache_write_tokens,
    reported_cost: input.snapshot.reported_cost,
    currency: input.snapshot.currency,
    calculated_cost: input.snapshot.calculated_cost,
    price_version: input.snapshot.price_version,
    final: input.final,
    unknown_reason: input.snapshot.unknown_reason,
  };
}

/**
 * Convert normalized usage evidence or snapshot into a legacy Barry `TokenUsage`
 * event payload ONLY when both `input_tokens` and `output_tokens` are known
 * nonnegative finite integers. Never fabricates `0` for missing halves.
 */
export function toLegacyTokenUsage(
  usage: Pick<
    NormalizedUsageSnapshotV1,
    | "status"
    | "input_tokens"
    | "output_tokens"
    | "total_tokens"
    | "reported_cost"
    | "calculated_cost"
  >,
): TokenUsage | undefined {
  if (
    usage.input_tokens === null ||
    usage.output_tokens === null ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.input_tokens < 0 ||
    usage.output_tokens < 0
  ) {
    return undefined;
  }
  const cost = usage.reported_cost ?? usage.calculated_cost;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.total_tokens !== null &&
    Number.isSafeInteger(usage.total_tokens) &&
    usage.total_tokens >= 0
      ? { totalTokens: usage.total_tokens }
      : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost > 0
      ? { costUsd: cost }
      : {}),
  };
}

/**
 * Tracks raw provider SSE events (`onProviderStreamEvent`) for a single model
 * call so that missing or partial provider usage is never masked by Pi AI's
 * zero-initialized `output.usage` placeholder.
 */
export class ProviderStreamUsageTracker {
  private readonly protocol: ProviderProtocolV1;
  private readonly priceSchedule: PriceScheduleV1 | null;
  private sawAnyStreamEvent = false;
  private sawUsagePayload = false;
  private sawAnthropicMessageDeltaUsage = false;
  private sawAnthropicContentDelta = false;
  private sawAnthropicMessageStop = false;
  private providerResponseId: string | null = null;
  private mergedRawUsage: Record<string, unknown> = {};
  private snapshots: NormalizedUsageSnapshotV1[] = [];

  constructor(options: {
    protocol: ProviderProtocolV1;
    priceSchedule?: PriceScheduleV1 | null;
  }) {
    this.protocol = options.protocol;
    this.priceSchedule = options.priceSchedule ?? null;
  }

  get hasObservedStreamEvents(): boolean {
    return this.sawAnyStreamEvent;
  }

  get hasObservedUsagePayload(): boolean {
    return this.sawUsagePayload;
  }

  get responseId(): string | null {
    return this.providerResponseId;
  }

  get intermediateSnapshots(): readonly NormalizedUsageSnapshotV1[] {
    return this.snapshots;
  }

  observeStreamEvent(data: unknown): NormalizedUsageSnapshotV1 | null {
    this.sawAnyStreamEvent = true;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const event = data as Record<string, unknown>;

    if (this.protocol === "anthropic-messages") {
      const type = event.type;
      if (type === "message_start") {
        const message =
          event.message &&
          typeof event.message === "object" &&
          !Array.isArray(event.message)
            ? (event.message as Record<string, unknown>)
            : undefined;
        if (typeof message?.id === "string" && message.id.length > 0) {
          this.providerResponseId = message.id;
        }
        if (message && "usage" in message && message.usage != null) {
          this.sawUsagePayload = true;
          if (
            typeof message.usage === "object" &&
            !Array.isArray(message.usage)
          ) {
            const u = message.usage as Record<string, unknown>;
            this.mergedRawUsage = {
              ...this.mergedRawUsage,
              ...u,
            };
          } else {
            this.mergedRawUsage = { __malformed: true };
          }
          const snap = normalizeRawProviderUsage(message.usage, {
            protocol: "anthropic-messages",
            priceSchedule: this.priceSchedule,
            ignorePiLocalCost: true,
          });
          this.snapshots.push(snap);
          return snap;
        }
        return null;
      }
      if (type === "content_block_delta" || type === "content_block_start") {
        this.sawAnthropicContentDelta = true;
        return null;
      }
      if (type === "message_delta") {
        if ("usage" in event && event.usage != null) {
          this.sawUsagePayload = true;
          this.sawAnthropicMessageDeltaUsage = true;
          if (typeof event.usage === "object" && !Array.isArray(event.usage)) {
            const u = event.usage as Record<string, unknown>;
            for (const [k, v] of Object.entries(u)) {
              if (v !== undefined && v !== null) {
                this.mergedRawUsage[k] = v;
              }
            }
          } else {
            this.mergedRawUsage = { __malformed: true };
          }
          const snap = normalizeRawProviderUsage(this.mergedRawUsage, {
            protocol: "anthropic-messages",
            priceSchedule: this.priceSchedule,
            ignorePiLocalCost: true,
          });
          this.snapshots.push(snap);
          return snap;
        }
        return null;
      }
      if (type === "message_stop") {
        this.sawAnthropicMessageStop = true;
        return null;
      }
      return null;
    }

    // OpenAI completions or Ollama stream chunks
    if (typeof event.id === "string" && event.id.length > 0) {
      this.providerResponseId ||= event.id;
    }
    const choices = Array.isArray(event.choices) ? event.choices : undefined;
    const firstChoice =
      choices &&
      choices.length > 0 &&
      typeof choices[0] === "object" &&
      choices[0] !== null
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    const rawUsage =
      event.usage !== undefined && event.usage !== null
        ? event.usage
        : firstChoice?.usage !== undefined && firstChoice?.usage !== null
          ? firstChoice.usage
          : undefined;

    if (rawUsage !== undefined) {
      this.sawUsagePayload = true;
      if (typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
        this.mergedRawUsage = {
          ...this.mergedRawUsage,
          ...(rawUsage as Record<string, unknown>),
        };
      } else {
        this.mergedRawUsage = { __malformed: true };
      }
      const snap = normalizeRawProviderUsage(this.mergedRawUsage, {
        protocol: this.protocol,
        priceSchedule: this.priceSchedule,
        ignorePiLocalCost: true,
      });
      this.snapshots.push(snap);
      return snap;
    }

    return null;
  }

  finalize(options: {
    assistantMessage?: unknown;
    aborted?: boolean;
    streamFailed?: boolean;
  }): NormalizedUsageSnapshotV1 {
    if (this.sawAnyStreamEvent) {
      if (!this.sawUsagePayload) {
        const reason: UsageUnknownReasonV1 = options.aborted
          ? "aborted_before_usage"
          : options.streamFailed
            ? "stream_truncated_before_usage"
            : "usage_missing";
        return normalizeRawProviderUsage(null, {
          protocol: this.protocol,
          priceSchedule: this.priceSchedule,
          defaultUnknownReason: reason,
          ignorePiLocalCost: true,
        });
      }

      if (this.mergedRawUsage.__malformed) {
        return normalizeRawProviderUsage("malformed", {
          protocol: this.protocol,
          priceSchedule: this.priceSchedule,
          ignorePiLocalCost: true,
        });
      }

      // If Anthropic stream ended in error/truncation before message_delta usage arrived,
      // any output_tokens: 0 from message_start after content started is incomplete rather than final measured 0.
      const effectiveRaw = { ...this.mergedRawUsage };
      if (
        this.protocol === "anthropic-messages" &&
        !this.sawAnthropicMessageDeltaUsage &&
        (options.streamFailed ||
          options.aborted ||
          !this.sawAnthropicMessageStop ||
          this.sawAnthropicContentDelta)
      ) {
        delete effectiveRaw.output_tokens;
      }

      return normalizeRawProviderUsage(effectiveRaw, {
        protocol: this.protocol,
        priceSchedule: this.priceSchedule,
        ignorePiLocalCost: true,
      });
    }

    // Fallback when custom streamFunction in tests did not emit onProviderStreamEvent
    const msg =
      options.assistantMessage &&
      typeof options.assistantMessage === "object" &&
      !Array.isArray(options.assistantMessage)
        ? (options.assistantMessage as Record<string, unknown>)
        : undefined;
    if (typeof msg?.responseId === "string" && msg.responseId.length > 0) {
      this.providerResponseId ||= msg.responseId;
    }

    const stopReason = msg?.stopReason;
    const rawUsage = msg?.usage;

    if (
      (stopReason === "error" || stopReason === "aborted" || options.streamFailed) &&
      rawUsage &&
      typeof rawUsage === "object" &&
      !Array.isArray(rawUsage)
    ) {
      const u = rawUsage as Record<string, unknown>;
      const isDefaultZeros =
        (u.input === 0 || u.input === undefined) &&
        (u.output === 0 || u.output === undefined) &&
        (u.totalTokens === 0 || u.totalTokens === undefined) &&
        (u.cacheRead === 0 || u.cacheRead === undefined) &&
        (u.cacheWrite === 0 || u.cacheWrite === undefined) &&
        !("input_tokens" in u) &&
        !("prompt_tokens" in u);
      if (isDefaultZeros) {
        return normalizeRawProviderUsage(null, {
          protocol: this.protocol,
          priceSchedule: this.priceSchedule,
          defaultUnknownReason: options.aborted || stopReason === "aborted"
            ? "aborted_before_usage"
            : "call_failed_before_usage",
          ignorePiLocalCost: true,
        });
      }
    }

    return normalizeRawProviderUsage(rawUsage ?? null, {
      protocol: this.protocol,
      priceSchedule: this.priceSchedule,
      defaultUnknownReason: options.aborted
        ? "aborted_before_usage"
        : options.streamFailed
          ? "call_failed_before_usage"
          : "usage_missing",
      ignorePiLocalCost: Boolean(this.priceSchedule),
    });
  }
}
