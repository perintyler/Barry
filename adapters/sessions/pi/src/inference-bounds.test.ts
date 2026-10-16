import { describe, expect, it } from "vitest";
import {
  DEFAULT_PI_IMPLEMENTATION_VERSION,
  InferencePolicyViolationError,
  authorizeExecutionAccessOnline,
  createDefaultExecutionBinding,
  evaluateInferencePolicyPreSend,
  fingerprintInferencePolicy,
  getDefaultProviderLimitCapabilities,
  validateInferencePolicy,
  verifyExecutionAccess,
  type ExecutionAccessV1,
  type InferencePolicyV1,
} from "./inference-bounds.js";

function basePolicy(overrides: Partial<InferencePolicyV1> = {}): InferencePolicyV1 {
  return {
    version: 1,
    binding: createDefaultExecutionBinding(),
    session_id: "sess-p6b-1",
    turn_id: "turn-p6b-1",
    segment_id: "seg-p6b-1",
    accepted_profile_digest: "d".repeat(64),
    endpoint_ref: "endpoint://anthropic-primary",
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

function makeValidExecutionAccess(
  policy: InferencePolicyV1,
  options: {
    endpointRef?: string;
    effectAuthorized?: boolean;
    aborted?: boolean;
  } = {},
): ExecutionAccessV1 {
  const b = policy.binding;
  const controller = new AbortController();
  if (options.aborted) controller.abort();
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
          profile: {
            digest: policy.accepted_profile_digest,
          },
        },
        resources: {
          host_reservation: {
            id: "res-host-1",
          },
          ...(options.endpointRef
            ? {
                endpoint: {
                  endpoint: options.endpointRef,
                  reservation: { id: "res-ep-1" },
                },
              }
            : {}),
        },
      },
    },
    connection: {
      effect: async () => options.effectAuthorized ?? true,
    },
    signal: controller.signal,
  };
}

describe("InferencePolicyV1 validation and pre-send enforcement", () => {
  it("validates well-formed policy and projects max_output_tokens to wireField", () => {
    const policy = basePolicy({ max_output_tokens: 512 });
    const evaluated = evaluateInferencePolicyPreSend({
      policy,
      endpoint: { protocol: "anthropic-messages", model: "claude-sonnet-5" },
      nowMs: 1_000,
    });
    expect(evaluated.wireMaxOutputTokens).toBe(512);
    expect(evaluated.wireField).toBe("max_tokens");
    expect(evaluated.capabilities.supports_retry_disable).toBe(true);
    expect(evaluated.capabilities.supports_transport_abort).toBe(true);
  });

  it("projects max_output_tokens to max_completion_tokens or options.num_predict based on protocol and capabilities", () => {
    const oaiPolicy = basePolicy({
      provider_protocol: "openai-completions",
      model: "gpt-4o",
      max_output_tokens: 256,
    });
    const oaiEvaluated = evaluateInferencePolicyPreSend({
      policy: oaiPolicy,
      capabilities: getDefaultProviderLimitCapabilities("openai-completions", {
        output_limit_wire_field: "max_completion_tokens",
      }),
      endpoint: { protocol: "openai-completions", model: "gpt-4o" },
    });
    expect(oaiEvaluated.wireField).toBe("max_completion_tokens");
    expect(oaiEvaluated.wireMaxOutputTokens).toBe(256);

    const ollamaPolicy = basePolicy({
      provider_protocol: "ollama-chat",
      model: "qwen3:8b",
      max_output_tokens: 128,
    });
    const ollamaEvaluated = evaluateInferencePolicyPreSend({
      policy: ollamaPolicy,
      endpoint: { protocol: "ollama-chat", model: "qwen3:8b" },
    });
    expect(ollamaEvaluated.wireField).toBe("options.num_predict");
    expect(ollamaEvaluated.wireMaxOutputTokens).toBe(128);
  });

  it("refuses max_output_tokens when output_limit_enforced is false or limit is 0", () => {
    expect(() =>
      validateInferencePolicy(basePolicy({ max_output_tokens: 0 })),
    ).toThrowError(InferencePolicyViolationError);

    const policy = basePolicy({ max_output_tokens: 4096 });
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy,
        capabilities: getDefaultProviderLimitCapabilities("anthropic-messages", {
          output_limit_enforced: false,
        }),
      }),
    ).toThrow(/does not enforce hard output token limits/);
  });

  it("refuses hard max_input_tokens when verified tokenizer is unsupported or exceeded", () => {
    const policy = basePolicy({ max_input_tokens: 1000, tokenizer_id: "cl100k_base" });
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy,
        capabilities: getDefaultProviderLimitCapabilities("anthropic-messages", {
          supported_tokenizers: [],
        }),
      }),
    ).toThrow(/cannot be enforced: tokenizer cl100k_base is not supported/);

    expect(() =>
      evaluateInferencePolicyPreSend({
        policy,
        capabilities: getDefaultProviderLimitCapabilities("anthropic-messages", {
          supported_tokenizers: ["cl100k_base"],
        }),
        measuredInputTokens: 1200,
      }),
    ).toThrow(/Pre-send input tokens \(1200\) exceed policy max_input_tokens \(1000\)/);
  });

  it("enforces hard max_cost only when input, output, reasoning, cache, and price_schedule are bounded", () => {
    const policyWithoutSchedule = basePolicy({
      max_input_tokens: 1000,
      max_output_tokens: 500,
      max_cost: 0.05,
      tokenizer_id: "anthropic-v1",
    });
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy: policyWithoutSchedule,
        capabilities: getDefaultProviderLimitCapabilities("anthropic-messages", {
          supported_tokenizers: ["anthropic-v1"],
        }),
        measuredInputTokens: 500,
      }),
    ).toThrow(/Hard max_cost requires a retained price_schedule/);

    const policyWithSchedule = basePolicy({
      max_input_tokens: 10_000,
      max_output_tokens: 2_000,
      max_cost: 0.01,
      tokenizer_id: "anthropic-v1",
      price_schedule: {
        version: "2026-10",
        currency: "USD",
        rates: {
          input_per_million: 3,
          output_per_million: 15,
        },
      },
    });

    // 10_000 * $3/1M + 2_000 * $15/1M = $0.03 + $0.03 = $0.06 > $0.01 -> refused pre-send
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy: policyWithSchedule,
        capabilities: getDefaultProviderLimitCapabilities("anthropic-messages", {
          supported_tokenizers: ["anthropic-v1"],
          cache_usage_guaranteed_bounded: true,
        }),
        measuredInputTokens: 5_000,
      }),
    ).toThrow(/Worst-case call cost \(0.06\) exceeds policy max_cost \(0.01\)/);

    // Refuses if reasoning is not bounded by output limit
    const generousPolicy = basePolicy({
      max_input_tokens: 1_000,
      max_output_tokens: 500,
      max_cost: 1.0,
      tokenizer_id: "anthropic-v1",
      price_schedule: {
        version: "2026-10",
        currency: "USD",
        rates: {
          input_per_million: 3,
          output_per_million: 15,
        },
      },
    });
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy: generousPolicy,
        capabilities: getDefaultProviderLimitCapabilities("anthropic-messages", {
          supported_tokenizers: ["anthropic-v1"],
          reasoning_bounded_by_output_limit: false,
        }),
        measuredInputTokens: 500,
      }),
    ).toThrow(/requires reasoning tokens to be bounded by the output limit/);
  });

  it("enforces deadline and max_calls before dispatch", () => {
    const expiredPolicy = basePolicy({ deadline: 5_000 });
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy: expiredPolicy,
        nowMs: 5_000,
      }),
    ).toThrow(/deadline has expired before request send/);

    const maxCallsPolicy = basePolicy({ max_calls: 2 });
    expect(() =>
      evaluateInferencePolicyPreSend({
        policy: maxCallsPolicy,
        callIndex: 3,
      }),
    ).toThrow(/call index 3 exceeds policy max_calls \(2\)/);
  });

  it("verifies ExecutionAccessV1 delegation, online effect authority, and endpoint independence", async () => {
    const anthropicPolicy = basePolicy({
      provider_protocol: "anthropic-messages",
      model: "claude-sonnet-5",
      endpoint_ref: "endpoint://remote-anthropic",
    });
    const access = makeValidExecutionAccess(anthropicPolicy, {
      endpointRef: "endpoint://remote-anthropic",
    });

    await authorizeExecutionAccessOnline(anthropicPolicy, access);
    const evaluated = evaluateInferencePolicyPreSend({
      policy: anthropicPolicy,
      access,
    });
    expect(evaluated.policy.provider_protocol).toBe("anthropic-messages");

    const deniedAccess = makeValidExecutionAccess(anthropicPolicy, {
      endpointRef: "endpoint://remote-anthropic",
      effectAuthorized: false,
    });
    await expect(
      authorizeExecutionAccessOnline(anthropicPolicy, deniedAccess),
    ).rejects.toThrow(/denied online effect authority/);

    const mismatchedEndpointAccess = makeValidExecutionAccess(anthropicPolicy, {
      endpointRef: "endpoint://wrong-endpoint",
    });
    expect(() =>
      verifyExecutionAccess(anthropicPolicy, mismatchedEndpointAccess),
    ).toThrow(/does not match policy endpoint_ref/);
  });

  it("produces deterministic policy fingerprints across key ordering", () => {
    const p1 = basePolicy({ max_output_tokens: 300, max_calls: 4 });
    const p2 = basePolicy({ max_calls: 4, max_output_tokens: 300 });
    expect(fingerprintInferencePolicy(p1)).toEqual(fingerprintInferencePolicy(p2));
  });
});
