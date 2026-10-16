import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { inspectArtifact } from "./artifacts.js";
import { ProcessExecutor } from "./executor.js";
import { WorkflowError } from "./errors.js";
import { connectWorkOwnerV3 } from "./protocol.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import type { WorkAuthority } from "./work-authority.js";
import { executorFeaturesSchema, executorStartSchema, workPlanHash, workPlanSchema, type WorkSubmission } from "./work-contracts.js";
import { workExecutionDelegationSchema, type WorkExecutionDelegation } from "./work-execution-delegation.js";
import { WorkPolicyDispatcher } from "./work-bounds.js";
import { WorkResourceBroker } from "./work-resource-broker.js";
import { WorkflowOwner } from "./workflow-owner.js";
import { encodeEnvelope } from "./types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Delegation fixture cleanup failed");
});

/** Owner-local admission composition, as in work-admission.test.ts: test
 * authentication/catalog callbacks are trusted, but acceptance, immutable grant
 * storage, policy dispatch, claims and both broker acquisitions are production.
 * No executor result/receipt or native-cessation evidence is synthesized. */
async function fixture() {
  let now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "work-execution-delegation-"));
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const sourcePath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
  const workflow = inspectArtifact(sourcePath, "echo", "1");
  const source = artifacts.stage(readFileSync(sourcePath), { owner_identity: null, purpose: "source", media_type: "text/javascript" });
  const scope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
  const broker = new WorkResourceBroker({ path: join(root, "resources.db"), broker: "shared-broker", now: () => now, limits: {
    host: { kind: "host" }, endpoint: { kind: "endpoint", concurrency: 2, input_tokens: 10000, output_tokens: 10000, cost_micros: 2000000 },
  } });
  let revoked = false;
  const policyReads: { work: string; worker: string; activity: string }[] = [];
  const policy = new WorkPolicyDispatcher(async (work, _grant, worker, activity) => {
    policyReads.push({ work: work.work_id, worker, activity });
    return revoked ? null : scope;
  });
  const path = join(root, "owner.db");
  const owner = new WorkflowOwner({ id: "owner", path, now: () => now, artifacts: [workflow],
    activityArtifacts: { echo: workflow.digest }, executor: new ProcessExecutor(), workArtifacts: artifacts,
    workResources: { host: () => ({ broker: broker.id, resource: "host" }), brokers: new Map([[broker.id, broker]]) },
    authorizeWork: policy.current,
  });
  cleanup.push(async () => {
    try { await owner.drain(); } finally {
      owner.close();broker.close();artifacts.close();rmSync(root, { recursive: true, force: true });
    }
  });
  const request: WorkSubmission = { version: 2, request_id: "0fbbeaf3-3aeb-479e-8258-0484587e5721", idempotency_key: "delegated-turn",
    authority_ref: "trusted-test-issuer", definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: "hello" },
    origin: { entry_point: "delegation-spec", trigger: "invocation", caller_session_id: "owned-session" } };
  const authority: WorkAuthority = { namespace: { installation: owner.id, principal_kind: "identity", principal_id: "alice", identity_id: "alice", caller_session_id: "owned-session" },
    caller_ceiling: scope, origin: request.origin, run_identity: "alice" };
  const grant = { version: 2 as const, grant_ref: "accepted-grant", revision: 1, namespace: authority.namespace, authorizer: "alice", created_by: "alice",
    approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "trusted-catalog-1" };
  const resolution: WorkResolution = { title: "Delegated agent metadata", grant, workflow_input: request.inputs, plan: {
    version: 2, definition: request.definition, workflow: { type: "echo", version: "1", artifact_digest: workflow.digest, runtime_abi: workflow.abi, input_digest: boundFingerprint(request.inputs) },
    source_closure: [source], grant_ref: grant.grant_ref, grant_revision: grant.revision, grant_digest: boundFingerprint(grant), executor_generation: "delegation-test-v1",
    execution_profile: "portable", effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: { mode: "none" },
    resources: { executor: "agent", lane: "unscheduled", logical_reservation: "owner-assigned", host_reservation: null,
      endpoint: { broker: broker.id, endpoint: "endpoint", reservation: null, model: "openai/probe", max_input_tokens: 100, max_output_tokens: 100, max_cost: 0.01 } },
    workspace: { kind: "none" }, selection: { requested_model: "openai/probe", resolved_model: "openai/probe", endpoint: "endpoint",
      requested_harness: "pi", resolved_harness: "pi", provenance: "trusted-catalog" }, execution_budget_ms: 60000, dispatch_budget_ms: 60000,
  } };
  const admission = new WorkAdmissionService({ owner,
    authenticate: async (_input: WorkSubmission, credential: string) => {
      if (credential !== "trusted-test-credential") throw new WorkflowError("Forbidden", "Wrong test credential", 403);
      return authority;
    }, resolve: async () => structuredClone(resolution),
  });
  const accepted = await admission.submit(request, "trusted-test-credential");
  await owner.pump();
  const messages: unknown[] = [];
  const client = connectWorkOwnerV3(owner.id, async message => { messages.push(structuredClone(message));return policy.dispatch(owner, "worker", message); });
  await client.advertise({ types: ["echo"], artifacts: { echo: workflow.digest }, capacity: 1 }, executorFeaturesSchema.parse({
    version: 2, installation: owner.id, boot_identity: "metadata-fixture-only", observed_at: now, expires_at: now + 15000,
    executors: ["structured-agent"], features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "endpoint-arbiter", "declared-validation"],
    runtimes: {}, workspaces: ["none"], containment: "portable",
  }));
  const task = await client.claim("first-claim");
  expect(task).not.toBeNull();
  if (!task?.work) throw new Error("Real owner did not claim admitted common work");
  return { owner, broker, accepted, grant, client, task, messages, policy, policyReads, resolution,
    advance: (milliseconds: number) => { now += milliseconds; }, now: () => now,
    editMetadata: (sql: string, token: string) => {
      const db = new SqliteDatabase(path);
      try { db.prepare(sql).run(token); } finally { db.close(); }
    },
    revoke: () => { revoked = true; },
    latestRequest: () => {
      const last = messages.at(-1);
      if (!last || typeof last !== "object") throw new Error("No current worker request");
      return structuredClone(last);
    },
  };
}

it("refuses execution delegation before begin has acquired and activated resources", async () => {
  const f = await fixture();
  expect(f.task.work?.launch_authorized).toBe(false);
  await expect(f.client.delegation(f.task.token)).rejects.toThrow();
  expect(f.owner.workById(f.accepted.namespace, f.accepted.work_id)?.first_started_at).toBeNull();
});

it("returns the exact accepted authority and plan with independently held host and endpoint acknowledgements", async () => {
  const f = await fixture(), start = await f.client.begin(f.task.token);
  const envelope = await f.client.delegation(f.task.token);
  expect(workExecutionDelegationSchema.parse(envelope)).toEqual(envelope);
  expect(envelope).toEqual({ version: 1, admission_request_hash: f.accepted.request_hash, start,
    namespace: f.accepted.namespace, origin: f.accepted.origin, grant: f.grant, plan: f.accepted.plan });
  expect(start.activity_type).toBe("echo");
  expect(start.request_hash).toBe(boundFingerprint({ admission: f.accepted.request_hash, activity: start.activity_id, type: start.activity_type, input: start.inputs }));
  expect(start.resources.host_reservation).not.toBeNull();
  expect(start.resources.endpoint?.reservation).not.toBeNull();
  expect(f.broker.inspect(start.resources.host_reservation!)?.state).toBe("held");
  expect(f.broker.inspect(start.resources.endpoint!.reservation!)?.state).toBe("held");
  expect(start.resources.logical_reservation).toBe(f.accepted.plan.resources.logical_reservation);
});

it("isolates returned envelope mutations from the accepted grant, plan, start and subsequent reads", async () => {
  const f = await fixture();await f.client.begin(f.task.token);
  const original = await f.client.delegation(f.task.token), changed = await f.client.delegation(f.task.token);
  changed.grant.effective_scope.identity = "other";
  changed.namespace.identity_id = "other";
  changed.plan.selection.resolved_harness = "other";
  changed.start.resources.host_reservation = "other";
  expect(await f.client.delegation(f.task.token)).toEqual(original);
  expect(f.owner.workById(f.accepted.namespace, f.accepted.work_id)?.plan).toEqual(original.plan);
});

it("rejects independently inconsistent input, scope, plan, executable and resource evidence", async () => {
  const f = await fixture();await f.client.begin(f.task.token);
  const original = await f.client.delegation(f.task.token);
  const changes: { name: string; apply: (value: WorkExecutionDelegation) => void }[] = [
    { name: "different owner", apply: value => { value.start.owner = "another-owner"; } },
    { name: "different grant", apply: value => { value.grant.revision++; } },
    { name: "different execution identity", apply: value => { value.grant.effective_scope.identity = "another-identity"; } },
    { name: "different accepted input", apply: value => { value.start.inputs = "different input"; } },
    { name: "different admission intent", apply: value => { value.admission_request_hash = "f".repeat(64); } },
    { name: "different plan", apply: value => { value.plan.selection.resolved_harness = "another-harness"; } },
    { name: "different executable", apply: value => { value.start.source.digest = "f".repeat(64); } },
    { name: "different resource placement", apply: value => { value.start.resources.lane = "scheduled"; } },
    { name: "unacknowledged host", apply: value => { value.start.resources.host_reservation = null; } },
    { name: "unacknowledged endpoint", apply: value => { if (value.start.resources.endpoint) value.start.resources.endpoint.reservation = null; } },
  ];
  for (const change of changes) {
    const value = structuredClone(original);change.apply(value);
    expect(workExecutionDelegationSchema.safeParse(value).success, change.name).toBe(false);
  }
  const { launch_authorized: _activation, ...withoutActivation } = original.start;
  const { activity_type: _activity, ...withoutActivity } = original.start;
  expect(workExecutionDelegationSchema.safeParse({ ...original, start: withoutActivation }).success).toBe(false);
  expect(workExecutionDelegationSchema.safeParse({ ...original, start: withoutActivity }).success).toBe(false);
  expect(workExecutionDelegationSchema.safeParse({ ...original, start: { ...original.start, launch_authorized: false } }).success).toBe(false);
  const creator = structuredClone(original);creator.grant.created_by = "different-creator";
  creator.plan.grant_digest = boundFingerprint(creator.grant);creator.start.plan_digest = workPlanHash(creator.plan);
  expect(workExecutionDelegationSchema.safeParse(creator).success).toBe(false);
  expect(workExecutionDelegationSchema.safeParse({ ...original, origin: { ...original.origin, caller_session_id: "other-origin" } }).success).toBe(false);
  expect(workExecutionDelegationSchema.safeParse({ ...original, arbitrary_principal: "operator" }).success).toBe(false);
});

it("bounds the whole delegation even when each individual member fits its transport envelope", async () => {
  const f = await fixture();await f.client.begin(f.task.token);
  const value = await f.client.delegation(f.task.token);
  const names = Array.from({ length: 1000 }, (_, index) => `tool-${index}-${"a".repeat(180)}`);
  const evidence = { identity: "alice", traits: [], bound: null,
    tools: Object.fromEntries(names.map(name => [name, "read" as const])),
    contracts: Object.fromEntries(names.map(name => [name, "a".repeat(64)])) };
  const scope = { ...evidence, fingerprint: boundFingerprint(evidence) };
  value.grant.original_caller_ceiling = scope;value.grant.effective_scope = structuredClone(scope);
  value.plan.grant_digest = boundFingerprint(value.grant);value.start.plan_digest = workPlanHash(value.plan);
  // Small-input control validates all recomputed bindings independently of size.
  expect(workExecutionDelegationSchema.safeParse(value).success).toBe(true);
  value.start.inputs = "x".repeat(250000);
  value.start.request_hash = boundFingerprint({ admission: value.admission_request_hash, activity: value.start.activity_id, type: value.start.activity_type, input: value.start.inputs });
  expect(executorStartSchema.safeParse(value.start).success).toBe(true);
  for (const member of [value.start, value.grant, value.plan]) expect(() => encodeEnvelope(member)).not.toThrow();
  const result = workExecutionDelegationSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some(issue => issue.message.includes("envelope limit"))).toBe(true);
});

it("returns a safeParse refusal instead of throwing while hashing a structurally valid oversized plan", async () => {
  const f = await fixture();await f.client.begin(f.task.token);
  const original = await f.client.delegation(f.task.token);
  // Deliberately malformed response metadata, never admitted or executed as a
  // process program. Each argv member fits its schema; the plan as a whole is
  // too large for workPlanHash's transport encoder.
  const plan = workPlanSchema.parse({ ...original.plan, process_program: {
    activity_type: "echo", source_digest: original.start.source.digest, installation: "owner",
    scope: original.grant.effective_scope, runtime: original.start.source,
    argv: Array.from({ length: 300 }, () => "x".repeat(4096)), source_name: "retained.mjs",
    cwd: { path: "/fixture", device: 0, inode: 0 }, env: {}, secret_names: [], output: "none",
    credential_owner: { kind: "none" },
  } });
  expect(workPlanSchema.safeParse(plan).success).toBe(true);
  expect(() => encodeEnvelope(plan)).toThrow();
  const parse = () => workExecutionDelegationSchema.safeParse({ ...original, plan });
  expect(parse).not.toThrow();
  const result = parse();
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.some(issue => issue.message.includes("envelope limit"))).toBe(true);
});

it("refreshes policy for every delegation request and cannot reuse another request's authorization", async () => {
  const f = await fixture();await f.client.begin(f.task.token);f.policyReads.length = 0;
  await f.client.delegation(f.task.token);
  expect(f.policyReads).toEqual([{ work: f.accepted.work_id, worker: "worker", activity: "echo" }]);
  expect(() => f.owner.executionDelegation("worker", f.task.token)).toThrow();
  f.policyReads.length = 0;f.revoke();
  await expect(f.client.delegation(f.task.token)).rejects.toMatchObject({ code: "WorkAuthorityUnavailable" });
  expect(f.policyReads).toEqual([{ work: f.accepted.work_id, worker: "worker", activity: "echo" }]);
});

it.each(["host", "endpoint"] as const)("refuses delegation when the actual %s broker acknowledgement is no longer held", async role => {
  const f = await fixture(), start = await f.client.begin(f.task.token);
  const reservation = role === "host" ? start.resources.host_reservation! : start.resources.endpoint!.reservation!;
  expect(f.broker.markUnknown(reservation).state).toBe("unknown");
  await expect(f.client.delegation(f.task.token)).rejects.toMatchObject({ code: "WorkResourceFenced" });
});

it("refuses cancelled, unknown-token and wrong-worker delegation without leaking retained authority", async () => {
  const f = await fixture();await f.client.begin(f.task.token);await f.client.delegation(f.task.token);
  const request = f.latestRequest();
  await expect(f.policy.dispatch(f.owner, "different-worker", request)).rejects.toThrow();
  await expect(f.client.delegation("unrelated-token")).rejects.toThrow();
  f.owner.cancel(f.accepted.workflow_id);
  await expect(f.client.delegation(f.task.token)).rejects.toThrow();
});

it("fences stale worker sessions and owner epochs before returning any delegation", async () => {
  const f = await fixture();await f.client.begin(f.task.token);await f.client.delegation(f.task.token);
  const request = f.latestRequest();
  await expect(f.policy.dispatch(f.owner, "worker", { ...request, epoch: "obsolete-owner-epoch" })).rejects.toThrow();
  f.owner.openSession("worker", "replacement-worker-session");
  await expect(f.policy.dispatch(f.owner, "worker", request)).rejects.toThrow();
});

it("keeps the accepted execution owner epoch immutable without bypassing the binding trigger", async () => {
  const f = await fixture();await f.client.begin(f.task.token);
  const original = await f.client.delegation(f.task.token);
  expect(() => f.editMetadata("UPDATE workflow_work_executions SET owner_epoch='previous-owner' WHERE token=?", f.task.token)).toThrow(/work execution binding is immutable/);
  expect(await f.client.delegation(f.task.token)).toEqual(original);
  // An ordinary supported close/reopen retains the owner epoch and launch
  // permit. It cannot honestly exercise a mismatched persisted epoch guard.
  // That defensive guard remains source-reviewed; transport epoch/session
  // fencing is exercised separately above. Never drop the immutable trigger.
});

it.each(["lease", "deadline"] as const)("refuses an expired %s while retaining the real held reservations", async kind => {
  const f = await fixture(), start = await f.client.begin(f.task.token);
  if (kind === "lease") f.editMetadata("UPDATE workflow_commands SET lease_until=0 WHERE token=?", f.task.token);
  else {
    f.editMetadata("UPDATE workflow_commands SET lease_until=9999999999999 WHERE token=?", f.task.token);
    f.advance(start.deadline - f.now() + 1);
  }
  await expect(f.client.delegation(f.task.token)).rejects.toMatchObject({ code: "WorkDelegationFenced" });
  expect(f.broker.inspect(start.resources.host_reservation!)?.state).toBe("held");
  expect(f.broker.inspect(start.resources.endpoint!.reservation!)?.state).toBe("held");
});

it("rejects a well-formed response bound to another requested token or expected owner", async () => {
  const f = await fixture();await f.client.begin(f.task.token);
  const evidence = await f.client.delegation(f.task.token);
  for (const owner of ["owner", "another-owner"]) {
    const client = connectWorkOwnerV3(owner, async request => {
      if (typeof request === "object" && request && "operation" in request && request.operation === "hello")
        return { version: 3, owner, epoch: "fixture-peer-epoch", maxEnvelopeBytes: 1048576,
          features: ["work-receipts", "work-observations", "online-effects", "launch-authorizations", "execution-delegations"] };
      return structuredClone(evidence);
    });
    await expect(client.delegation(owner === "owner" ? "another-token" : f.task.token)).rejects.toThrow(/binding mismatch/);
  }
});

it("refuses an older owner without the delegation feature before sending the authority operation", async () => {
  const calls: unknown[] = [];
  const client = connectWorkOwnerV3("old-owner", async request => {
    calls.push(request);
    return { version: 3, owner: "old-owner", epoch: "old-epoch", maxEnvelopeBytes: 1048576,
      features: ["work-receipts", "work-observations", "online-effects", "launch-authorizations"] };
  });
  await expect(client.delegation("accepted-token")).rejects.toThrow(/incompatible|delegation/i);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ operation: "hello" });
});
