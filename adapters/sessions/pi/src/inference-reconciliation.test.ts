import { describe, expect, it } from "vitest";
import { createDefaultExecutionBinding } from "./inference-bounds.js";
import {
  UsageAccountingCoordinator,
  UsageReconciliationConflictError,
  createInMemoryUsageReconcilePort,
  reduceUsageEvidence,
} from "./inference-reconciliation.js";
import {
  createDeterministicUsageEventId,
  createInMemoryUsageSink,
  type UsageEvidenceV1,
} from "./inference-usage.js";

function makeEvidence(overrides: Partial<UsageEvidenceV1> = {}): UsageEvidenceV1 {
  const binding = overrides.binding ?? createDefaultExecutionBinding();
  const segment_id = overrides.segment_id ?? "seg-rec-1";
  const model_call_id = overrides.model_call_id ?? "call-1";
  const sequence = overrides.sequence ?? 1;
  const observation_kind = overrides.observation_kind ?? "delta";
  const event_id =
    overrides.event_id ??
    createDeterministicUsageEventId({
      binding,
      segment_id,
      model_call_id,
      sequence,
      observation_kind,
    });
  return {
    schema: 1,
    binding,
    session_id: "sess-rec-1",
    turn_id: "turn-rec-1",
    segment_id,
    model_call_id,
    event_id,
    sequence,
    observation_kind,
    provider_response_id: "resp-1",
    status: "partial",
    input_tokens: 50,
    output_tokens: null,
    total_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reported_cost: null,
    currency: null,
    calculated_cost: null,
    price_version: null,
    final: observation_kind === "final",
    unknown_reason: "usage_incomplete",
    ...overrides,
  };
}

describe("UsageReconcilePortV1 and replay/recovery deduplication", () => {
  it("monotonically upgrades delta -> snapshot -> final without double-counting across out-of-order and duplicate replays", () => {
    const delta = makeEvidence({
      observation_kind: "delta",
      sequence: 1,
      status: "partial",
      input_tokens: 100,
      output_tokens: null,
      final: false,
    });
    const snapshot = makeEvidence({
      observation_kind: "snapshot",
      sequence: 2,
      status: "partial",
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: null,
      final: false,
    });
    const finalEv = makeEvidence({
      observation_kind: "final",
      sequence: 3,
      status: "known",
      input_tokens: 100,
      output_tokens: 45,
      total_tokens: 145,
      calculated_cost: 0.001,
      price_version: "v1",
      final: true,
      unknown_reason: null,
    });

    // Out-of-order and duplicate replay delivery: [delta, finalEv, snapshot, delta, finalEv]
    const outcome = reduceUsageEvidence([delta, finalEv, snapshot, delta, finalEv]);
    expect(outcome.revision).toBe(3);
    expect(outcome.finality).toBe("final");
    expect(outcome.aggregate.status).toBe("known");
    expect(outcome.aggregate.input_tokens).toBe(100);
    expect(outcome.aggregate.output_tokens).toBe(45);
    expect(outcome.aggregate.total_tokens).toBe(145);
    expect(outcome.aggregate.calculated_cost).toBe(0.001);
  });

  it("preserves partial counters and marks finality incomplete when stream truncates and final is partial/unknown", () => {
    const snapshotWithInput = makeEvidence({
      observation_kind: "snapshot",
      sequence: 1,
      status: "partial",
      input_tokens: 80,
      output_tokens: null,
      final: false,
      unknown_reason: "usage_incomplete",
    });
    const unknownFinalAfterCrash = makeEvidence({
      observation_kind: "final",
      sequence: 2,
      status: "unknown",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      final: true,
      unknown_reason: "stream_truncated_before_usage",
    });

    const outcome = reduceUsageEvidence([snapshotWithInput, unknownFinalAfterCrash]);
    expect(outcome.revision).toBe(2);
    expect(outcome.finality).toBe("incomplete");
    expect(outcome.aggregate.status).toBe("partial");
    expect(outcome.aggregate.input_tokens).toBe(80);
    expect(outcome.aggregate.output_tokens).toBeNull();
  });

  it("reconciles multiple model calls in a work item independently and tracks latest per call", async () => {
    const sink = createInMemoryUsageSink();
    const port = createInMemoryUsageReconcilePort();
    const coordinator = new UsageAccountingCoordinator({
      sink,
      reconcilePort: port,
    });

    const call1 = makeEvidence({
      model_call_id: "call-1",
      observation_kind: "final",
      sequence: 1,
      status: "known",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      calculated_cost: 0.001,
      final: true,
      unknown_reason: null,
    });
    const call2 = makeEvidence({
      model_call_id: "call-2",
      observation_kind: "final",
      sequence: 1,
      status: "partial",
      input_tokens: 60,
      output_tokens: null,
      total_tokens: null,
      final: true,
      unknown_reason: "usage_incomplete",
    });

    await coordinator.recordAndReconcile(call1);
    await coordinator.recordAndReconcile(call2);

    const workRecords = port.getByWorkId(call1.binding.work_id);
    expect(workRecords).toHaveLength(2);
    expect(workRecords[0]!.aggregate.status).toBe("known");
    expect(workRecords[0]!.finality).toBe("final");
    expect(workRecords[1]!.aggregate.status).toBe("partial");
    expect(workRecords[1]!.finality).toBe("incomplete");
  });

  it("is idempotent on replay after lost acknowledgement and rejects contradictory final records", async () => {
    const sink = createInMemoryUsageSink();
    const port = createInMemoryUsageReconcilePort();
    const coordinator = new UsageAccountingCoordinator({
      sink,
      reconcilePort: port,
    });

    const final1 = makeEvidence({
      observation_kind: "final",
      sequence: 1,
      status: "known",
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      final: true,
      unknown_reason: null,
    });
    const final2Contradictory = makeEvidence({
      observation_kind: "final",
      sequence: 2,
      status: "known",
      input_tokens: 20,
      output_tokens: 11,
      total_tokens: 31,
      final: true,
      unknown_reason: null,
    });

    const firstRes = await coordinator.recordAndReconcile(final1);
    expect(firstRes.sinkResult?.disposition).toBe("committed");
    expect(firstRes.reconcileResult?.disposition).toBe("committed");

    // Replaying exact same final after lost acknowledgement succeeds idempotently
    const replayRes = await coordinator.recordAndReconcile(final1);
    expect(replayRes.sinkResult?.disposition).toBe("duplicate");
    expect(replayRes.reconcileResult?.disposition).toBe("duplicate");

    // Contradictory final fails closed
    await expect(
      coordinator.recordAndReconcile(final2Contradictory),
    ).rejects.toThrowError(UsageReconciliationConflictError);
  });
});
