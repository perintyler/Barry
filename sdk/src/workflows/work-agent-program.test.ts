import { expect, it } from "vitest";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { workAgentProgramSchema } from "./work-agent-program.js";
import { executorStartSchema, workPlanHash, workPlanSchema } from "./work-contracts.js";
import { workExecutionDelegationSchema } from "./work-execution-delegation.js";

/** Contract-only evidence: no native runtime, owner grant issuance or resource
 * acquisition is simulated by these fixtures. */
async function declaration() {
  const scope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
  const profile = { digest: "a".repeat(64), bytes: 37, media_type: "application/json", owner_identity: "alice", purpose: "source" as const };
  const program = { activity_type: "agent:profile@1", source_digest: profile.digest, installation: "installation", scope, profile };
  const namespace = { installation: "installation", principal_kind: "identity" as const, principal_id: "alice", identity_id: "alice", caller_session_id: "caller" };
  const grant = { version: 2 as const, grant_ref: "grant", revision: 1, namespace, authorizer: "alice", created_by: "alice", approved_at: 1,
    original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "policy" };
  const plan = workPlanSchema.parse({ version: 2, definition: { kind: "action", reference: "bag:agent", catalog_namespace: "bag" },
    workflow: { type: "agent-action", version: "1", artifact_digest: "b".repeat(64), runtime_abi: "fixture-contract", input_digest: boundFingerprint({}) },
    source_closure: [profile], grant_ref: "grant", grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "sessions-v1",
    execution_profile: "portable", effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: { mode: "none" }, agent_program: program,
    resources: { executor: "agent", lane: "unscheduled", logical_reservation: "logical", host_reservation: null, endpoint: null }, workspace: { kind: "none" },
    selection: { requested_model: null, resolved_model: "vendor/model", requested_harness: null, resolved_harness: "pi", endpoint: "endpoint", provenance: "installed" },
    execution_budget_ms: 1000, dispatch_budget_ms: 1000 });
  const admission = "c".repeat(64);
  const start = executorStartSchema.parse({ version: 2, owner: "installation", work_id: "work", workflow_id: "workflow", activity_id: "activity", attempt_id: "attempt",
    request_hash: boundFingerprint({ admission, activity: "activity", type: program.activity_type, input: {} }), plan_digest: workPlanHash(plan),
    grant_ref: "grant", grant_revision: 1, source: profile, execution_fence: 1, deadline: 1000, launch_authorized: true, inputs: {},
    effect_policy: plan.effect_policy, resources: { ...plan.resources, host_reservation: "held" }, executor_generation: plan.executor_generation,
    validation: plan.validation, agent_program: program, activity_type: program.activity_type, output_identity: "alice" });
  return { program, plan, start, envelope: { version: 1 as const, admission_request_hash: admission, start, namespace,
    origin: { entry_point: "sessions", trigger: "invocation" as const, caller_session_id: "caller" }, grant, plan } };
}

it("retains the exact typed profile and scope in an activated accepted execution delegation", async () => {
  const f = await declaration();
  expect(workAgentProgramSchema.parse(f.program)).toEqual(f.program);
  expect(workExecutionDelegationSchema.parse(f.envelope).start.agent_program).toEqual(f.program);
});

it("refuses a profile with altered digest, output purpose, private extensions or overlong references", async () => {
  const { program } = await declaration();
  for (const value of [
    { ...program, source_digest: "d".repeat(64) },
    { ...program, profile: { ...program.profile, purpose: "output" } },
    { ...program, credential: "must-never-be-inline" },
    { ...program, installation: "é".repeat(101) },
  ]) expect(workAgentProgramSchema.safeParse(value).success).toBe(false);
});

it("requires the exact source artifact in the accepted closure and the agent resource family", async () => {
  const { plan, program } = await declaration();
  expect(workPlanSchema.safeParse({ ...plan, resources: { ...plan.resources, executor: "process" } }).success).toBe(false);
  expect(workPlanSchema.safeParse({ ...plan, source_closure: [{ ...program.profile, owner_identity: "bob" }] }).success).toBe(false);
  expect(workPlanSchema.safeParse({ ...plan, node_job: { activity_type: "node", source_digest: program.source_digest, scope: program.scope, output: "none" } }).success).toBe(false);
});

it("refuses activity, installation, full source identity and executor substitutions at the start boundary", async () => {
  const { start } = await declaration();
  for (const value of [
    { ...start, activity_type: "another-activity" },
    { ...start, owner: "another-installation" },
    { ...start, source: { ...start.source, owner_identity: "bob" } },
    { ...start, resources: { ...start.resources, executor: "process" } },
    { ...start, node_job: { activity_type: "node", source_digest: start.source.digest, scope: start.agent_program!.scope, output: "none" } },
  ]) expect(executorStartSchema.safeParse(value).success).toBe(false);
});

it("rejects a self-consistent substituted program scope even when its changed plan hash is recomputed", async () => {
  const { envelope } = await declaration();
  const changed = structuredClone(envelope);
  const { fingerprint: _fingerprint, ...original } = changed.start.agent_program!.scope;
  const evidence = { ...original, identity: "bob" };
  const scope = { ...evidence, fingerprint: boundFingerprint(evidence) };
  changed.start.agent_program!.scope = scope;
  changed.plan.agent_program!.scope = scope;
  changed.start.plan_digest = workPlanHash(changed.plan);
  expect(workExecutionDelegationSchema.safeParse(changed).success).toBe(false);
});

it("rejects a changed retained plan program even when the start and plan are separately valid", async () => {
  const { envelope } = await declaration();
  const changed = structuredClone(envelope);
  changed.plan.agent_program!.activity_type = "other-agent";
  changed.start.plan_digest = workPlanHash(changed.plan);
  expect(workExecutionDelegationSchema.safeParse(changed).success).toBe(false);
});
