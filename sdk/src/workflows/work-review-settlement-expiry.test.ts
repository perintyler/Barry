/** Owner/admission/SQLite regression, not native cessation qualification.
 * Authentication/catalog callbacks and the bound ceased executor receipt are
 * controlled protocol inputs. No process is launched to justify that receipt.
 * No SQL writes or private owner methods construct the intermediate states.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { inspectArtifact } from "./artifacts.js";
import { ProcessExecutor } from "./executor.js";
import { workReceiptDigest } from "./executor-journal.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import type { WorkAuthority } from "./work-authority.js";
import { executionBindingSchema, executorFeaturesSchema, workReceiptSchema, type WorkSubmission } from "./work-contracts.js";
import { WorkResourceBroker } from "./work-resource-broker.js";
import { WorkflowOwner } from "./workflow-owner.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Settlement-expiry fixture cleanup failed");
});

async function fixture() {
  let now = Date.now(), revoked = false;
  const root = mkdtempSync(join(tmpdir(), "work-review-settlement-")), path = join(root, "owner.db");
  const sourcePath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
  const workflow = inspectArtifact(sourcePath, "echo", "1"), artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const source = artifacts.stage(readFileSync(sourcePath), { owner_identity: null, purpose: "source", media_type: "text/javascript" });
  const scope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
  const broker = new WorkResourceBroker({ path: join(root, "resources.db"), broker: "host", now: () => now, limits: { local: { kind: "host" } } });
  const owner = new WorkflowOwner({ id: "owner", path, now: () => now, artifacts: [workflow], activityArtifacts: { echo: workflow.digest },
    executor: new ProcessExecutor(), workArtifacts: artifacts,
    // The legacy owner authorization hook really blocks/revokes the attempt;
    // current full Work policy remains separately authorized for this fixture.
    authorize: () => !revoked, authorizeWork: () => scope,
    workResources: { host: () => ({ broker: broker.id, resource: "local" }), brokers: new Map([[broker.id, broker]]) },
  });
  cleanup.push(async () => {
    try { await owner.drain(); } finally { owner.close();broker.close();artifacts.close();rmSync(root, { recursive: true, force: true }); }
  });
  const request: WorkSubmission = { version: 2, request_id: "49533da2-90db-470b-ad45-40861e9c6522", idempotency_key: "review-settlement",
    authority_ref: "trusted-fixture-catalog", definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: "retained input",
    origin: { entry_point: "settlement-regression", trigger: "invocation", caller_session_id: "owned-session" } };
  const authority: WorkAuthority = { namespace: { installation: owner.id, principal_kind: "identity", principal_id: "alice", identity_id: "alice", caller_session_id: "owned-session" },
    caller_ceiling: scope, origin: request.origin, run_identity: "alice" };
  const grant = { version: 2 as const, grant_ref: "review-grant", revision: 1, namespace: authority.namespace, authorizer: "alice", created_by: "alice", approved_at: now,
    original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture-1" };
  const resolution: WorkResolution = { title: "Settlement expiry", grant, workflow_input: request.inputs, plan: {
    version: 2, definition: request.definition, workflow: { type: "echo", version: "1", artifact_digest: workflow.digest, runtime_abi: workflow.abi, input_digest: boundFingerprint(request.inputs) },
    source_closure: [source], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "review-fixture",
    execution_profile: "portable", effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: { mode: "none" },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: null },
    workspace: { kind: "none" }, selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "fixture-catalog" },
    execution_budget_ms: 60000, dispatch_budget_ms: 120000,
  } };
  const admission = new WorkAdmissionService({ owner, authenticate: async (_request, credential: string) => {
    if (credential !== "trusted-fixture-credential") throw new Error("Wrong fixture credential");return authority;
  }, resolve: async () => structuredClone(resolution) });
  const accepted = await admission.submit(request, "trusted-fixture-credential");await owner.pump();
  owner.advertiseWork("worker", { types: ["echo"], artifacts: { echo: workflow.digest }, capacity: 1 }, executorFeaturesSchema.parse({
    version: 2, installation: owner.id, boot_identity: "protocol-fixture", observed_at: now, expires_at: now + 15000,
    executors: ["process"], features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "declared-validation"], runtimes: {}, workspaces: ["none"], containment: "portable",
  }));
  const task = owner.claimWork("worker", "review-claim");expect(task).not.toBeNull();
  if (!task) throw new Error("Admitted fixture work was not claimed");
  const start = owner.beginWork("worker", task.token);
  const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof typeof start]])));
  const unsigned = { ...binding, receipt_ref: "bound-ceased-fixture-receipt", revision: owner.inspectWork("worker", task.token).observation.revision + 1, committed_at: now,
    physical_state: "ceased" as const, effect_certainty: "known" as const, outcome: "cancelled" as const,
    stages: [], output: null, summary: "Controlled executor protocol reports cessation", validation: "skipped" as const, validation_failures: null };
  const receipt = workReceiptSchema.parse({ ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  const inspect = <T>(sql: string): T => { const db = new SqliteDatabase(path);try { return db.prepare(sql).get(task.token) as T; } finally { db.close(); } };
  const attempt = () => inspect<{ state: string; physical_state: string }>("SELECT state,physical_state FROM workflow_attempts WHERE token=?");
  const command = () => inspect<{ state: string; lease_until: number | null; deadline: number; attempt_deadline: number }>("SELECT state,lease_until,deadline,attempt_deadline FROM workflow_commands WHERE token=?");
  const reservation = () => { const db = new SqliteDatabase(path);try { return db.prepare("SELECT state FROM workflow_work_reservations WHERE run_id=?").get(accepted.workflow_id) as { state: string }; } finally { db.close(); } };
  return { owner, broker, accepted, task, start, receipt, attempt, command, reservation, revoke: () => { revoked = true; },
    now: () => now, advanceTo: (time: number) => { expect(time).toBeGreaterThan(now);now = time; } };
}

it("retains cessation after real policy blocking has already expired an active attempt before its lease deadline", async () => {
  const f = await fixture(), lease = f.command().lease_until!;
  expect(f.attempt()).toEqual({ state: "active", physical_state: "running" });
  expect(f.now()).toBeLessThan(lease);f.revoke();
  expect(f.owner.heartbeat("worker", f.task.token)).toBe(false);
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("blocked");
  // Source counter-case to the review's proposed ordering: block() itself
  // expires this attempt. It is not left active awaiting the later tick.
  expect(f.attempt()).toEqual({ state: "expired", physical_state: "unknown" });
  expect(f.owner.completeWorkReceipt("worker", f.task.token, f.receipt)).toBe("stale");
  expect(f.attempt().physical_state).toBe("settled");
  f.advanceTo(lease + 1);f.owner.tick();
  expect(f.attempt().physical_state).toBe("settled");
  f.owner.cancel(f.accepted.workflow_id);
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("cancelled");
  expect(f.reservation()).toEqual({ state: "released" });
  expect(f.broker.inspect(f.start.resources.host_reservation!)?.state).toBe("released");
});

it("does not overwrite a ceased stale receipt when lease expiry maintenance runs after receipt delivery", async () => {
  const f = await fixture(), command = f.command(), lease = command.lease_until!;
  expect(lease).toBeLessThan(command.deadline);expect(lease).toBeLessThan(command.attempt_deadline);
  expect(f.attempt()).toEqual({ state: "active", physical_state: "running" });
  // A delayed bound receipt can arrive after lease expiry but before the
  // owner's next maintenance tick. No stored row or authority is rewritten.
  f.advanceTo(lease + 1);
  expect(f.now()).toBeGreaterThan(lease);
  expect(f.attempt()).toEqual({ state: "active", physical_state: "running" });
  expect(f.owner.completeWorkReceipt("worker", f.task.token, f.receipt)).toBe("stale");
  expect(f.attempt().physical_state).toBe("settled");
  expect(f.reservation()).toEqual({ state: "reserved" });
  f.owner.tick();
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("blocked");
  expect(f.attempt()).toEqual({ state: "expired", physical_state: "settled" });
  f.owner.cancel(f.accepted.workflow_id);
  expect(f.owner.get(f.accepted.workflow_id).status).toBe("cancelled");
  expect(f.reservation()).toEqual({ state: "released" });
  expect(f.broker.inspect(f.start.resources.host_reservation!)?.state).toBe("released");
});
