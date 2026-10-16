import {
  type WorkExecutionDelegation,
  type WorkOwnerConnection,
  executionBindingSchema,
} from "@barry-rocks/sdk/adapters/models";

export type ExecutionBinding = typeof executionBindingSchema["_output"];
export type { WorkExecutionDelegation, WorkOwnerConnection };

export type ProviderProtocolV1 =
  | "anthropic-messages"
  | "openai-completions"
  | "ollama-chat";

export type InferenceFallbackPolicyV1 = "none";

export type InferenceAccountingPolicyV1 =
  | "reservation-only"
  | "reconciled"
  | "strict";

export type OutputLimitWireFieldV1 =
  | "max_tokens"
  | "max_completion_tokens"
  | "options.num_predict";

export type OutputLimitScopeV1 =
  | "visible_and_reasoning"
  | "completion_tokens"
  | "model_dependent_predict";

export type UsageCategoryV1 =
  | "input_tokens"
  | "output_tokens"
  | "total_tokens"
  | "reasoning_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
  | "reported_cost";

export interface PriceScheduleRatesV1 {
  /** Cost per 1,000,000 input tokens in `currency`. */
  readonly input_per_million: number;
  /** Cost per 1,000,000 output tokens in `currency`. */
  readonly output_per_million: number;
  /**
   * Optional separate cost per 1,000,000 reasoning tokens when the provider
   * bills reasoning tokens outside `output_per_million`. When omitted or null,
   * reasoning tokens are assumed to be billed at `output_per_million` as part
   * of `output_tokens`.
   */
  readonly reasoning_per_million?: number | null;
  /** Cost per 1,000,000 cache-read input tokens in `currency`. */
  readonly cache_read_per_million?: number | null;
  /** Cost per 1,000,000 cache-write input tokens in `currency`. */
  readonly cache_write_per_million?: number | null;
}

export interface PriceScheduleV1 {
  readonly version: string;
  readonly currency: string;
  readonly rates: PriceScheduleRatesV1;
}

export interface ExecutionAccessDelegationV1 {
  readonly version: 1;
  readonly namespace?: {
    readonly installation?: string;
    readonly task_queue?: string;
    readonly workflow_id?: string;
  };
  readonly grant?: {
    readonly grant_ref?: string;
    readonly revision?: number;
  };
  readonly start?: {
    readonly version?: number;
    readonly owner?: string;
    readonly work_id?: string;
    readonly workflow_id?: string;
    readonly activity_id?: string;
    readonly attempt_id?: string;
    readonly request_hash?: string;
    readonly plan_digest?: string;
    readonly grant_ref?: string;
    readonly grant_revision?: number;
    readonly source?: { readonly digest?: string } & Partial<ExecutionBinding["source"]>;
    readonly execution_fence?: number;
    readonly deadline?: number;
    readonly launch_authorized?: boolean;
    readonly agent_program?: {
      readonly profile?: { readonly digest?: string };
    } | null;
    readonly resources?: {
      readonly host_reservation?: unknown;
      readonly endpoint?: {
        readonly endpoint?: string;
        readonly reservation?: unknown;
      } | null;
    };
  };
}

export interface ExecutionAccessV1 {
  readonly version: 1;
  readonly delegation: WorkExecutionDelegation | ExecutionAccessDelegationV1;
  readonly connection: Pick<WorkOwnerConnection, "effect"> & Partial<WorkOwnerConnection>;
  readonly signal: AbortSignal;
}

export interface InferencePolicyV1 {
  readonly version: 1;
  readonly binding: ExecutionBinding;
  readonly session_id: string;
  readonly turn_id: string;
  readonly segment_id: string;
  readonly accepted_profile_digest: string;
  readonly endpoint_ref: string;
  readonly provider_protocol: ProviderProtocolV1;
  readonly implementation_version: string;
  readonly model: string;
  /** Absolute deadline as epoch milliseconds or ISO-8601 timestamp string. */
  readonly deadline: number | string;
  /** Maximum model calls permitted in this segment (`null` = no call cap; never 0). */
  readonly max_calls: number | null;
  /** Hard input-token ceiling (`null` = no promised hard limit; never 0). */
  readonly max_input_tokens: number | null;
  /** Hard output-token ceiling (`null` = no promised hard limit; never 0). */
  readonly max_output_tokens: number | null;
  /** Hard cost ceiling (`null` = no promised hard limit; never 0). */
  readonly max_cost: number | null;
  readonly tokenizer_id?: string | null;
  readonly price_schedule?: PriceScheduleV1 | null;
  readonly fallback_policy: InferenceFallbackPolicyV1;
  readonly accounting_policy: InferenceAccountingPolicyV1;
}

export interface ProviderLimitCapabilitiesV1 {
  readonly version: 1;
  readonly provider_protocol: ProviderProtocolV1;
  readonly implementation_version: string;
  readonly output_limit_wire_field: OutputLimitWireFieldV1;
  readonly output_limit_enforced: boolean;
  readonly output_limit_scope: OutputLimitScopeV1;
  readonly reasoning_bounded_by_output_limit: boolean;
  readonly supported_tokenizers: readonly string[];
  readonly usage_categories: readonly UsageCategoryV1[];
  readonly cache_usage_guaranteed_bounded: boolean;
  readonly supports_transport_abort: boolean;
  readonly supports_retry_disable: boolean;
}

export type InferencePolicyRefusalCodeV1 =
  | "invalid_policy"
  | "binding_mismatch"
  | "access_unavailable"
  | "deadline_expired"
  | "fallback_prohibited"
  | "endpoint_mismatch"
  | "max_calls_exceeded"
  | "unsupported_input_token_limit"
  | "input_token_limit_exceeded"
  | "unsupported_output_token_limit"
  | "unsupported_cost_ceiling"
  | "cost_ceiling_exceeded"
  | "retry_disable_unsupported"
  | "transport_abort_unsupported";

export class InferencePolicyViolationError extends Error {
  readonly code: InferencePolicyRefusalCodeV1;
  readonly request_phase = "pre_send" as const;
  readonly admission_certainty = "not_sent" as const;
  readonly retryable = false as const;

  constructor(code: InferencePolicyRefusalCodeV1, message: string) {
    super(message);
    this.name = "InferencePolicyViolationError";
    this.code = code;
  }
}

export const DEFAULT_PI_IMPLEMENTATION_VERSION = "pi-ai@0.99.2";

const VALID_PROTOCOLS = new Set<ProviderProtocolV1>([
  "anthropic-messages",
  "openai-completions",
  "ollama-chat",
]);

const VALID_ACCOUNTING_POLICIES = new Set<InferenceAccountingPolicyV1>([
  "reservation-only",
  "reconciled",
  "strict",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseDeadlineEpochMs(deadline: unknown): number | null {
  if (typeof deadline === "number") {
    if (!Number.isSafeInteger(deadline) || deadline <= 0) return null;
    return deadline;
  }
  if (typeof deadline === "string" && deadline.trim().length > 0) {
    const parsed = Date.parse(deadline);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

export function getDefaultProviderLimitCapabilities(
  protocol: ProviderProtocolV1,
  overrides?: {
    implementation_version?: string;
    output_limit_wire_field?: OutputLimitWireFieldV1;
    output_limit_enforced?: boolean;
    reasoning_bounded_by_output_limit?: boolean;
    supported_tokenizers?: readonly string[];
    cache_usage_guaranteed_bounded?: boolean;
    supports_transport_abort?: boolean;
    supports_retry_disable?: boolean;
  },
): ProviderLimitCapabilitiesV1 {
  const implementationVersion =
    overrides?.implementation_version ?? DEFAULT_PI_IMPLEMENTATION_VERSION;
  switch (protocol) {
    case "anthropic-messages":
      return {
        version: 1,
        provider_protocol: "anthropic-messages",
        implementation_version: implementationVersion,
        output_limit_wire_field: overrides?.output_limit_wire_field ?? "max_tokens",
        output_limit_enforced: overrides?.output_limit_enforced ?? true,
        output_limit_scope: "visible_and_reasoning",
        reasoning_bounded_by_output_limit:
          overrides?.reasoning_bounded_by_output_limit ?? true,
        supported_tokenizers: [...(overrides?.supported_tokenizers ?? [])],
        usage_categories: [
          "input_tokens",
          "output_tokens",
          "total_tokens",
          "reasoning_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
        ],
        cache_usage_guaranteed_bounded:
          overrides?.cache_usage_guaranteed_bounded ?? false,
        supports_transport_abort: overrides?.supports_transport_abort ?? true,
        supports_retry_disable: overrides?.supports_retry_disable ?? true,
      };
    case "openai-completions":
      return {
        version: 1,
        provider_protocol: "openai-completions",
        implementation_version: implementationVersion,
        output_limit_wire_field: overrides?.output_limit_wire_field ?? "max_tokens",
        output_limit_enforced: overrides?.output_limit_enforced ?? true,
        output_limit_scope: "completion_tokens",
        reasoning_bounded_by_output_limit:
          overrides?.reasoning_bounded_by_output_limit ?? true,
        supported_tokenizers: [...(overrides?.supported_tokenizers ?? [])],
        usage_categories: [
          "input_tokens",
          "output_tokens",
          "total_tokens",
          "reasoning_tokens",
          "cache_read_tokens",
          "cache_write_tokens",
        ],
        cache_usage_guaranteed_bounded:
          overrides?.cache_usage_guaranteed_bounded ?? false,
        supports_transport_abort: overrides?.supports_transport_abort ?? true,
        supports_retry_disable: overrides?.supports_retry_disable ?? true,
      };
    case "ollama-chat":
      return {
        version: 1,
        provider_protocol: "ollama-chat",
        implementation_version: implementationVersion,
        output_limit_wire_field:
          overrides?.output_limit_wire_field ?? "options.num_predict",
        output_limit_enforced: overrides?.output_limit_enforced ?? true,
        output_limit_scope: "model_dependent_predict",
        reasoning_bounded_by_output_limit:
          overrides?.reasoning_bounded_by_output_limit ?? true,
        supported_tokenizers: [...(overrides?.supported_tokenizers ?? [])],
        usage_categories: ["input_tokens", "output_tokens", "total_tokens"],
        cache_usage_guaranteed_bounded:
          overrides?.cache_usage_guaranteed_bounded ?? false,
        supports_transport_abort: overrides?.supports_transport_abort ?? true,
        supports_retry_disable: overrides?.supports_retry_disable ?? true,
      };
  }
}

function validatePriceSchedule(raw: unknown): PriceScheduleV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "price_schedule must be an object when provided",
    );
  }
  const schedule = raw as Record<string, unknown>;
  if (!isNonEmptyString(schedule.version)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "price_schedule.version must be a non-empty string",
    );
  }
  if (!isNonEmptyString(schedule.currency)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "price_schedule.currency must be a non-empty string",
    );
  }
  if (
    !schedule.rates ||
    typeof schedule.rates !== "object" ||
    Array.isArray(schedule.rates)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "price_schedule.rates must be an object",
    );
  }
  const rates = schedule.rates as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(rates.input_per_million)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "price_schedule.rates.input_per_million must be a finite number >= 0",
    );
  }
  if (!isNonNegativeFiniteNumber(rates.output_per_million)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "price_schedule.rates.output_per_million must be a finite number >= 0",
    );
  }
  const optionalRateKeys = [
    "reasoning_per_million",
    "cache_read_per_million",
    "cache_write_per_million",
  ] as const;
  for (const key of optionalRateKeys) {
    const val = rates[key];
    if (val !== undefined && val !== null && !isNonNegativeFiniteNumber(val)) {
      throw new InferencePolicyViolationError(
        "invalid_policy",
        `price_schedule.rates.${key} must be null or a finite number >= 0`,
      );
    }
  }
  return {
    version: schedule.version.trim(),
    currency: schedule.currency.trim(),
    rates: {
      input_per_million: rates.input_per_million,
      output_per_million: rates.output_per_million,
      reasoning_per_million:
        (rates.reasoning_per_million as number | null | undefined) ?? null,
      cache_read_per_million:
        (rates.cache_read_per_million as number | null | undefined) ?? null,
      cache_write_per_million:
        (rates.cache_write_per_million as number | null | undefined) ?? null,
    },
  };
}

export function validateInferencePolicy(raw: unknown): InferencePolicyV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy must be an object",
    );
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.version must be 1",
    );
  }

  const parsedBinding = executionBindingSchema.safeParse(candidate.binding);
  if (!parsedBinding.success) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.binding failed ExecutionBinding validation",
    );
  }
  const binding = parsedBinding.data;

  if (!isNonEmptyString(candidate.session_id)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.session_id must be a non-empty string",
    );
  }
  if (!isNonEmptyString(candidate.turn_id)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.turn_id must be a non-empty string",
    );
  }
  if (!isNonEmptyString(candidate.segment_id)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.segment_id must be a non-empty string",
    );
  }

  if (!isNonEmptyString(candidate.accepted_profile_digest)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.accepted_profile_digest must be a non-empty string",
    );
  }
  if (!isNonEmptyString(candidate.endpoint_ref)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.endpoint_ref must be a non-empty string",
    );
  }
  if (
    typeof candidate.provider_protocol !== "string" ||
    !VALID_PROTOCOLS.has(candidate.provider_protocol as ProviderProtocolV1)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.provider_protocol must be anthropic-messages, openai-completions, or ollama-chat",
    );
  }
  if (!isNonEmptyString(candidate.implementation_version)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.implementation_version must be a non-empty string",
    );
  }
  if (!isNonEmptyString(candidate.model)) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.model must be a non-empty string",
    );
  }

  const deadlineMs = parseDeadlineEpochMs(candidate.deadline);
  if (deadlineMs === null) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.deadline must be a positive epoch millisecond integer or valid ISO-8601 timestamp",
    );
  }
  if (deadlineMs > binding.deadline) {
    throw new InferencePolicyViolationError(
      "binding_mismatch",
      `inferencePolicy.deadline (${deadlineMs}) cannot exceed binding.deadline (${binding.deadline})`,
    );
  }

  if (
    candidate.max_calls !== null &&
    !isPositiveSafeInteger(candidate.max_calls)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.max_calls must be a positive integer (>= 1) or null (never 0)",
    );
  }
  if (
    candidate.max_input_tokens !== null &&
    !isPositiveSafeInteger(candidate.max_input_tokens)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.max_input_tokens must be a positive integer (>= 1) or null (never 0)",
    );
  }
  if (
    candidate.max_output_tokens !== null &&
    !isPositiveSafeInteger(candidate.max_output_tokens)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.max_output_tokens must be a positive integer (>= 1) or null (never 0)",
    );
  }
  if (
    candidate.max_cost !== null &&
    !isPositiveFiniteNumber(candidate.max_cost)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.max_cost must be a positive finite number (> 0) or null (never 0)",
    );
  }

  if (
    candidate.tokenizer_id !== undefined &&
    candidate.tokenizer_id !== null &&
    !isNonEmptyString(candidate.tokenizer_id)
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.tokenizer_id must be a non-empty string or null when provided",
    );
  }

  const priceSchedule =
    candidate.price_schedule !== undefined && candidate.price_schedule !== null
      ? validatePriceSchedule(candidate.price_schedule)
      : null;

  if (candidate.fallback_policy !== "none") {
    throw new InferencePolicyViolationError(
      "fallback_prohibited",
      "inferencePolicy.fallback_policy must be 'none'; automatic model or endpoint fallback is prohibited",
    );
  }

  if (
    typeof candidate.accounting_policy !== "string" ||
    !VALID_ACCOUNTING_POLICIES.has(
      candidate.accounting_policy as InferenceAccountingPolicyV1,
    )
  ) {
    throw new InferencePolicyViolationError(
      "invalid_policy",
      "inferencePolicy.accounting_policy must be reservation-only, reconciled, or strict",
    );
  }

  return {
    version: 1,
    binding,
    session_id: candidate.session_id.trim(),
    turn_id: candidate.turn_id.trim(),
    segment_id: candidate.segment_id.trim(),
    accepted_profile_digest: candidate.accepted_profile_digest.trim(),
    endpoint_ref: candidate.endpoint_ref.trim(),
    provider_protocol: candidate.provider_protocol as ProviderProtocolV1,
    implementation_version: candidate.implementation_version.trim(),
    model: candidate.model.trim(),
    deadline: candidate.deadline as number | string,
    max_calls: candidate.max_calls as number | null,
    max_input_tokens: candidate.max_input_tokens as number | null,
    max_output_tokens: candidate.max_output_tokens as number | null,
    max_cost: candidate.max_cost as number | null,
    tokenizer_id:
      typeof candidate.tokenizer_id === "string"
        ? candidate.tokenizer_id.trim()
        : null,
    price_schedule: priceSchedule,
    fallback_policy: "none",
    accounting_policy: candidate.accounting_policy as InferenceAccountingPolicyV1,
  };
}

export function createDefaultExecutionBinding(
  overrides: Partial<ExecutionBinding> = {},
): ExecutionBinding {
  return {
    version: 2,
    owner: "owner-local",
    work_id: "work-00000000-0000-0000-0000-000000000001",
    workflow_id: "wf-00000000-0000-0000-0000-000000000001",
    activity_id: "act-00000000-0000-0000-0000-000000000001",
    attempt_id: "att-00000000-0000-0000-0000-000000000001",
    request_hash: "a".repeat(64),
    plan_digest: "b".repeat(64),
    grant_ref: "grant-1",
    grant_revision: 1,
    source: {
      digest: "c".repeat(64),
      bytes: 1024,
      media_type: "application/json",
      owner_identity: "owner-local",
      purpose: "source",
    },
    execution_fence: 1,
    deadline: 4_102_444_800_000,
    ...overrides,
  };
}

export function verifyExecutionAccess(
  policy: InferencePolicyV1,
  access: ExecutionAccessV1,
): void {
  if (!access || access.version !== 1) {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      "ExecutionAccessV1 version 1 is required for online inference",
    );
  }
  const { delegation, connection, signal } = access;
  if (!delegation || !connection || !signal) {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      "ExecutionAccessV1 is missing delegation, connection, or signal",
    );
  }
  if (signal.aborted) {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      "ExecutionAccessV1 signal is already aborted",
    );
  }
  if (typeof connection.effect !== "function") {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      "WorkOwnerConnection is missing online effect authorization method",
    );
  }
  const start = delegation.start;
  const pb = policy.binding;
  if (
    delegation.version !== 1 ||
    !start ||
    start.launch_authorized !== true ||
    start.owner !== pb.owner ||
    start.work_id !== pb.work_id ||
    start.workflow_id !== pb.workflow_id ||
    start.activity_id !== pb.activity_id ||
    start.attempt_id !== pb.attempt_id ||
    start.request_hash !== pb.request_hash ||
    start.plan_digest !== pb.plan_digest ||
    start.grant_ref !== pb.grant_ref ||
    start.grant_revision !== pb.grant_revision ||
    start.execution_fence !== pb.execution_fence ||
    start.deadline !== pb.deadline ||
    start.source?.digest !== pb.source.digest ||
    delegation.grant?.grant_ref !== pb.grant_ref ||
    delegation.grant?.revision !== pb.grant_revision ||
    delegation.namespace?.installation !== pb.owner
  ) {
    throw new InferencePolicyViolationError(
      "binding_mismatch",
      "ExecutionAccessV1 delegation binding does not match InferencePolicyV1 binding",
    );
  }
  if (
    start.agent_program?.profile?.digest !== undefined &&
    start.agent_program.profile.digest !== policy.accepted_profile_digest
  ) {
    throw new InferencePolicyViolationError(
      "binding_mismatch",
      "ExecutionAccessV1 agent_program.profile.digest does not match accepted_profile_digest",
    );
  }
  if (!start.resources?.host_reservation) {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      "ExecutionAccessV1 delegation requires an active held host_reservation",
    );
  }
  if (start.resources.endpoint) {
    if (!start.resources.endpoint.reservation) {
      throw new InferencePolicyViolationError(
        "access_unavailable",
        "ExecutionAccessV1 delegation endpoint resource requires a held reservation",
      );
    }
    if (start.resources.endpoint.endpoint !== policy.endpoint_ref) {
      throw new InferencePolicyViolationError(
        "endpoint_mismatch",
        `ExecutionAccessV1 endpoint "${start.resources.endpoint.endpoint}" does not match policy endpoint_ref "${policy.endpoint_ref}"`,
      );
    }
  }
}

export async function authorizeExecutionAccessOnline(
  policy: InferencePolicyV1,
  access: ExecutionAccessV1,
): Promise<void> {
  verifyExecutionAccess(policy, access);
  let authorized = false;
  try {
    authorized = await access.connection.effect(policy.binding.attempt_id);
  } catch (err) {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      `WorkOwnerConnection online effect check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!authorized) {
    throw new InferencePolicyViolationError(
      "access_unavailable",
      `WorkOwnerConnection denied online effect authority for attempt "${policy.binding.attempt_id}"`,
    );
  }
}

export interface EvaluateInferencePolicyInput {
  readonly policy: InferencePolicyV1;
  readonly capabilities?: ProviderLimitCapabilitiesV1;
  readonly endpoint?: {
    readonly protocol?: string;
    readonly model?: string;
  };
  readonly access?: ExecutionAccessV1;
  /** 1-based index of the call about to be issued. */
  readonly callIndex?: number;
  readonly nowMs?: number;
  /**
   * Optional exact input token count produced by a verified tokenizer matching
   * `policy.tokenizer_id` prior to sending the request.
   */
  readonly measuredInputTokens?: number | null;
  /**
   * When true and `accounting_policy === "reservation-only"`, permits a
   * `max_cost` ceiling to be evaluated as an explicitly authorized estimate
   * when input tokens or cache bounds are not strictly enforceable.
   * Defaults to false (fail-closed).
   */
  readonly allowAuthorizedCostEstimate?: boolean;
}

export interface EvaluatedInferencePolicyV1 {
  readonly policy: InferencePolicyV1;
  readonly capabilities: ProviderLimitCapabilitiesV1;
  readonly deadlineEpochMs: number;
  readonly remainingTimeoutMs: number;
  readonly wireMaxOutputTokens: number | null;
  readonly wireField: OutputLimitWireFieldV1;
  readonly estimatedWorstCaseCost: number | null;
  readonly costEnforcementMode:
    | "none"
    | "strict_upper_bound"
    | "authorized_estimate";
}

export function evaluateInferencePolicyPreSend(
  input: EvaluateInferencePolicyInput,
): EvaluatedInferencePolicyV1 {
  const policy = validateInferencePolicy(input.policy);
  const capabilities =
    input.capabilities ??
    getDefaultProviderLimitCapabilities(policy.provider_protocol, {
      implementation_version: policy.implementation_version,
    });

  if (capabilities.provider_protocol !== policy.provider_protocol) {
    throw new InferencePolicyViolationError(
      "endpoint_mismatch",
      `ProviderLimitCapabilitiesV1 protocol ${capabilities.provider_protocol} does not match policy protocol ${policy.provider_protocol}`,
    );
  }

  if (input.endpoint?.protocol && input.endpoint.protocol !== policy.provider_protocol) {
    throw new InferencePolicyViolationError(
      "endpoint_mismatch",
      `Configured endpoint protocol ${input.endpoint.protocol} does not match accepted policy protocol ${policy.provider_protocol}`,
    );
  }

  if (input.endpoint?.model && input.endpoint.model !== policy.model) {
    throw new InferencePolicyViolationError(
      "endpoint_mismatch",
      `Configured endpoint model ${input.endpoint.model} does not match accepted policy model ${policy.model}`,
    );
  }

  if (input.access) {
    verifyExecutionAccess(policy, input.access);
  }

  if (!capabilities.supports_transport_abort) {
    throw new InferencePolicyViolationError(
      "transport_abort_unsupported",
      `Provider protocol ${policy.provider_protocol} does not support transport-level abort`,
    );
  }

  if (!capabilities.supports_retry_disable) {
    throw new InferencePolicyViolationError(
      "retry_disable_unsupported",
      `Provider protocol ${policy.provider_protocol} does not support disabling automatic client retries`,
    );
  }

  const nowMs = input.nowMs ?? Date.now();
  const deadlineEpochMs = parseDeadlineEpochMs(policy.deadline)!;
  const rawRemainingTimeoutMs = deadlineEpochMs - nowMs;
  if (rawRemainingTimeoutMs <= 0) {
    throw new InferencePolicyViolationError(
      "deadline_expired",
      "Inference policy deadline has expired before request send",
    );
  }
  const remainingTimeoutMs = Math.min(2_147_483_647, rawRemainingTimeoutMs);

  const callIndex = input.callIndex ?? 1;
  if (policy.max_calls !== null && callIndex > policy.max_calls) {
    throw new InferencePolicyViolationError(
      "max_calls_exceeded",
      `Inference call index ${callIndex} exceeds policy max_calls (${policy.max_calls})`,
    );
  }

  let wireMaxOutputTokens: number | null = null;
  if (policy.max_output_tokens !== null) {
    if (!capabilities.output_limit_enforced) {
      throw new InferencePolicyViolationError(
        "unsupported_output_token_limit",
        `Provider protocol ${policy.provider_protocol} does not enforce hard output token limits`,
      );
    }
    wireMaxOutputTokens = policy.max_output_tokens;
  }

  let boundedInputTokens: number | null = null;
  if (policy.max_input_tokens !== null) {
    const tokenizerId = policy.tokenizer_id;
    const tokenizerSupported =
      isNonEmptyString(tokenizerId) &&
      capabilities.supported_tokenizers.includes(tokenizerId);
    if (!tokenizerSupported) {
      throw new InferencePolicyViolationError(
        "unsupported_input_token_limit",
        `Hard max_input_tokens (${policy.max_input_tokens}) cannot be enforced: tokenizer ${tokenizerId ?? "<none>"} is not supported by ${policy.provider_protocol} (contextWindow and byte caps do not enforce input token limits)`,
      );
    }
    if (
      input.measuredInputTokens === undefined ||
      input.measuredInputTokens === null ||
      !Number.isSafeInteger(input.measuredInputTokens) ||
      input.measuredInputTokens < 0
    ) {
      throw new InferencePolicyViolationError(
        "unsupported_input_token_limit",
        `Hard max_input_tokens (${policy.max_input_tokens}) requires a pre-send token count from tokenizer ${tokenizerId}`,
      );
    }
    if (input.measuredInputTokens > policy.max_input_tokens) {
      throw new InferencePolicyViolationError(
        "input_token_limit_exceeded",
        `Pre-send input tokens (${input.measuredInputTokens}) exceed policy max_input_tokens (${policy.max_input_tokens})`,
      );
    }
    boundedInputTokens = policy.max_input_tokens;
  }

  let estimatedWorstCaseCost: number | null = null;
  let costEnforcementMode: "none" | "strict_upper_bound" | "authorized_estimate" =
    "none";

  if (policy.max_cost !== null) {
    const schedule = policy.price_schedule;
    if (!schedule) {
      throw new InferencePolicyViolationError(
        "unsupported_cost_ceiling",
        "Hard max_cost requires a retained price_schedule on InferencePolicyV1",
      );
    }
    if (policy.max_output_tokens === null || !capabilities.output_limit_enforced) {
      throw new InferencePolicyViolationError(
        "unsupported_cost_ceiling",
        "Hard max_cost requires an enforced max_output_tokens bound",
      );
    }
    if (!capabilities.reasoning_bounded_by_output_limit) {
      throw new InferencePolicyViolationError(
        "unsupported_cost_ceiling",
        "Hard max_cost requires reasoning tokens to be bounded by the output limit",
      );
    }

    const cacheReadRate = schedule.rates.cache_read_per_million ?? 0;
    const cacheWriteRate = schedule.rates.cache_write_per_million ?? 0;
    const maxInputRate = Math.max(
      schedule.rates.input_per_million,
      cacheReadRate,
      cacheWriteRate,
    );
    const maxOutputRate = Math.max(
      schedule.rates.output_per_million,
      schedule.rates.reasoning_per_million ?? 0,
    );

    const hasBoundedInputAndCache =
      boundedInputTokens !== null &&
      (capabilities.cache_usage_guaranteed_bounded ||
        (cacheReadRate <= schedule.rates.input_per_million &&
          cacheWriteRate <= schedule.rates.input_per_million));

    if (!hasBoundedInputAndCache) {
      if (
        policy.accounting_policy === "reservation-only" &&
        input.allowAuthorizedCostEstimate === true
      ) {
        costEnforcementMode = "authorized_estimate";
        const assumedInputTokens = policy.max_input_tokens ?? 0;
        estimatedWorstCaseCost =
          (assumedInputTokens * maxInputRate +
            policy.max_output_tokens * maxOutputRate) /
          1_000_000;
        if (estimatedWorstCaseCost > policy.max_cost) {
          throw new InferencePolicyViolationError(
            "cost_ceiling_exceeded",
            `Authorized cost estimate (${estimatedWorstCaseCost}) exceeds policy max_cost (${policy.max_cost})`,
          );
        }
      } else {
        throw new InferencePolicyViolationError(
          "unsupported_cost_ceiling",
          "Hard max_cost cannot be guaranteed without bounded input tokens, bounded reasoning/output tokens, bounded cache rates, and a retained price_schedule",
        );
      }
    } else {
      costEnforcementMode = "strict_upper_bound";
      const perCallUpperBound =
        (boundedInputTokens! * maxInputRate +
          policy.max_output_tokens * maxOutputRate) /
        1_000_000;
      const callMultiplier = policy.max_calls ?? 1;
      estimatedWorstCaseCost = perCallUpperBound * callMultiplier;
      if (perCallUpperBound > policy.max_cost) {
        throw new InferencePolicyViolationError(
          "cost_ceiling_exceeded",
          `Worst-case call cost (${perCallUpperBound}) exceeds policy max_cost (${policy.max_cost})`,
        );
      }
    }
  }

  return {
    policy,
    capabilities,
    deadlineEpochMs,
    remainingTimeoutMs,
    wireMaxOutputTokens,
    wireField: capabilities.output_limit_wire_field,
    estimatedWorstCaseCost,
    costEnforcementMode,
  };
}

export function fingerprintInferencePolicy(
  policy: InferencePolicyV1,
): Record<string, unknown> {
  const validated = validateInferencePolicy(policy);
  return {
    version: validated.version,
    owner: validated.binding.owner,
    work_id: validated.binding.work_id,
    workflow_id: validated.binding.workflow_id,
    activity_id: validated.binding.activity_id,
    attempt_id: validated.binding.attempt_id,
    request_hash: validated.binding.request_hash,
    plan_digest: validated.binding.plan_digest,
    grant_ref: validated.binding.grant_ref,
    grant_revision: validated.binding.grant_revision,
    source_digest: validated.binding.source.digest,
    execution_fence: validated.binding.execution_fence,
    binding_deadline: validated.binding.deadline,
    session_id: validated.session_id,
    turn_id: validated.turn_id,
    segment_id: validated.segment_id,
    accepted_profile_digest: validated.accepted_profile_digest,
    endpoint_ref: validated.endpoint_ref,
    provider_protocol: validated.provider_protocol,
    implementation_version: validated.implementation_version,
    model: validated.model,
    deadline: parseDeadlineEpochMs(validated.deadline),
    max_calls: validated.max_calls,
    max_input_tokens: validated.max_input_tokens,
    max_output_tokens: validated.max_output_tokens,
    max_cost: validated.max_cost,
    tokenizer_id: validated.tokenizer_id ?? null,
    price_schedule: validated.price_schedule
      ? {
          version: validated.price_schedule.version,
          currency: validated.price_schedule.currency,
          rates: {
            input_per_million:
              validated.price_schedule.rates.input_per_million,
            output_per_million:
              validated.price_schedule.rates.output_per_million,
            reasoning_per_million:
              validated.price_schedule.rates.reasoning_per_million ?? null,
            cache_read_per_million:
              validated.price_schedule.rates.cache_read_per_million ?? null,
            cache_write_per_million:
              validated.price_schedule.rates.cache_write_per_million ?? null,
          },
        }
      : null,
    fallback_policy: validated.fallback_policy,
    accounting_policy: validated.accounting_policy,
  };
}
