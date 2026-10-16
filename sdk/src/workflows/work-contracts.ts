import { createHash } from "node:crypto";
import { z } from "zod";
import { approvedBoundsSchema, boundFingerprint } from "../bounds/workflow-bounds.js";
import { encode, limits, type Json } from "./types.js";
import { workAgentProgramSchema } from "./work-agent-program.js";
import { workArtifactSchema } from "./work-artifact-contract.js";
export { workArtifactSchema } from "./work-artifact-contract.js";

const ref = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative();
const revision = z.number().int().positive();
const duration = z.number().int().positive().max(31_536_000_000);
const boundedJson = z.json().superRefine((value, context) => {
  try {
    encode(value, limits.payload);
  } catch {
    context.addIssue({
      code: "custom",
      message: "work payload exceeds finite JSON/depth/byte limits",
    });
  }
});

/** Public submission contains references, never a caller-authored grant or effective plan. */
export const workDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("action"), reference: ref, catalog_namespace: ref }),
  z.strictObject({ kind: z.literal("job"), reference: ref }),
  z.strictObject({ kind: z.literal("workflow"), reference: ref, version: ref }),
]);
export const workOriginSchema = z.strictObject({
  entry_point: ref,
  trigger: z.enum(["invocation", "schedule", "event", "internal", "manual"]),
  occurrence_id: ref.optional(),
  producer_ref: ref.optional(),
  parent_work_id: ref.optional(),
  caller_session_id: ref.optional(),
});
export const workSubmissionSchema = z.strictObject({
  version: z.literal(2),
  request_id: z.uuid(),
  idempotency_key: ref,
  authority_ref: ref,
  recovery_epoch: z.uuid().optional(),
  definition: workDefinitionSchema,
  inputs: boundedJson,
  origin: workOriginSchema,
  overrides: z
    .strictObject({
      harness: ref.optional(),
      model: ref.optional(),
      cwd: z.string().max(4096).optional(),
      timeout_ms: duration.optional(),
      dispatch_timeout_ms: duration.max(3_600_000).optional(),
      traits: z.array(ref).max(100).optional(),
    })
    .optional(),
});
export type WorkSubmission = z.infer<typeof workSubmissionSchema>;
export const workNamespaceSchema = z.strictObject({
  installation: ref,
  principal_kind: z.enum(["operator", "identity", "service"]),
  principal_id: ref,
  identity_id: ref.nullable(),
  caller_session_id: ref.nullable(),
});
export type WorkNamespace = z.infer<typeof workNamespaceSchema>;
export const workEffectPolicySchema = z.discriminatedUnion("class", [
  z.strictObject({
    class: z.literal("pure"),
    max_attempts: z.number().int().min(1).max(100),
    retry_budget_ms: duration,
  }),
  z.strictObject({
    class: z.literal("repeatable"),
    max_attempts: z.number().int().min(1).max(100),
    retry_budget_ms: duration,
  }),
  z.strictObject({
    class: z.literal("deduplicated"),
    destination_contract: ref,
    receipt_retention_ms: duration,
    max_attempts: z.number().int().min(1).max(100),
    retry_budget_ms: duration,
  }),
  z.strictObject({
    class: z.literal("checkpointable"),
    checkpoint_contract: ref,
    max_attempts: z.number().int().min(1).max(100),
    retry_budget_ms: duration,
  }),
  z.strictObject({ class: z.literal("non-repeatable"), max_attempts: z.literal(1) }),
]);
export const workResourcesSchema = z.strictObject({
  executor: z.enum(["process", "agent", "model", "tool"]),
  lane: z.enum(["unscheduled", "scheduled", "internal"]),
  logical_reservation: ref,
  host_reservation: ref.nullable(),
  endpoint: z
    .strictObject({
      broker: ref,
      endpoint: ref,
      reservation: ref.nullable(),
      model: ref,
      max_input_tokens: z.number().int().positive(),
      max_output_tokens: z.number().int().positive(),
      max_cost: z.number().finite().nonnegative(),
    })
    .nullable(),
});
export const workGrantSchema = z.strictObject({
  version: z.literal(2),
  grant_ref: ref,
  revision,
  namespace: workNamespaceSchema,
  authorizer: ref,
  created_by: ref,
  approved_at: timestamp,
  original_caller_ceiling: approvedBoundsSchema,
  effective_scope: approvedBoundsSchema,
  definition_bounds_digest: digest,
  policy_revision: ref,
});
export const executorFeaturesSchema = z
  .strictObject({
    version: z.literal(2),
    observed_at: timestamp,
    expires_at: timestamp,
    installation: ref,
    boot_identity: ref,
    executors: z.array(z.enum(["process", "structured-agent", "model", "scoped-tool"])).max(4),
    features: z
      .array(
        z.enum([
          "journal-inspect",
          "cancel-tombstone",
          "stop-ack",
          "immutable-source",
          "scoped-effects",
          "bounded-retries",
          "endpoint-arbiter",
          "declared-validation",
          "node-job",
          "stage-logs",
          "process-program",
          "process-program-envelope",
          "process-program-bundle",
          "action-command-stages",
        ]),
      )
      .max(14),
    runtimes: z.record(ref, digest).refine((value) => Object.keys(value).length <= 100),
    workspaces: z.array(ref).max(100),
    containment: z.enum(["portable", "resource-contained"]),
    requires_validation_declaration: z.boolean().optional(),
  })
  .refine(
    (value) => value.expires_at > value.observed_at,
    "capabilities must expire after observation",
  );
export const humanDecisionSchema = z
  .strictObject({
    version: z.literal(2),
    decision_id: ref,
    work_id: ref,
    revision,
    prompt: z.string().min(1).max(4000),
    options: z
      .array(z.strictObject({ id: ref, label: z.string().min(1).max(200) }))
      .min(1)
      .max(20),
    allowed_responders: z.array(ref).min(1).max(100),
    deadline: timestamp,
  })
  .refine(
    (value) => new Set(value.options.map((option) => option.id)).size === value.options.length,
    "decision option IDs must be unique",
  );
export const workReasonSchema = z.strictObject({
  code: ref,
  stage: z.enum([
    "admission",
    "placement",
    "preflight",
    "execution",
    "validation",
    "postcondition",
    "publication",
    "recovery",
  ]),
  since: timestamp,
  retryable: z.boolean(),
  detail: z.string().max(2000),
  attempt_id: ref.optional(),
});
export const executionBindingSchema = z.strictObject({
  version: z.literal(2),
  owner: ref,
  work_id: ref,
  workflow_id: ref,
  activity_id: ref,
  attempt_id: ref,
  request_hash: digest,
  plan_digest: digest,
  grant_ref: ref,
  grant_revision: revision,
  source: workArtifactSchema,
  execution_fence: revision,
  deadline: timestamp,
});
export const workValidationSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("json-schema"), schema: z.record(z.string(), boundedJson)
    .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65_536, "validation schema exceeds 64 KiB") }),
]);
export const workNodeJobSchema = z.strictObject({
  activity_type: ref,
  source_digest: digest,
  scope: approvedBoundsSchema,
  output: z.enum(["json", "none"]),
});
const programRelativePath = z.string().min(1).max(4096).refine(value => !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
const processDirectorySchema = z.strictObject({ path: z.string().max(4096).refine(value => value.startsWith("/") && !value.includes("\0")), device: z.number().int().nonnegative(), inode: z.number().int().nonnegative() });
export const workProcessCommandSchema = z.strictObject({
  command: z.string().max(65536).refine(value => !value.includes("\0")).optional(),
  files_exist: z.array(z.string().min(1).max(4096).refine(value => !value.includes("\0"))).max(1000).default([]),
  runtime: workArtifactSchema.refine(value => value.purpose === "source"),
  runtime_path: z.string().max(4096).refine(value => value.startsWith("/") && !value.includes("\0")).optional(),
  cwd: processDirectorySchema, timeout_ms: z.number().int().min(1).max(600000), hint: z.string().max(2000).optional(),
});
export const workCommandReportSchema = z.strictObject({ passed: z.boolean(), unknown: z.boolean(), detail: z.string().max(2000), failures: z.array(z.string().max(2000)).max(100) });
export const workActionChecksSchema = z.strictObject({ preflight: workCommandReportSchema.optional(), postcondition: workCommandReportSchema.optional() });
export type WorkProcessCommand = z.infer<typeof workProcessCommandSchema>;
export type WorkCommandReport = z.infer<typeof workCommandReportSchema>;
export const workProcessProgramSchema = z.strictObject({
  activity_type: ref, source_digest: digest, installation: ref, scope: approvedBoundsSchema,
  /** Original application input for action-script@2; v1 retains direct input. */
  input_digest: digest.optional(),
  bundle: z.strictObject({ source: workArtifactSchema.refine(value => value.purpose === "source"), entry: programRelativePath }).optional(),
  source_environment: z.array(z.enum(["BARRY_ACTION_DIR", "ACTION_DIR"])).max(2).refine(value => new Set(value).size === value.length).optional(),
  runtime: workArtifactSchema.refine(value => value.purpose === "source", "runtime must be retained source"),
  runtime_path: z.string().max(4096).refine(value => value.startsWith("/") && !value.includes("\0")).optional(),
  credential_owner: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("none") }), z.strictObject({ kind: z.literal("identity"), identity: ref }), z.strictObject({ kind: z.literal("installation"), installation: ref })]).default({ kind: "none" }),
  argv: z.array(z.union([z.string().max(4096).refine(value => !value.includes("\0")), z.strictObject({ source: z.literal(true) }), z.strictObject({ file: programRelativePath, format: z.enum(["path", "file-url"]).default("path") })])).max(1000),
  source_name: z.string().min(1).max(200).refine(value => ![".", ".."].includes(value) && !value.includes("/") && !value.includes("\0")),
  cwd: processDirectorySchema,
  commands: z.strictObject({ preflight: workProcessCommandSchema.optional(), postcondition: workProcessCommandSchema.optional() }).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65536).refine(value => !value.includes("\0"))).refine(value => JSON.stringify(value).length <= 65536),
  secret_names: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(100).refine(value => new Set(value).size === value.length),
  output: z.enum(["json", "text-tail", "none"]),
});
export type WorkProcessProgram = z.infer<typeof workProcessProgramSchema>;
export const executorStartSchema = executionBindingSchema.extend({
  /** Absent only in retained pre-activation-protocol requests. Reservations cannot launch. */
  launch_authorized: z.boolean().default(true),
  inputs: boundedJson,
  effect_policy: workEffectPolicySchema,
  resources: workResourcesSchema,
  executor_generation: ref,
  validation: workValidationSchema.optional(),
  node_job: workNodeJobSchema.optional(),
  process_program: workProcessProgramSchema.optional(),
  agent_program: workAgentProgramSchema.optional(),
  capture_logs: z.literal(true).optional(),
  compatibility_action_id: ref.nullable().optional(),
  activity_type: ref.optional(),
  output_identity: ref.nullable().optional(),
  budget_deadline: timestamp.optional(),
  retry_from: z.strictObject({
    attempt_id: ref,
    receipt_digest: digest,
    attempt_number: revision,
    retry_deadline: timestamp,
  }).optional(),
}).superRefine((start, context) => {
  if ([start.agent_program, start.process_program, start.node_job].filter(Boolean).length > 1)
    context.addIssue({ code: "custom", message: "Execution program declarations are mutually exclusive" });
  if (start.agent_program && (start.resources.executor !== "agent" || start.agent_program.installation !== start.owner
    || boundFingerprint(start.agent_program.profile) !== boundFingerprint(start.source) || start.agent_program.activity_type !== start.activity_type))
    context.addIssue({ code: "custom", message: "Agent execution differs from its declared activity, source, installation or executor" });
});
export const physicalStateSchema = z.enum([
  "not-started",
  "running",
  "stopping",
  "ceased",
  "unknown",
]);
export const effectCertaintySchema = z.enum(["not-started", "known", "uncertain"]);
export const executorObservationSchema = executionBindingSchema.extend({
  revision,
  observed_at: timestamp,
  stage: z.enum([
    "intent",
    "launching",
    "preflight",
    "execution",
    "validation",
    "postcondition",
    "publication",
    "terminal",
  ]),
  physical_state: physicalStateSchema,
  effect_certainty: effectCertaintySchema,
  cancel_requested: z.boolean(),
  reason: workReasonSchema.nullable(),
  receipt_ref: ref.nullable(),
  handle: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("process"),
        installation: ref,
        boot_identity: ref,
        pid: z.number().int().positive(),
        start_identity: ref,
      }),
      z.strictObject({
        kind: z.literal("session"),
        installation: ref,
        session_id: ref,
        turn_id: ref,
      }),
      z.strictObject({ kind: z.literal("provider"), endpoint: ref, request_id: ref }),
    ])
    .nullable(),
});
/** Bounded text capture. Counts describe received bytes, before UTF-8 replacement decoding. */
export const workLogSchema = z.strictObject({
  version: z.literal(1),
  stdout: z.string().max(16384), stderr: z.string().max(4096),
  stdout_bytes: z.number().int().nonnegative(), stderr_bytes: z.number().int().nonnegative(),
  stdout_truncated: z.boolean(), stderr_truncated: z.boolean(),
});
export type WorkLog = z.infer<typeof workLogSchema>;
export const stageReceiptSchema = z.strictObject({
  stage: z.enum(["preflight", "execution", "validation", "postcondition", "publication"]),
  effect_key: ref,
  attempt_id: ref,
  state: z.enum(["skipped", "passed", "failed", "unknown"]),
  started_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  result: workArtifactSchema.nullable(),
  logs: workArtifactSchema.refine(value => value.purpose === "log" && value.media_type === "application/json" && value.bytes <= 131072, "invalid stage log artifact").optional(),
});
export const workReceiptSchema = executionBindingSchema
  .extend({
    receipt_ref: ref,
    receipt_digest: digest,
    revision,
    committed_at: timestamp,
    physical_state: physicalStateSchema,
    effect_certainty: effectCertaintySchema,
    outcome: z.enum(["complete", "failed", "cancelled", "timed-out", "uncertain"]),
    stages: z.array(stageReceiptSchema).max(5),
    action_checks: workActionChecksSchema.optional(),
    output: workArtifactSchema.nullable(),
    summary: z.string().max(4000),
    validation: z.enum(["skipped", "passed", "failed", "unknown"]),
    validation_failures: z.array(z.string().max(2000)).max(100).nullable(),
    failure: z.strictObject({ code: ref, retryable: z.boolean() }).optional(),
  })
  .superRefine((receipt, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    if (
      ["complete", "cancelled", "timed-out"].includes(receipt.outcome) &&
      !["ceased", "not-started"].includes(receipt.physical_state)
    )
      fail("terminal result requires observed cessation");
    if (receipt.outcome !== "uncertain" && receipt.effect_certainty === "uncertain")
      fail("uncertain effects cannot claim a certain result");
    if (receipt.outcome === "complete" && ["failed", "unknown"].includes(receipt.validation))
      fail("completion requires known successful or explicitly skipped validation");
    if (receipt.validation === "skipped" && receipt.validation_failures !== null)
      fail("unchecked validation must be null");
    if (
      receipt.validation === "passed" &&
      (!receipt.validation_failures || receipt.validation_failures.length)
    )
      fail("passed validation must contain an empty failure list");
    if (receipt.validation === "failed" && !receipt.validation_failures?.length)
      fail("failed validation requires reasons");
    if (new Set(receipt.stages.map((stage) => stage.stage)).size !== receipt.stages.length)
      fail("stage receipts must be unique");
    for (const stage of receipt.stages)
      if (
        stage.effect_key !==
        logicalStageEffectKey(receipt.owner, receipt.workflow_id, receipt.activity_id, stage.stage)
      )
        fail("stage effect key binding mismatch");
  });

/** The physical attempt and its delivery fence never change the logical effect key. */
export function logicalStageEffectKey(
  owner: string,
  workflow: string,
  activity: string,
  stage: z.infer<typeof stageReceiptSchema>["stage"],
): string {
  [owner, workflow, activity].forEach((value) => ref.parse(value));
  stageReceiptSchema.shape.stage.parse(stage);
  return `eff_${createHash("sha256")
    .update(encode([owner, workflow, activity, stage]))
    .digest("hex")}`;
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Authenticate and derive the namespace before calling this helper or looking up a key. */
export function workIntentHash(submission: WorkSubmission, namespace: WorkNamespace): string {
  const { request_id: _, ...intent } = workSubmissionSchema.parse(submission);
  const normalized = JSON.parse(
    encode({ ...intent, namespace: workNamespaceSchema.parse(namespace) }),
  ) as Json;
  if (
    intent.overrides?.traits &&
    normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
  ) {
    (normalized.overrides as { traits: Json }).traits = [
      ...new Set(intent.overrides.traits),
    ].sort();
  }
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

export const workStateFactsSchema = z.strictObject({
  coordinator: z.enum(["running", "blocked", "completed", "failed", "cancelled", "timed_out"]),
  phase: z.enum(["queued", "preflight", "executing", "validating", "publishing", "terminal"]),
  wait: z.enum(["none", "timer", "dependency", "signal", "human-decision"]),
  physical: physicalStateSchema,
  effect: effectCertaintySchema,
  stop_requested: z.boolean(),
  has_result: z.boolean(),
  can_continue: z.boolean(),
  can_retry_step: z.boolean(),
  can_respond: z.boolean(),
});
export type WorkStateFacts = z.infer<typeof workStateFactsSchema>;
export type WorkState =
  | "queued"
  | "running"
  | "waiting"
  | "waiting-for-approval"
  | "completed"
  | "failed"
  | "stopping"
  | "cancelled"
  | "needs-attention";
export type WorkControl =
  "inspect" | "stop" | "continue" | "retry-step" | "run-again" | "reconcile" | "respond" | "result";
/** One authoritative projection for browser/CLI/API; callers cannot infer certainty from prose errors. */
export function projectWorkState(input: WorkStateFacts): {
  state: WorkState;
  allowed_actions: WorkControl[];
} {
  const facts = workStateFactsSchema.parse(input);
  const stopped = facts.physical === "ceased" || facts.physical === "not-started";
  let state: WorkState;
  if (facts.physical === "unknown" || facts.coordinator === "blocked" ||
    (facts.effect === "uncertain" && !(facts.physical === "running" &&
      (facts.coordinator === "running" || (facts.stop_requested && ["cancelled", "timed_out"].includes(facts.coordinator))))))
    state = "needs-attention";
  else if (
    (facts.stop_requested ||
      facts.coordinator === "cancelled" ||
      facts.coordinator === "timed_out") &&
    !stopped
  )
    state = "stopping";
  else if (facts.coordinator === "cancelled") state = "cancelled";
  else if (facts.coordinator === "timed_out" || facts.coordinator === "failed")
    state = stopped ? "failed" : "needs-attention";
  else if (facts.coordinator === "completed") state = stopped ? "completed" : "needs-attention";
  else if (facts.stop_requested) state = "stopping";
  else if (facts.wait === "human-decision") state = "waiting-for-approval";
  else if (facts.wait !== "none") state = "waiting";
  else state = facts.phase === "queued" ? "queued" : "running";
  const actions: WorkControl[] = ["inspect"];
  if (facts.has_result) actions.push("result");
  if (["completed", "failed", "cancelled"].includes(state)) actions.push("run-again");
  else {
    if (!facts.stop_requested && (!stopped || ["running", "blocked"].includes(facts.coordinator)))
      actions.push("stop");
    if (state === "needs-attention") {
      if (facts.coordinator === "blocked") actions.push("reconcile");
      if (stopped && facts.effect !== "uncertain" && facts.can_continue) actions.push("continue");
      if (stopped && facts.effect !== "uncertain" && facts.can_retry_step)
        actions.push("retry-step");
    }
    if (state === "waiting-for-approval" && facts.can_respond) actions.push("respond");
  }
  return { state, allowed_actions: [...new Set(actions)] };
}

export const workPlanSchema = z.strictObject({
  version: z.literal(2),
  definition: workDefinitionSchema,
  workflow: z.strictObject({
    type: ref,
    version: ref,
    artifact_digest: digest,
    runtime_abi: ref,
    input_digest: digest,
  }),
  source_closure: z.array(workArtifactSchema).min(1).max(1000),
  grant_ref: ref,
  grant_revision: revision,
  executor_generation: ref,
  grant_digest: digest,
  execution_profile: z.enum(["portable", "resource-contained"]),
  effect_policy: workEffectPolicySchema,
  validation: workValidationSchema.optional(),
  node_job: workNodeJobSchema.optional(),
  process_program: workProcessProgramSchema.optional(),
  agent_program: workAgentProgramSchema.optional(),
  resources: workResourcesSchema,
  workspace: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("host-bound"),
      installation: ref,
      resource_ref: ref,
      mapping_version: revision,
    }),
    z.strictObject({
      kind: z.literal("verified"),
      resource_ref: ref,
      mapping_digest: digest,
      writable: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("isolated"),
      input_bundle: workArtifactSchema,
      publication_contract: ref.nullable(),
    }),
  ]),
  selection: z.strictObject({
    requested_model: ref.nullable(),
    resolved_model: ref.nullable(),
    endpoint: ref.nullable(),
    requested_harness: ref.nullable(),
    resolved_harness: ref.nullable(),
    provenance: ref,
  }),
  execution_budget_ms: duration,
  /** Trusted policy's overall lifetime, including authored dependency waits. */
  overall_budget_ms: duration.optional(),
  dispatch_budget_ms: duration.max(3_600_000),
}).refine(plan => plan.overall_budget_ms === undefined || plan.definition.kind === "workflow", "Separate overall lifetime is available only for generic workflows")
  .superRefine((plan, context) => {
    if ([plan.agent_program, plan.process_program, plan.node_job].filter(Boolean).length > 1)
      context.addIssue({ code: "custom", message: "Execution program declarations are mutually exclusive" });
    if (plan.agent_program && (plan.resources.executor !== "agent" || !plan.source_closure.some(source =>
      boundFingerprint(source) === boundFingerprint(plan.agent_program!.profile))))
      context.addIssue({ code: "custom", message: "Agent plan requires its exact retained profile and agent executor" });
  });
export const workAdmissionSchema = z
  .strictObject({
    version: z.literal(2),
    request_id: z.uuid(),
    idempotency_key: ref,
    namespace: workNamespaceSchema,
    work_id: ref,
    workflow_id: ref,
    action_id: ref.nullable(),
    job_run_id: ref.nullable(),
    request_hash: digest,
    plan_digest: digest,
    plan: workPlanSchema,
    grant_ref: ref,
    grant_revision: revision,
    origin: workOriginSchema,
    title: z.string().min(1).max(200),
    accepted_at: timestamp,
    dispatch_deadline: timestamp,
    first_started_at: timestamp.nullable(),
    execution_deadline: timestamp.nullable(),
    revision,
    facts: workStateFactsSchema,
    reason: workReasonSchema.nullable(),
    receipt_ref: ref.nullable(),
    projection: z.strictObject({
      desired_revision: revision,
      applied_revision: z.number().int().nonnegative(),
    }),
    notification: z.strictObject({
      desired_revision: z.number().int().nonnegative(),
      applied_revision: z.number().int().nonnegative(),
    }),
  })
  .superRefine((admission, context) => {
    if (
      admission.grant_ref !== admission.plan.grant_ref ||
      admission.grant_revision !== admission.plan.grant_revision
    )
      context.addIssue({ code: "custom", message: "admission grant differs from pinned plan" });
    if (admission.plan_digest !== workPlanHash(admission.plan))
      context.addIssue({ code: "custom", message: "admission plan digest mismatch" });
    if (
      admission.projection.applied_revision > admission.projection.desired_revision ||
      admission.notification.applied_revision > admission.notification.desired_revision
    )
      context.addIssue({
        code: "custom",
        message: "applied outbox revision exceeds desired revision",
      });
  });
export type WorkPlan = z.infer<typeof workPlanSchema>;
export type WorkAdmission = z.infer<typeof workAdmissionSchema>;
export type WorkExecutionStart = z.infer<typeof executorStartSchema>;
export function workPlanHash(plan: WorkPlan): string {
  const normalized = JSON.parse(encode(workPlanSchema.parse(plan), limits.envelope)) as Json;
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}
export const humanDecisionResponseSchema = z.strictObject({
  version: z.literal(2),
  decision_id: ref,
  expected_revision: revision,
  request_id: z.uuid(),
  option_id: ref,
});
/** Actor comes from authenticated context, never from the response body. */
export function validateHumanDecisionResponse(
  decision: z.infer<typeof humanDecisionSchema>,
  input: z.infer<typeof humanDecisionResponseSchema>,
  actor: string,
  now: number,
): void {
  decision = humanDecisionSchema.parse(decision);
  const response = humanDecisionResponseSchema.parse(input);
  if (!decision.allowed_responders.includes(actor))
    throw new Error("decision responder is unauthorized");
  if (
    response.decision_id !== decision.decision_id ||
    response.expected_revision !== decision.revision
  )
    throw new Error("decision revision or binding mismatch");
  if (!Number.isSafeInteger(now) || now >= decision.deadline) throw new Error("decision expired");
  if (!decision.options.some((option) => option.id === response.option_id))
    throw new Error("decision option is not allowed");
}
