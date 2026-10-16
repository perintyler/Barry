import { createHash } from "node:crypto";
import type {
  ExecutionBinding,
  InferencePolicyV1,
  PriceScheduleV1,
} from "./inference-bounds.js";
import {
  type UsageEvidenceV1,
  type UsageSinkV1,
  type UsageStatusV1,
  type UsageUnknownReasonV1,
  calculateCostFromSchedule,
  computeUsageEvidenceDigest,
} from "./inference-usage.js";

export interface ReservedUsageEnvelopeV1 {
  readonly max_calls: number | null;
  readonly max_input_tokens: number | null;
  readonly max_output_tokens: number | null;
  readonly max_cost: number | null;
}

export interface EstimatedUsageBoundV1 {
  readonly mode: "none" | "strict_upper_bound" | "authorized_estimate";
  readonly worst_case_cost: number | null;
  readonly price_version: string | null;
  readonly currency: string | null;
}

export interface AggregatedUsageV1 {
  readonly schema: 1;
  readonly model_call_id: string;
  readonly provider_response_id: string | null;
  readonly status: UsageStatusV1;
  readonly finality: "final" | "incomplete";
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
  readonly observed_event_ids: readonly string[];
  readonly reserved_envelope: ReservedUsageEnvelopeV1 | null;
  readonly estimated_bound: EstimatedUsageBoundV1 | null;
}

export interface UsageReconcileInputV1 {
  readonly binding: ExecutionBinding;
  readonly model_call_id: string;
  readonly revision: number;
  readonly evidence_digest: string;
  readonly aggregate: AggregatedUsageV1;
  readonly finality: "final" | "incomplete";
}

export interface UsageReconcileResultV1 {
  readonly revision: number;
  readonly digest: string;
  readonly disposition: "committed" | "duplicate";
}

export interface UsageReconcilePortV1 {
  reconcile(input: UsageReconcileInputV1): Promise<UsageReconcileResultV1>;
}

export type UsageReconciliationConflictCodeV1 =
  | "empty_evidence"
  | "binding_mismatch"
  | "conflicting_event_digest"
  | "duplicate_sequence"
  | "non_monotonic_snapshot"
  | "contradictory_final_evidence"
  | "conflicting_reconcile_revision";

export class UsageReconciliationConflictError extends Error {
  readonly code: UsageReconciliationConflictCodeV1;
  readonly model_call_id: string;

  constructor(
    code: UsageReconciliationConflictCodeV1,
    modelCallId: string,
    message: string,
  ) {
    super(message);
    this.name = "UsageReconciliationConflictError";
    this.code = code;
    this.model_call_id = modelCallId;
  }
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

export function computeReconcilePayloadDigest(
  input: UsageReconcileInputV1,
): string {
  const canonical = JSON.stringify(canonicalizeValue(input));
  return createHash("sha256").update(canonical).digest("hex");
}

export function extractReservedEnvelope(
  policy: InferencePolicyV1 | null | undefined,
): ReservedUsageEnvelopeV1 | null {
  if (!policy) return null;
  return {
    max_calls: policy.max_calls,
    max_input_tokens: policy.max_input_tokens,
    max_output_tokens: policy.max_output_tokens,
    max_cost: policy.max_cost,
  };
}

export interface ReduceUsageEvidenceOptions {
  readonly policy?: InferencePolicyV1 | null;
  readonly priceSchedule?: PriceScheduleV1 | null;
  readonly inputIncludesCache?: boolean;
  readonly estimatedBound?: EstimatedUsageBoundV1 | null;
}

export interface ReducedUsageOutcomeV1 {
  readonly binding: ExecutionBinding;
  readonly model_call_id: string;
  readonly revision: number;
  readonly evidence_digest: string;
  readonly finality: "final" | "incomplete";
  readonly aggregate: AggregatedUsageV1;
}

function sameBinding(
  a: ExecutionBinding,
  b: ExecutionBinding,
  aSession: string,
  bSession: string,
  aTurn: string,
  bTurn: string,
  aSeg: string,
  bSeg: string,
  aCall: string,
  bCall: string,
): boolean {
  return (
    a.work_id === b.work_id &&
    a.attempt_id === b.attempt_id &&
    a.execution_fence === b.execution_fence &&
    a.owner === b.owner &&
    a.workflow_id === b.workflow_id &&
    a.activity_id === b.activity_id &&
    a.grant_ref === b.grant_ref &&
    a.grant_revision === b.grant_revision &&
    aSession === bSession &&
    aTurn === bTurn &&
    aSeg === bSeg &&
    aCall === bCall
  );
}

function addDelta(current: number | null, delta: number | null): number | null {
  if (delta === null) return current;
  return (current ?? 0) + delta;
}

function mergeMonotonicSnapshotField(
  fieldName: string,
  modelCallId: string,
  priorSnapshot: number | null,
  priorCombined: number | null,
  incoming: number | null,
): { snapshot: number | null; combined: number | null } {
  if (incoming === null) {
    return { snapshot: priorSnapshot, combined: priorCombined };
  }
  if (priorSnapshot !== null && incoming < priorSnapshot) {
    throw new UsageReconciliationConflictError(
      "non_monotonic_snapshot",
      modelCallId,
      `Non-monotonic cumulative usage for ${fieldName} on model_call_id ${modelCallId}: ${incoming} < ${priorSnapshot}`,
    );
  }
  return { snapshot: incoming, combined: incoming };
}

function verifyFinalCompatibility(
  fieldName: string,
  modelCallId: string,
  lockedValue: number | string | null,
  incomingValue: number | string | null,
): void {
  if (lockedValue !== null && incomingValue !== null && lockedValue !== incomingValue) {
    throw new UsageReconciliationConflictError(
      "contradictory_final_evidence",
      modelCallId,
      `Contradictory final usage for ${fieldName} on model_call_id ${modelCallId}: locked=${String(lockedValue)}, incoming=${String(incomingValue)}`,
    );
  }
  if (lockedValue !== null && incomingValue === null) {
    throw new UsageReconciliationConflictError(
      "contradictory_final_evidence",
      modelCallId,
      `Contradictory final usage for ${fieldName} on model_call_id ${modelCallId}: locked=${String(lockedValue)}, incoming=null`,
    );
  }
  if (lockedValue === null && incomingValue !== null) {
    throw new UsageReconciliationConflictError(
      "contradictory_final_evidence",
      modelCallId,
      `Contradictory final usage for ${fieldName} on model_call_id ${modelCallId}: locked=null, incoming=${String(incomingValue)}`,
    );
  }
}

export function reduceUsageEvidence(
  events: readonly UsageEvidenceV1[],
  options?: ReduceUsageEvidenceOptions,
): ReducedUsageOutcomeV1 {
  if (events.length === 0) {
    throw new UsageReconciliationConflictError(
      "empty_evidence",
      "unknown",
      "Cannot reduce an empty UsageEvidenceV1 array",
    );
  }

  const first = events[0]!;
  const uniqueByEventId = new Map<
    string,
    { evidence: UsageEvidenceV1; digest: string }
  >();

  for (const ev of events) {
    if (
      !sameBinding(
        first.binding,
        ev.binding,
        first.session_id,
        ev.session_id,
        first.turn_id,
        ev.turn_id,
        first.segment_id,
        ev.segment_id,
        first.model_call_id,
        ev.model_call_id,
      )
    ) {
      throw new UsageReconciliationConflictError(
        "binding_mismatch",
        first.model_call_id,
        `UsageEvidenceV1 event ${ev.event_id} does not match binding/segment/model_call_id of ${first.event_id}`,
      );
    }

    const digest = computeUsageEvidenceDigest(ev);
    const existing = uniqueByEventId.get(ev.event_id);
    if (existing) {
      if (existing.digest !== digest) {
        throw new UsageReconciliationConflictError(
          "conflicting_event_digest",
          first.model_call_id,
          `Conflicting UsageEvidenceV1 digest for replayed event_id ${ev.event_id}`,
        );
      }
      continue;
    }
    uniqueByEventId.set(ev.event_id, { evidence: ev, digest });
  }

  const sortedEntries = [...uniqueByEventId.values()].sort(
    (a, b) => a.evidence.sequence - b.evidence.sequence,
  );

  for (let i = 1; i < sortedEntries.length; i++) {
    const prev = sortedEntries[i - 1]!.evidence;
    const curr = sortedEntries[i]!.evidence;
    if (prev.sequence === curr.sequence) {
      throw new UsageReconciliationConflictError(
        "duplicate_sequence",
        first.model_call_id,
        `Distinct UsageEvidenceV1 events ${prev.event_id} and ${curr.event_id} share sequence ${curr.sequence}`,
      );
    }
  }

  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;

  let snapshotInput: number | null = null;
  let snapshotOutput: number | null = null;
  let snapshotTotal: number | null = null;
  let snapshotReasoning: number | null = null;
  let snapshotCacheRead: number | null = null;
  let snapshotCacheWrite: number | null = null;

  let reportedCost: number | null = null;
  let currency: string | null = null;
  let calculatedCost: number | null = null;
  let priceVersion: string | null =
    options?.priceSchedule?.version ??
    options?.policy?.price_schedule?.version ??
    null;
  let providerResponseId: string | null = null;
  let latestUnknownReason: UsageUnknownReasonV1 | null = null;
  let sawFinalObservation = false;
  let lockedFinalEvidence: UsageEvidenceV1 | null = null;

  for (const { evidence: ev } of sortedEntries) {
    const isFinalEvent = ev.final || ev.observation_kind === "final";

    if (lockedFinalEvidence !== null) {
      verifyFinalCompatibility(
        "status",
        first.model_call_id,
        lockedFinalEvidence.status,
        ev.status,
      );
      verifyFinalCompatibility(
        "input_tokens",
        first.model_call_id,
        lockedFinalEvidence.input_tokens,
        ev.input_tokens,
      );
      verifyFinalCompatibility(
        "output_tokens",
        first.model_call_id,
        lockedFinalEvidence.output_tokens,
        ev.output_tokens,
      );
      verifyFinalCompatibility(
        "total_tokens",
        first.model_call_id,
        lockedFinalEvidence.total_tokens,
        ev.total_tokens,
      );
      verifyFinalCompatibility(
        "reasoning_tokens",
        first.model_call_id,
        lockedFinalEvidence.reasoning_tokens,
        ev.reasoning_tokens,
      );
      verifyFinalCompatibility(
        "cache_read_tokens",
        first.model_call_id,
        lockedFinalEvidence.cache_read_tokens,
        ev.cache_read_tokens,
      );
      verifyFinalCompatibility(
        "cache_write_tokens",
        first.model_call_id,
        lockedFinalEvidence.cache_write_tokens,
        ev.cache_write_tokens,
      );
      verifyFinalCompatibility(
        "reported_cost",
        first.model_call_id,
        lockedFinalEvidence.reported_cost,
        ev.reported_cost,
      );
      verifyFinalCompatibility(
        "provider_response_id",
        first.model_call_id,
        lockedFinalEvidence.provider_response_id,
        ev.provider_response_id,
      );
    }

    if (ev.provider_response_id !== null) {
      if (
        providerResponseId !== null &&
        providerResponseId !== ev.provider_response_id
      ) {
        throw new UsageReconciliationConflictError(
          "contradictory_final_evidence",
          first.model_call_id,
          `Conflicting provider_response_id on model_call_id ${first.model_call_id}: ${providerResponseId} vs ${ev.provider_response_id}`,
        );
      }
      providerResponseId = ev.provider_response_id;
    }

    if (ev.observation_kind === "delta" && !isFinalEvent) {
      inputTokens = addDelta(inputTokens, ev.input_tokens);
      outputTokens = addDelta(outputTokens, ev.output_tokens);
      totalTokens = addDelta(totalTokens, ev.total_tokens);
      reasoningTokens = addDelta(reasoningTokens, ev.reasoning_tokens);
      cacheReadTokens = addDelta(cacheReadTokens, ev.cache_read_tokens);
      cacheWriteTokens = addDelta(cacheWriteTokens, ev.cache_write_tokens);
    } else {
      // snapshot or final
      const mergedInput = mergeMonotonicSnapshotField(
        "input_tokens",
        first.model_call_id,
        snapshotInput,
        inputTokens,
        ev.input_tokens,
      );
      snapshotInput = mergedInput.snapshot;
      inputTokens = mergedInput.combined;

      const mergedOutput = mergeMonotonicSnapshotField(
        "output_tokens",
        first.model_call_id,
        snapshotOutput,
        outputTokens,
        ev.output_tokens,
      );
      snapshotOutput = mergedOutput.snapshot;
      outputTokens = mergedOutput.combined;

      const mergedTotal = mergeMonotonicSnapshotField(
        "total_tokens",
        first.model_call_id,
        snapshotTotal,
        totalTokens,
        ev.total_tokens,
      );
      snapshotTotal = mergedTotal.snapshot;
      totalTokens = mergedTotal.combined;

      const mergedReasoning = mergeMonotonicSnapshotField(
        "reasoning_tokens",
        first.model_call_id,
        snapshotReasoning,
        reasoningTokens,
        ev.reasoning_tokens,
      );
      snapshotReasoning = mergedReasoning.snapshot;
      reasoningTokens = mergedReasoning.combined;

      const mergedCacheRead = mergeMonotonicSnapshotField(
        "cache_read_tokens",
        first.model_call_id,
        snapshotCacheRead,
        cacheReadTokens,
        ev.cache_read_tokens,
      );
      snapshotCacheRead = mergedCacheRead.snapshot;
      cacheReadTokens = mergedCacheRead.combined;

      const mergedCacheWrite = mergeMonotonicSnapshotField(
        "cache_write_tokens",
        first.model_call_id,
        snapshotCacheWrite,
        cacheWriteTokens,
        ev.cache_write_tokens,
      );
      snapshotCacheWrite = mergedCacheWrite.snapshot;
      cacheWriteTokens = mergedCacheWrite.combined;
    }

    if (ev.reported_cost !== null) {
      if (
        isFinalEvent &&
        reportedCost !== null &&
        ev.reported_cost < reportedCost
      ) {
        throw new UsageReconciliationConflictError(
          "contradictory_final_evidence",
          first.model_call_id,
          `Final reported_cost ${ev.reported_cost} is less than earlier reported_cost ${reportedCost}`,
        );
      }
      reportedCost = ev.reported_cost;
      currency = ev.currency ?? currency;
    }

    if (ev.calculated_cost !== null) {
      calculatedCost = ev.calculated_cost;
    }
    if (ev.price_version !== null) {
      priceVersion = ev.price_version;
    }
    if (ev.unknown_reason !== null) {
      latestUnknownReason = ev.unknown_reason;
    }

    if (isFinalEvent) {
      sawFinalObservation = true;
      lockedFinalEvidence = {
        ...ev,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        reasoning_tokens: reasoningTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        reported_cost: reportedCost,
        provider_response_id: providerResponseId,
      };
    }
  }

  const inputIncludesCache =
    options?.inputIncludesCache ??
    options?.policy?.provider_protocol === "openai-completions";

  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    if (inputIncludesCache) {
      totalTokens = inputTokens + outputTokens;
    } else {
      totalTokens =
        inputTokens +
        outputTokens +
        (cacheReadTokens ?? 0) +
        (cacheWriteTokens ?? 0);
    }
  }

  const schedule =
    options?.priceSchedule ?? options?.policy?.price_schedule ?? null;
  if (schedule) {
    const calc = calculateCostFromSchedule(
      {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        reasoning_tokens: reasoningTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        input_includes_cache: inputIncludesCache,
      },
      schedule,
    );
    calculatedCost = calc.calculated_cost;
    priceVersion = calc.price_version;
  }

  const anyMetric =
    inputTokens !== null ||
    outputTokens !== null ||
    totalTokens !== null ||
    reasoningTokens !== null ||
    cacheReadTokens !== null ||
    cacheWriteTokens !== null ||
    reportedCost !== null;

  let status: UsageStatusV1;
  let unknownReason: UsageUnknownReasonV1 | null = null;
  if (
    inputTokens !== null &&
    outputTokens !== null &&
    latestUnknownReason !== "usage_malformed"
  ) {
    status = "known";
    unknownReason = null;
  } else if (anyMetric) {
    status = "partial";
    unknownReason = latestUnknownReason ?? "usage_incomplete";
  } else {
    status = "unknown";
    unknownReason = latestUnknownReason ?? "usage_missing";
  }

  // Incomplete categories stay incomplete even on terminal call settlement
  const finality: "final" | "incomplete" =
    sawFinalObservation && status === "known" ? "final" : "incomplete";

  const observedEventIds = sortedEntries.map((e) => e.evidence.event_id);
  const evidenceDigest = createHash("sha256")
    .update(
      sortedEntries
        .map((e) => `${e.evidence.event_id}:${e.digest}`)
        .join("|"),
    )
    .digest("hex");

  const aggregate: AggregatedUsageV1 = {
    schema: 1,
    model_call_id: first.model_call_id,
    provider_response_id: providerResponseId,
    status,
    finality,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    reasoning_tokens: reasoningTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reported_cost: reportedCost,
    currency: reportedCost !== null ? currency : null,
    calculated_cost: calculatedCost,
    price_version: priceVersion,
    unknown_reason: unknownReason,
    observed_event_ids: observedEventIds,
    reserved_envelope: extractReservedEnvelope(options?.policy),
    estimated_bound: options?.estimatedBound ?? null,
  };

  return {
    binding: first.binding,
    model_call_id: first.model_call_id,
    revision: observedEventIds.length,
    evidence_digest: evidenceDigest,
    finality,
    aggregate,
  };
}

export interface InMemoryUsageReconcilePortV1 extends UsageReconcilePortV1 {
  readonly records: ReadonlyArray<{
    readonly input: UsageReconcileInputV1;
    readonly digest: string;
  }>;
  getLatest(
    workId: string,
    attemptId: string,
    modelCallId: string,
  ): UsageReconcileInputV1 | undefined;
  getByWorkId(workId: string): ReadonlyArray<UsageReconcileInputV1>;
}

export function createInMemoryUsageReconcilePort(): InMemoryUsageReconcilePortV1 {
  const byCallAndRevision = new Map<
    string,
    { input: UsageReconcileInputV1; digest: string }
  >();
  const latestByCall = new Map<
    string,
    { input: UsageReconcileInputV1; digest: string }
  >();
  const ordered: Array<{ input: UsageReconcileInputV1; digest: string }> = [];

  function callKey(b: ExecutionBinding, modelCallId: string): string {
    return `${b.work_id}:${b.attempt_id}:${b.execution_fence}:${modelCallId}`;
  }

  return {
    get records() {
      return ordered;
    },
    getLatest(workId: string, attemptId: string, modelCallId: string) {
      for (const entry of latestByCall.values()) {
        if (
          entry.input.binding.work_id === workId &&
          entry.input.binding.attempt_id === attemptId &&
          entry.input.model_call_id === modelCallId
        ) {
          return entry.input;
        }
      }
      return undefined;
    },
    getByWorkId(workId: string) {
      const results: UsageReconcileInputV1[] = [];
      for (const entry of latestByCall.values()) {
        if (entry.input.binding.work_id === workId) {
          results.push(entry.input);
        }
      }
      return results;
    },
    async reconcile(
      input: UsageReconcileInputV1,
    ): Promise<UsageReconcileResultV1> {
      const digest = computeReconcilePayloadDigest(input);
      const cKey = callKey(input.binding, input.model_call_id);
      const revKey = `${cKey}#${input.revision}`;

      const existingRev = byCallAndRevision.get(revKey);
      if (existingRev) {
        if (existingRev.digest !== digest) {
          throw new UsageReconciliationConflictError(
            "conflicting_reconcile_revision",
            input.model_call_id,
            `Conflicting reconcile payload for ${revKey}: expected digest ${existingRev.digest}, got ${digest}`,
          );
        }
        return {
          revision: input.revision,
          digest,
          disposition: "duplicate",
        };
      }

      const latest = latestByCall.get(cKey);
      if (latest) {
        if (
          latest.input.finality === "final" &&
          latest.input.evidence_digest !== input.evidence_digest
        ) {
          throw new UsageReconciliationConflictError(
            "contradictory_final_evidence",
            input.model_call_id,
            `Cannot overwrite finalized usage aggregate for model_call_id ${input.model_call_id} with different evidence`,
          );
        }
        if (input.revision < latest.input.revision) {
          throw new UsageReconciliationConflictError(
            "conflicting_reconcile_revision",
            input.model_call_id,
            `Stale unseen reconcile revision ${input.revision} < latest ${latest.input.revision} for model_call_id ${input.model_call_id}`,
          );
        }
      }

      const cloned = { input: structuredClone(input), digest };
      byCallAndRevision.set(revKey, cloned);
      if (!latest || input.revision >= latest.input.revision) {
        latestByCall.set(cKey, cloned);
      }
      ordered.push(cloned);
      return {
        revision: input.revision,
        digest,
        disposition: "committed",
      };
    },
  };
}

/**
 * Coordinates appending `UsageEvidenceV1` records to a `UsageSinkV1` and
 * reconciling the reduced `AggregatedUsageV1` through `UsageReconcilePortV1`.
 * Safe across duplicate replays, lost acknowledgements, and crash recovery.
 */
export class UsageAccountingCoordinator {
  private readonly sink?: UsageSinkV1;
  private readonly reconcilePort?: UsageReconcilePortV1;
  private readonly policy?: InferencePolicyV1 | null;
  private readonly estimatedBound?: EstimatedUsageBoundV1 | null;
  private readonly eventsByCall = new Map<string, UsageEvidenceV1[]>();

  constructor(options: {
    sink?: UsageSinkV1;
    reconcilePort?: UsageReconcilePortV1;
    policy?: InferencePolicyV1 | null;
    estimatedBound?: EstimatedUsageBoundV1 | null;
  }) {
    this.sink = options.sink;
    this.reconcilePort = options.reconcilePort;
    this.policy = options.policy ?? null;
    this.estimatedBound = options.estimatedBound ?? null;
  }

  async recordAndReconcile(
    evidence: UsageEvidenceV1,
    options?: { reconcileNow?: boolean },
  ): Promise<{
    sinkResult?: {
      event_id: string;
      digest: string;
      disposition: "committed" | "duplicate";
    };
    reduced: ReducedUsageOutcomeV1;
    reconcileResult?: UsageReconcileResultV1;
  }> {
    const list = this.eventsByCall.get(evidence.model_call_id) ?? [];
    const candidateList = [...list, evidence];

    // Reduce first to catch any monotonic or final contradiction before committing
    const reduced = reduceUsageEvidence(candidateList, {
      policy: this.policy,
      estimatedBound: this.estimatedBound,
    });

    let sinkResult:
      | {
          event_id: string;
          digest: string;
          disposition: "committed" | "duplicate";
        }
      | undefined;
    if (this.sink) {
      sinkResult = await this.sink.append(evidence);
    }

    this.eventsByCall.set(evidence.model_call_id, candidateList);

    let reconcileResult: UsageReconcileResultV1 | undefined;
    const shouldReconcile = options?.reconcileNow ?? evidence.final;
    if (this.reconcilePort && shouldReconcile) {
      reconcileResult = await this.reconcilePort.reconcile({
        binding: reduced.binding,
        model_call_id: reduced.model_call_id,
        revision: reduced.revision,
        evidence_digest: reduced.evidence_digest,
        aggregate: reduced.aggregate,
        finality: reduced.finality,
      });
    }

    return {
      sinkResult,
      reduced,
      reconcileResult,
    };
  }

  getReducedCall(modelCallId: string): ReducedUsageOutcomeV1 | null {
    const list = this.eventsByCall.get(modelCallId);
    if (!list || list.length === 0) return null;
    return reduceUsageEvidence(list, {
      policy: this.policy,
      estimatedBound: this.estimatedBound,
    });
  }
}
