import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuationHarness, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import adapter, {
  DEFAULT_PI_IMPLEMENTATION_VERSION,
  createDefaultExecutionBinding,
  createInMemoryUsageReconcilePort,
  createInMemoryUsageSink,
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

function makePolicy(overrides: Partial<InferencePolicyV1> = {}): InferencePolicyV1 {
  return {
    version: 1,
    binding: createDefaultExecutionBinding(),
    session_id: "sess-loopback",
    turn_id: "turn-loopback",
    segment_id: "seg-loopback",
    accepted_profile_digest: "d".repeat(64),
    endpoint_ref: "endpoint://loopback",
    provider_protocol: "anthropic-messages",
    implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
    model: "claude-sonnet-5",
    deadline: 4_102_444_800_000,
    max_calls: null,
    max_input_tokens: null,
    max_output_tokens: null,
    max_cost: null,
    tokenizer_id: null,
    price_schedule: null,
    fallback_policy: "none",
    accounting_policy: "reconciled",
    ...overrides,
  };
}

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

describe("Pi Hosted Loopback Inference Provider Protocol & Accounting", () => {
  let root: string;
  let provider: LoopbackInferenceProvider;
  let harnesses: ContinuationHarness[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "pi-inference-provider-"));
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
        throw new Error("Unexpected MCP engine start in loopback provider test");
      },
    );
    harnesses.push(harness);
    return harness as PiContinuation;
  }

  it("enforces max_output_tokens on wire and records known Anthropic usage + cost without double-counting cache tokens", async () => {
    provider.enqueue({
      kind: "anthropic_sse",
      model: "claude-sonnet-5",
      text: "Measured response",
      messageStartUsage: {
        input_tokens: 120,
        output_tokens: 0,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 80,
      },
      messageDeltaUsage: {
        output_tokens: 45,
      },
    });

    const sink = createInMemoryUsageSink();
    const reconcilePort = createInMemoryUsageReconcilePort();
    const policy = makePolicy({
      session_id: "anth-known-session",
      segment_id: "seg-anth-1",
      provider_protocol: "anthropic-messages",
      model: "claude-sonnet-5",
      max_output_tokens: 320,
      price_schedule: {
        version: "anth-2026-10",
        currency: "USD",
        rates: {
          input_per_million: 3,
          output_per_million: 15,
          cache_read_per_million: 0.3,
          cache_write_per_million: 3.75,
        },
      },
    });

    const harness = await openHarness({
      sessionId: "anth-known-session",
      cwd: root,
      env: { HOME: root },
      model: "anthropic/claude-sonnet-5",
      endpoint: { baseUrl: provider.anthropicBaseUrl, apiKey: "anth-loopback-key" },
      mcpServers: {},
      allowedNativeTools: [],
      inferencePolicy: policy,
      usageSink: sink,
      usageReconcilePort: reconcilePort,
    });

    const events: SessionEvent[] = [];
    const outcome = await harness.begin("Hello Anthropic", async (ev) => {
      events.push(ev);
    });

    expect(outcome).toMatchObject({
      type: "completed",
      result: "Measured response",
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.parsedBody?.max_tokens).toBe(320);

    const finals = sink.records
      .map((r) => r.evidence)
      .filter((e) => e.observation_kind === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      session_id: "anth-known-session",
      segment_id: "seg-anth-1",
      status: "known",
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 300,
      cache_write_tokens: 80,
      total_tokens: 545,
      price_version: "anth-2026-10",
      final: true,
      unknown_reason: null,
    });
    const expectedCost = (120 * 3 + 45 * 15 + 300 * 0.3 + 80 * 3.75) / 1_000_000;
    expect(finals[0]!.calculated_cost).toBeCloseTo(expectedCost, 10);

    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 545,
      },
    });
  });

  it("records unknown usage when OpenAI SSE stream omits usage rather than fabricating 0", async () => {
    provider.enqueue({
      kind: "openai_sse",
      model: "probe",
      text: "Reply without usage",
      chunkUsage: null,
    });

    const sink = createInMemoryUsageSink();
    const policy = makePolicy({
      session_id: "oai-unknown-session",
      segment_id: "seg-oai-unknown",
      provider_protocol: "openai-completions",
      model: "probe",
      max_output_tokens: 150,
    });

    const harness = await openHarness({
      sessionId: "oai-unknown-session",
      cwd: root,
      env: { HOME: root },
      model: "openai/probe",
      endpoint: { baseUrl: provider.openAiBaseUrl, apiKey: "oai-loopback-key" },
      mcpServers: {},
      allowedNativeTools: [],
      inferencePolicy: policy,
      usageSink: sink,
    });

    const events: SessionEvent[] = [];
    const outcome = await harness.begin("Prompt with omitted usage", async (ev) => {
      events.push(ev);
    });

    expect(outcome).toMatchObject({
      type: "completed",
      result: "Reply without usage",
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.parsedBody?.max_tokens).toBe(150);

    // Must NOT emit a fabricated 0 usage event
    expect(events.filter((e) => e.type === "usage")).toEqual([]);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.evidence).toMatchObject({
      status: "unknown",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      reported_cost: null,
      calculated_cost: null,
      final: false,
      unknown_reason: "usage_missing",
    });
  });

  it("preserves measured 0 token usage as status=known", async () => {
    provider.enqueue({
      kind: "openai_sse",
      model: "probe",
      text: "",
      chunkUsage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });

    const sink = createInMemoryUsageSink();
    const policy = makePolicy({
      session_id: "oai-zero-session",
      segment_id: "seg-oai-zero",
      provider_protocol: "openai-completions",
      model: "probe",
    });

    const harness = await openHarness({
      sessionId: "oai-zero-session",
      cwd: root,
      env: { HOME: root },
      model: "openai/probe",
      endpoint: { baseUrl: provider.openAiBaseUrl, apiKey: "oai-loopback-key" },
      mcpServers: {},
      allowedNativeTools: [],
      inferencePolicy: policy,
      usageSink: sink,
    });

    const events: SessionEvent[] = [];
    const outcome = await harness.begin("Zero token probe", async (ev) => {
      events.push(ev);
    });

    expect(outcome.type).toBe("completed");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.evidence).toMatchObject({
      status: "known",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      final: true,
      unknown_reason: null,
    });
    expect(events.filter((e) => e.type === "usage")).toMatchObject([
      {
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
  });

  it("captures partial usage and midstream fault when Anthropic SSE stream truncates midstream", async () => {
    provider.enqueue({
      kind: "anthropic_sse",
      model: "claude-sonnet-5",
      text: "Partial stream before socket drop",
      messageStartUsage: {
        input_tokens: 64,
      },
      truncateMidstream: true,
    });

    const sink = createInMemoryUsageSink();
    const faults: InferenceFaultV1[] = [];
    const policy = makePolicy({
      session_id: "anth-trunc-session",
      segment_id: "seg-anth-trunc",
      provider_protocol: "anthropic-messages",
      model: "claude-sonnet-5",
    });

    const harness = await openHarness({
      sessionId: "anth-trunc-session",
      cwd: root,
      env: { HOME: root },
      model: "anthropic/claude-sonnet-5",
      endpoint: { baseUrl: provider.anthropicBaseUrl, apiKey: "anth-loopback-key" },
      mcpServers: {},
      allowedNativeTools: [],
      inferencePolicy: policy,
      usageSink: sink,
      onFault: (f: InferenceFaultV1) => {
        faults.push(f);
      },
    });

    const outcome = await harness.begin("Truncate me", async () => {});
    expect(outcome.type).toBe("failed");
    expect(provider.requests).toHaveLength(1);

    // Partial usage from message_start must be preserved, never overwritten with 0
    const reconciled = harness.getReconciledUsage();
    expect(reconciled).not.toBeNull();
    expect(reconciled?.aggregate.status).toBe("partial");
    expect(reconciled?.aggregate.input_tokens).toBe(64);
    expect(reconciled?.aggregate.output_tokens).toBeNull();

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      request_phase: "midstream",
      admission_certainty: "acknowledged",
    });
  });

  it("classifies 429 with Retry-After, suppresses internal SDK retry, and redacts secrets", async () => {
    const fakeKey = ["sk-ant", "api03", "SUPERSECRETKEY123456789"].join("-");
    provider.enqueue({
      kind: "http_error",
      status: 429,
      headers: {
        "retry-after": "12",
      },
      body: {
        error: {
          message:
            `Rate limit exceeded for key ${fakeKey} with Authorization: Bearer secret-jwt-token`,
        },
      },
    });

    const faults: InferenceFaultV1[] = [];
    const policy = makePolicy({
      session_id: "anth-429-session",
      segment_id: "seg-429",
      provider_protocol: "anthropic-messages",
      model: "claude-sonnet-5",
    });

    const harness = await openHarness({
      sessionId: "anth-429-session",
      cwd: root,
      env: { HOME: root },
      model: "anthropic/claude-sonnet-5",
      endpoint: { baseUrl: provider.anthropicBaseUrl, apiKey: "anth-loopback-key" },
      mcpServers: {},
      allowedNativeTools: [],
      inferencePolicy: policy,
      onFault: (f: InferenceFaultV1) => {
        faults.push(f);
      },
    });

    const outcome = await harness.begin("Trigger 429", async () => {});
    expect(outcome.type).toBe("failed");
    // Must not blindly retry!
    expect(provider.requests).toHaveLength(1);

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      category: "rate_limited",
      status: 429,
      request_phase: "after_headers",
      admission_certainty: "acknowledged",
      retry_after: {
        source: "retry-after-seconds",
        delay_ms: 12_000,
      },
      retryable_by_policy: false,
      safe_to_reschedule: true,
    });
    expect(faults[0]!.public_message).not.toContain(fakeKey);
    expect(faults[0]!.public_message).not.toContain("secret-jwt-token");
    if (outcome.type === "failed") {
      expect(outcome.error).not.toContain(fakeKey);
      expect(outcome.error).not.toContain("secret-jwt-token");
    }
  });

  it("refuses unsupported strict pre-send policies before dispatching any network request", async () => {
    const policy = makePolicy({
      session_id: "refused-session",
      segment_id: "seg-refuse",
      provider_protocol: "openai-completions",
      model: "probe",
      max_input_tokens: 500, // Requires supported tokenizer
    });

    await expect(
      openHarness({
        sessionId: "refused-session",
        cwd: root,
        env: { HOME: root },
        model: "openai/probe",
        endpoint: { baseUrl: provider.openAiBaseUrl, apiKey: "oai-loopback-key" },
        mcpServers: {},
        allowedNativeTools: [],
        inferencePolicy: policy,
      }),
    ).rejects.toThrow(/Hard max_input_tokens \(500\) cannot be enforced/);

    expect(provider.requests).toHaveLength(0);
  });

  it("decouples execution placement from inference endpoint placement via ExecutionAccessV1", async () => {
    for (const workSuffix of ["sbx-1", "ctr-1", "rmt-1"]) {
      provider.enqueue({
        kind: "openai_sse",
        model: "probe",
        text: `Served for ${workSuffix}`,
        chunkUsage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });

      const policy = makePolicy({
        binding: createDefaultExecutionBinding({
          work_id: `work-${workSuffix}`,
        }),
        session_id: `session-${workSuffix}`,
        segment_id: `seg-${workSuffix}`,
        endpoint_ref: `endpoint://${workSuffix}`,
        provider_protocol: "openai-completions",
        model: "probe",
        max_output_tokens: 64,
      });
      const access = makeExecutionAccess(policy);

      const sink = createInMemoryUsageSink();
      const harness = await openHarness({
        sessionId: `session-${workSuffix}`,
        cwd: root,
        env: { HOME: root },
        model: "openai/probe",
        endpoint: { baseUrl: provider.openAiBaseUrl, apiKey: "oai-loopback-key" },
        mcpServers: {},
        allowedNativeTools: [],
        executionAccess: access,
        inferencePolicy: policy,
        usageSink: sink,
      });

      const outcome = await harness.begin(`Hello from ${workSuffix}`, async () => {});
      expect(outcome).toMatchObject({
        type: "completed",
        result: `Served for ${workSuffix}`,
      });
      expect(sink.records.at(-1)?.evidence).toMatchObject({
        status: "known",
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
      });
    }
  });
});
