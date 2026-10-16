import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuationHarness, SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter, {
  DEFAULT_PI_IMPLEMENTATION_VERSION,
  ProviderStreamUsageTracker,
  UsageAccountingCoordinator,
  buildUsageEvidence,
  createDefaultExecutionBinding,
  createInMemoryUsageReconcilePort,
  type ExecutionAccessV1,
  type InferenceFaultV1,
  type InferencePolicyV1,
  type PiAdapterStartConfig,
} from "../adapter.js";
import type { PiContinuation } from "./continuation.js";
import {
  createLoopbackInferenceProvider,
  type LoopbackInferenceProvider,
} from "./fixtures/inference-provider.js";

function makeExecutionAccess(policy: InferencePolicyV1): ExecutionAccessV1 {
  const b = policy.binding;
  return {
    version: 1,
    delegation: {
      version: 1,
      namespace: {
        installation: b.owner,
        task_queue: "work-tq",
        workflow_id: b.workflow_id,
      },
      grant: {
        grant_ref: b.grant_ref,
        revision: b.grant_revision,
      },
      start: {
        owner: b.owner,
        work_id: b.work_id,
        workflow_id: b.workflow_id,
        activity_id: b.activity_id,
        attempt_id: b.attempt_id,
        request_hash: b.request_hash,
        plan_digest: b.plan_digest,
        grant_ref: b.grant_ref,
        grant_revision: b.grant_revision,
        source: b.source,
        execution_fence: b.execution_fence,
        deadline: b.deadline,
        launch_authorized: true,
        agent_program: {
          profile: { digest: policy.accepted_profile_digest },
        },
        resources: {
          host_reservation: { id: "res-host-1" },
          endpoint: {
            endpoint: policy.endpoint_ref,
            reservation: { id: "res-ep-1" },
          },
        },
      },
    },
    connection: {
      effect: async () => true,
    },
    signal: new AbortController().signal,
  };
}

describe("Pi Inference Accounting & Endpoint Controls Performance / Resource Bounds", () => {
  let root: string;
  let provider: LoopbackInferenceProvider;
  let harnesses: ContinuationHarness[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "pi-inference-perf-"));
    harnesses = [];
    vi.stubEnv("HOME", root);
    vi.stubEnv("BARRY_HOME", join(root, "barry"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi"));
    provider = await createLoopbackInferenceProvider();
  });

  afterEach(async () => {
    await Promise.allSettled(harnesses.map((h) => h.close()));
    await provider.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function openHarness(config: PiAdapterStartConfig): Promise<PiContinuation> {
    const harness = await adapter.modes.hosted!.openContinuation!(
      config as SessionConfig,
      async () => {
        throw new Error("Unexpected MCP engine start");
      },
    );
    harnesses.push(harness);
    return harness as PiContinuation;
  }

  it("processes 1,000 streaming SSE events and multi-stage reconciliations with bounded O(1) per-chunk state", async () => {
    const reconcilePort = createInMemoryUsageReconcilePort();
    const coordinator = new UsageAccountingCoordinator({ reconcilePort });
    const tracker = new ProviderStreamUsageTracker({
      protocol: "anthropic-messages",
    });
    const binding = createDefaultExecutionBinding({
      work_id: "work-perf-1",
    });

    const startMs = performance.now();
    const startSnap = tracker.observeStreamEvent({
      type: "message_start",
      message: {
        id: "msg_perf_1",
        usage: {
          input_tokens: 512,
          output_tokens: 0,
          cache_read_input_tokens: 1024,
        },
      },
    });
    expect(startSnap).not.toBeNull();

    for (let i = 0; i < 1_000; i += 1) {
      tracker.observeStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "token " },
      });
    }

    tracker.observeStreamEvent({
      type: "message_delta",
      usage: { output_tokens: 1_000 },
    });
    tracker.observeStreamEvent({
      type: "message_stop",
    });
    const finalSnap = tracker.finalize({});

    const snapshotEvidence = buildUsageEvidence({
      binding,
      session_id: "sess-perf-1",
      turn_id: "turn-perf-1",
      segment_id: "seg-perf-1",
      model_call_id: "call-1",
      sequence: 1,
      observation_kind: "snapshot",
      provider_response_id: tracker.responseId,
      snapshot: startSnap!,
      final: false,
    });
    const finalEvidence = buildUsageEvidence({
      binding,
      session_id: "sess-perf-1",
      turn_id: "turn-perf-1",
      segment_id: "seg-perf-1",
      model_call_id: "call-1",
      sequence: 2,
      observation_kind: "final",
      provider_response_id: tracker.responseId,
      snapshot: finalSnap,
      final: true,
    });

    await coordinator.recordAndReconcile(snapshotEvidence);
    const { reduced } = await coordinator.recordAndReconcile(finalEvidence);
    const elapsedMs = performance.now() - startMs;

    expect(elapsedMs).toBeLessThan(500);
    expect(reduced.aggregate).toMatchObject({
      status: "known",
      finality: "final",
      input_tokens: 512,
      output_tokens: 1_000,
      cache_read_tokens: 1_024,
      total_tokens: 2_536,
    });
  });

  it("enforces in-flight policy deadline via AbortSignal without leaking sockets or hanging", async () => {
    provider.enqueue({
      kind: "openai_sse",
      model: "probe",
      text: "Slow response that exceeds deadline",
      delayBeforeBodyMs: 2_000,
      chunkUsage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });

    await Promise.all([
      import("./sdk-session.js"),
      import("./continuation.js"),
      import("@earendil-works/pi-coding-agent"),
      import("@earendil-works/pi-ai"),
    ]);

    const faults: InferenceFaultV1[] = [];
    const now = Date.now();
    const harness = await openHarness({
      sessionId: "deadline-session",
      cwd: root,
      env: { HOME: root },
      model: "openai/probe",
      endpoint: { baseUrl: provider.openAiBaseUrl, apiKey: "oai-loopback-key" },
      mcpServers: {},
      allowedNativeTools: [],
      inferencePolicy: {
        version: 1,
        binding: createDefaultExecutionBinding(),
        session_id: "deadline-session",
        turn_id: "turn-deadline",
        segment_id: "seg-deadline",
        accepted_profile_digest: "d".repeat(64),
        endpoint_ref: "endpoint://loopback",
        provider_protocol: "openai-completions",
        implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
        model: "probe",
        deadline: now + 800,
        max_calls: null,
        max_input_tokens: null,
        max_output_tokens: null,
        max_cost: null,
        fallback_policy: "none",
        accounting_policy: "reconciled",
      },
      onFault: (f: InferenceFaultV1) => {
        faults.push(f);
      },
    });

    const startMs = Date.now();
    const outcome = await harness.begin("Slow call", async () => {});
    const durationMs = Date.now() - startMs;

    expect(outcome.type).toBe("failed");
    expect(durationMs).toBeLessThan(1_500);
    expect(provider.requests).toHaveLength(1);
    expect(faults).toHaveLength(1);
    expect(["timeout", "aborted"]).toContain(faults[0]!.category);
  });

  it("isolates concurrent runs across shared endpoint and shared UsageReconcilePortV1", async () => {
    const sharedReconcilePort = createInMemoryUsageReconcilePort();
    provider.setHandler((req, index) => {
      const promptTokens = (index + 1) * 10;
      const completionTokens = (index + 1) * 5;
      return {
        kind: "openai_sse",
        model: String(req.parsedBody?.model ?? "probe"),
        text: `Concurrent reply ${index + 1}`,
        chunkUsage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    });

    const workIds = ["work-c1", "work-c2", "work-c3", "work-c4"];
    const opened = await Promise.all(
      workIds.map((workId) => {
        const policy: InferencePolicyV1 = {
          version: 1,
          binding: createDefaultExecutionBinding({ work_id: workId }),
          session_id: `concurrent-${workId}`,
          turn_id: `turn-${workId}`,
          segment_id: `seg-${workId}`,
          accepted_profile_digest: "d".repeat(64),
          endpoint_ref: "endpoint://shared-loopback",
          provider_protocol: "openai-completions",
          implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
          model: "probe",
          deadline: 4_102_444_800_000,
          max_calls: null,
          max_input_tokens: null,
          max_output_tokens: 128,
          max_cost: null,
          fallback_policy: "none",
          accounting_policy: "reconciled",
        };
        return openHarness({
          sessionId: `concurrent-${workId}`,
          cwd: root,
          env: { HOME: root },
          model: "openai/probe",
          endpoint: { baseUrl: provider.openAiBaseUrl, apiKey: "shared-endpoint-key" },
          mcpServers: {},
          allowedNativeTools: [],
          executionAccess: makeExecutionAccess(policy),
          inferencePolicy: policy,
          usageReconcilePort: sharedReconcilePort,
        });
      }),
    );

    const outcomes = await Promise.all(
      opened.map((h, idx) => h.begin(`Prompt ${idx + 1}`, async () => {})),
    );

    for (const outcome of outcomes) {
      expect(outcome.type).toBe("completed");
    }

    expect(provider.requests).toHaveLength(4);
    for (const workId of workIds) {
      const records = sharedReconcilePort.getByWorkId(workId);
      expect(records).toHaveLength(1);
      expect(records[0]!.aggregate.status).toBe("known");
      expect(records[0]!.finality).toBe("final");
    }
  });
});
