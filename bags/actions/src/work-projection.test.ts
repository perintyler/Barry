import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { WorkflowOwner, ProcessExecutor, WorkArtifactStore, WorkAdmissionService, inspectArtifact, workPlanHash,
  snapshotWorkflows, restoreWorkflows, type WorkAdmission, type WorkResolution, type WorkSubmission, type WorkResult } from "@barry-rocks/sdk/internal/workflows";
import { ActionRuns, abandonActionRuns, listStartedActionRunsWithSession } from "./action-runs.js";
import { setDb, getDb, closeDb } from "./db.js";
import { completeAction, cancelAction, checkActionRun } from "./tools.js";
import { createActionWorkProjection, prepareActionWorkProjectionGeneration } from "./work-projection.js";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); closeDb(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "actions-work-projection-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "fixture.mjs"); writeFileSync(path, "export const definitions=[{type:'projection',version:'1',*run(input){return input;}}];");
  const workflow = inspectArtifact(path, "projection", "1"), artifacts = new WorkArtifactStore(join(root, "artifacts")); cleanup.push(() => artifacts.close());
  const source = artifacts.stage(readFileSync(path), { purpose: "source", media_type: "text/javascript", owner_identity: null });
  const scope = await approveWorkflowBounds({ identity: "alice", bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const namespace = { installation: "owner", principal_kind: "identity" as const, principal_id: "alice", identity_id: "alice", caller_session_id: "session" };
  const owner = new WorkflowOwner({ id: "owner", path: join(root, "owner.db"), artifacts: [workflow], executor: new ProcessExecutor(), workArtifacts: artifacts, authorizeWork: () => scope });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const request: WorkSubmission = { version: 2, request_id: randomUUID(), idempotency_key: "logical-action", authority_ref: "fixture", definition: { kind: "action", reference: "fixture:report", catalog_namespace: "fixture" }, inputs: { report: "retained output" }, origin: { entry_point: "work-cli", trigger: "manual", caller_session_id: "session" } };
  const authority = { namespace, caller_ceiling: scope, origin: request.origin, run_identity: "alice" };
  const grant = { version: 2 as const, grant_ref: "fixture", revision: 1, namespace, authorizer: "alice", created_by: "alice", approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const service = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async (input): Promise<WorkResolution> => ({ title: "Report", grant, workflow_input: input.inputs, plan: {
    version: 2, definition: input.definition, workflow: { type: workflow.type, version: workflow.version, artifact_digest: workflow.digest, runtime_abi: workflow.abi, input_digest: boundFingerprint(input.inputs) }, source_closure: [source], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant),
    executor_generation: "work-v2", execution_profile: "portable", effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 10000 }, validation: { mode: "json-schema", schema: { type: "object" } },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner", host_reservation: null, endpoint: null }, workspace: { kind: "none" },
    selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: 10000, dispatch_budget_ms: 10000,
  } }) });
  const database = new Database(join(root, "actions.db")); setDb(database);
  const result = vi.fn((work: WorkAdmission) => owner.workResult({ kind: "namespace", namespace }, work.work_id));
  const target = createActionWorkProjection({ database, namespace, result });
  const work = await service.submit(request, "alice");
  return { root, workflow, artifacts, owner, database, namespace, result, target, work, service, request };
}
it("projects one owner-generated action identity through a lost acknowledgement, stale revisions and terminal replay", async () => {
  const f = await fixture();
  expect(f.work.action_id).toMatch(/^arn_/);
  expect(f.database.pragma("synchronous", { simple: true })).toBe(2);
  await expect(f.owner.publishWorkProjections({ apply: async work => { await f.target.apply(work); throw new Error("lost projection acknowledgement"); } })).rejects.toThrow("lost projection acknowledgement");
  expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ id: f.work.action_id, status: "started", session_id: "session", trigger: "cli", workflow: { work_id: f.work.work_id, state: "queued" } });
  expect(await f.owner.publishWorkProjections(f.target)).toBe(1);
  expect((await ActionRuns.list()).map(run => run.id)).toEqual([f.work.action_id]);
  expect((await f.service.submit(f.request, "alice")).action_id).toBe(f.work.action_id);
  await expect.poll(async () => { await f.owner.pump(); return f.owner.workById(f.namespace, f.work.work_id)?.facts.coordinator; }, { timeout: 10000 }).toBe("completed");
  await f.owner.publishWorkProjections(f.target);
  const closed = await ActionRuns.get(f.work.action_id!);
  expect(closed).toMatchObject({ status: "complete", action: "fixture:report", bag: "fixture", output: '{"report":"retained output"}', workflow: { state: "completed", result: { closed_at: expect.any(Number) } } });
  const current = f.owner.workById(f.namespace, f.work.work_id)!;
  expect(closed?.completed_at?.getTime()).toBe(f.owner.workResult({ kind: "namespace", namespace: f.namespace }, f.work.work_id).closed_at);
  await f.target.apply(f.work); await f.target.apply(current);
  expect(await ActionRuns.get(f.work.action_id!)).toEqual(closed);
  f.database.close(); const reopened = new Database(f.database.name); setDb(reopened);
  const target = createActionWorkProjection({ database: reopened, namespace: f.namespace, result: () => { throw new Error("must reuse retained projection"); } });
  await target.apply(current); expect(await ActionRuns.get(f.work.action_id!)).toEqual(closed);
});
it("refuses legacy completion, cancellation, failure, sweeping and pruning of workflow-owned rows", async () => {
  const f = await fixture(); await f.target.apply(f.work);
  const id = f.work.action_id!;
  expect(await ActionRuns.complete(id, "fake result")).toBeNull();
  expect(await ActionRuns.cancel(id, "false cessation")).toBeNull();
  expect(await ActionRuns.fail(id, "agent lost")).toBeNull();
  expect(await ActionRuns.finishExecuted(id, { status: "complete", summary: "fake process", process: { exit_code: 0, duration_ms: 0, log_path: null } })).toBeNull();
  expect(await abandonActionRuns([id])).toEqual([]); expect(await listStartedActionRunsWithSession()).toEqual([]); expect(await ActionRuns.listStartedByTrigger("cli")).toEqual([]);
  expect((await ActionRuns.get(id))?.status).toBe("started");
  const legacy = await ActionRuns.create({ action: "fixture:legacy", bag: "fixture", trigger: "cli" }); expect(await ActionRuns.cancel(legacy.id, "legacy cancellation")).not.toBeNull();
  await f.owner.pump(); await f.owner.publishWorkProjections(f.target);
  const before = new Date(Date.now() + 10000);
  expect(await ActionRuns.pruneClosed({ trigger: "cli", before, failedBefore: before })).toBe(1);
  expect(await ActionRuns.get(id)).not.toBeNull();
});
it("guards identity databases, immutable bindings, conflicting revisions and legacy ID collisions", async () => {
  const f = await fixture(); await f.target.apply(f.work);
  await expect(f.target.apply({ ...f.work, namespace: { ...f.namespace, identity_id: "bob", principal_id: "bob" } })).rejects.toThrow();
  await expect(f.target.apply({ ...f.work, title: "different facts" })).rejects.toThrow("Same action revision");
  await expect(f.target.apply({ ...f.work, revision: f.work.revision + 1, workflow_id: "other" })).rejects.toThrow("binding cannot change");
  const legacy = await ActionRuns.create({ action: "fixture:legacy", bag: "fixture" });
  await expect(f.target.apply({ ...f.work, action_id: legacy.id, work_id: "other-work", workflow_id: "other-run" })).rejects.toThrow("legacy action run");
  const bob = createActionWorkProjection({ database: getDb(), namespace: { ...f.namespace, identity_id: "bob", principal_id: "bob" }, result: f.result });
  await expect(bob.apply({ ...f.work, namespace: { ...f.namespace, identity_id: "bob", principal_id: "bob" } })).rejects.toThrow();
});
it("keeps stopping and uncertain work open and retains advisory check reports", async () => {
  const f = await fixture(); await f.target.apply(f.work);
  const stopping = { ...f.work, revision: 2, facts: { ...f.work.facts, phase: "executing" as const, physical: "running" as const, effect: "uncertain" as const, stop_requested: true } };
  await f.target.apply(stopping); expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", completed_at: null, workflow: { state: "stopping" } });
  const uncertain = { ...stopping, revision: 3, facts: { ...stopping.facts, coordinator: "blocked" as const, stop_requested: false } };
  await f.target.apply(uncertain); expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", completed_at: null, workflow: { state: "needs-attention" } });
  const terminal = { ...f.work, revision: 4, facts: { ...f.work.facts, coordinator: "completed" as const, phase: "terminal" as const, physical: "ceased" as const, effect: "known" as const, has_result: true } };
  const report: WorkResult = { version: 2, work_id: f.work.work_id, revision: 4, status: "available", receipt_ref: null, closed_at: Date.now(), outcome: { ok: true, value: { delivered: true } }, retained_output: null,
    action_checks: { postcondition: { passed: false, unknown: false, detail: "missing report", failures: ["expected file not found: report"] } } };
  const target = createActionWorkProjection({ database: f.database, namespace: f.namespace, result: () => report });
  await target.apply(terminal);
  expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "failed", validation_failures: ["expected file not found: report"], output: '{"delivered":true}', workflow: { state: "completed", result: { action_checks: report.action_checks } } });
});

it("rolls back the compatibility row and owner binding when projection persistence fails", async () => {
  const f = await fixture();
  f.database.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON action_work_projections BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END");
  await expect(f.target.apply(f.work)).rejects.toThrow("fixture projection failure");
  expect(await ActionRuns.get(f.work.action_id!)).toBeNull();
  expect(f.database.prepare("SELECT count(*) n FROM action_work_projection_owner").get()).toEqual({ n: 0 });
  f.database.exec("DROP TRIGGER fail_projection"); await f.target.apply(f.work);
  expect((await ActionRuns.get(f.work.action_id!))?.id).toBe(f.work.action_id);
});
it("refuses a mismatched result revision and never invents a coordinator closure time", async () => {
  const f = await fixture(); await f.owner.pump();
  const work = f.owner.workById(f.namespace, f.work.work_id)!;
  const result = f.owner.workResult({ kind: "namespace", namespace: f.namespace }, work.work_id);
  const bad = createActionWorkProjection({ database: f.database, namespace: f.namespace, result: () => ({ ...result, revision: result.revision + 1 }) });
  await expect(bad.apply(work)).rejects.toThrow("Result snapshot does not match"); expect(await ActionRuns.get(work.action_id!)).toBeNull();
  const missing = createActionWorkProjection({ database: f.database, namespace: f.namespace, result: () => ({ ...result, closed_at: null }) });
  await expect(missing.apply(work)).rejects.toThrow("canonical closure timestamp");
});
it("acknowledges generic work without creating synthetic action history", async () => {
  const f = await fixture();
  const plan = { ...f.work.plan, definition: { kind: "workflow" as const, reference: "projection", version: "1" } };
  await f.target.apply({ ...f.work, plan, plan_digest: workPlanHash(plan), action_id: null });
  expect(await ActionRuns.list()).toEqual([]); expect(f.result).not.toHaveBeenCalled();
});

it("legacy tool boundaries expose workflow ownership before file reads, validation or agent stop", async () => {
  const f = await fixture(); await f.target.apply(f.work); const run_id = f.work.action_id!;
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    await expect(completeAction.handler({ run_id, summary: "fake", output_file: "/missing/must-not-read" }, undefined)).rejects.toThrow("owned by workflow");
    await expect(cancelAction.handler({ run_id, reason: "stop" }, undefined)).rejects.toThrow("request Stop through Work");
    expect(fetch).not.toHaveBeenCalled();
    expect(await checkActionRun.handler({ run_id }, undefined)).toMatchObject({ run_id, workflow: { work_id: f.work.work_id, state: "queued" } });
  } finally { fetch.mockRestore(); }
});
it("an asynchronously delayed older result cannot overwrite a newer projected revision", async () => {
  const f = await fixture(); await f.target.apply(f.work);
  const closed = { ...f.work, revision: 2, facts: { ...f.work.facts, coordinator: "completed" as const, phase: "terminal" as const, physical: "ceased" as const, effect: "known" as const, has_result: true } };
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const target = createActionWorkProjection({ database: f.database, namespace: f.namespace, result: async work => {
    if (work.revision === 2) { entered(); await gate; }
    return { version: 2, work_id: work.work_id, revision: work.revision, status: "available", receipt_ref: null, closed_at: Date.now(), outcome: { ok: true, value: work.revision }, retained_output: null };
  } });
  const older = target.apply(closed); await ready;
  try {
    await target.apply({ ...closed, revision: 3 });
    release(); await older;
    expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ output: "3", workflow: { revision: 3 } });
  } finally { release(); }
});
it("shares an identity-owned projection database across distinct caller sessions", async () => {
  const f = await fixture(); await f.target.apply(f.work);
  const namespace = { ...f.namespace, caller_session_id: "other-session" };
  const target = createActionWorkProjection({ database: f.database, namespace, result: f.result });
  await target.apply({ ...f.work, namespace, origin: { ...f.work.origin, caller_session_id: "other-session" }, action_id: "arn_other", work_id: "work-other", workflow_id: "workflow-other" });
  expect((await ActionRuns.list()).map(run => run.session_id).sort()).toEqual(["other-session", "session"]);
});

it("fences old generations and rebuilds a newer target from an older restored canonical view", async () => {
  const f = await fixture(); await f.owner.pump(); const closed = f.owner.workById(f.namespace, f.work.work_id)!;
  const result = f.owner.workResult({ kind: "namespace", namespace: f.namespace }, closed.work_id);
  const old = createActionWorkProjection({ database: f.database, namespace: f.namespace, result: work => ({ ...result, revision: work.revision }) });
  await old.apply({ ...closed, revision: closed.revision + 20 });
  expect((await ActionRuns.get(f.work.action_id!))?.status).toBe("complete");
  prepareActionWorkProjectionGeneration({ database: f.database, namespace: f.namespace, generation: "restored-owner" });
  expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", completed_at: null, output: null, workflow: { projection_current: false, state: "needs-attention", facts: null, result: null } });
  expect(await ActionRuns.list({ active: false })).toEqual([]); expect(await ActionRuns.list({ status: "complete" })).toEqual([]);
  expect(await ActionRuns.list({ active: true })).toHaveLength(1); expect(await ActionRuns.list({ status: "started" })).toHaveLength(1);
  await expect(old.apply(closed)).rejects.toThrow("generation is obsolete");
  expect(() => prepareActionWorkProjectionGeneration({ database: f.database, namespace: f.namespace, generation: "initial" })).toThrow("cannot be reactivated");
  const restored = createActionWorkProjection({ database: f.database, namespace: f.namespace, generation: "restored-owner", result: f.result });
  await restored.apply(f.work);
  expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", workflow: { projection_current: true, revision: 1, state: "queued" } });
});
it("requeues bounded publication metadata without changing work revisions or evaluating work again", async () => {
  const f = await fixture(); await f.owner.publishWorkProjections(f.target);
  expect(f.owner.workById(f.namespace, f.work.work_id)?.projection.applied_revision).toBe(1);
  expect(() => f.owner.requeueWorkProjections("obsolete-owner")).toThrow("epoch");
  expect(f.owner.requeueWorkProjections(f.owner.epoch, "", 1)).toEqual({ after: f.work.workflow_id, complete: false });
  expect(f.owner.workById(f.namespace, f.work.work_id)).toMatchObject({ revision: 1, projection: { applied_revision: 0 } });
  expect(f.owner.requeueWorkProjections(f.owner.epoch, f.work.workflow_id, 1)).toEqual({ after: f.work.workflow_id, complete: true });
  expect(await f.owner.publishWorkProjections(f.target)).toBe(1);
});

it("an in-flight obsolete target cannot commit after generation preparation", async () => {
  const f = await fixture(); await f.target.apply(f.work); await f.owner.pump();
  const closed = f.owner.workById(f.namespace, f.work.work_id)!;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(done => { entered = done; }), gate = new Promise<void>(done => { release = done; });
  const old = createActionWorkProjection({ database: f.database, namespace: f.namespace, result: async work => { entered(); await gate; return f.result(work); } });
  const pending = old.apply(closed); await ready;
  try {
    prepareActionWorkProjectionGeneration({ database: f.database, namespace: f.namespace, generation: "new-owner-generation" });
    release(); await expect(pending).rejects.toThrow("generation is obsolete");
    expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", workflow: { projection_current: false } });
  } finally { release(); }
});

it("restores an older owner snapshot beside newer Actions history without presenting the old completion as current", async () => {
  const f = await fixture(), oldEpoch = f.owner.epoch;
  prepareActionWorkProjectionGeneration({ database: f.database, namespace: f.namespace, generation: oldEpoch });
  const old = createActionWorkProjection({ database: f.database, namespace: f.namespace, generation: oldEpoch, result: f.result });
  const snapshot = join(f.root, "snapshot"), destination = join(f.root, "restored");
  await snapshotWorkflows(join(f.root, "owner.db"), snapshot, "owner", [f.workflow], f.artifacts.root);
  await f.owner.pump(); const closed = f.owner.workById(f.namespace, f.work.work_id)!;
  await old.apply(closed); expect((await ActionRuns.get(f.work.action_id!))?.status).toBe("complete");
  await f.owner.drain(); f.owner.close();
  await restoreWorkflows(snapshot, destination, "owner", true);
  const artifacts = new WorkArtifactStore(join(destination, "work-artifacts")); cleanup.push(() => artifacts.close());
  const owner = new WorkflowOwner({ id: "owner", path: join(destination, "workflows.db"), executor: new ProcessExecutor(), workArtifacts: artifacts,
    artifacts: [{ ...f.workflow, path: join(destination, `${f.workflow.digest}.mjs`) }], authorizeWork: () => null });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  expect(owner.epoch).not.toBe(oldEpoch); expect(owner.get(f.work.workflow_id).status).toBe("blocked");
  prepareActionWorkProjectionGeneration({ database: f.database, namespace: f.namespace, generation: owner.epoch });
  expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", output: null, workflow: { projection_current: false, state: "needs-attention" } });
  owner.requeueWorkProjections(owner.epoch);
  await owner.publishWorkProjections(createActionWorkProjection({ database: f.database, namespace: f.namespace, generation: owner.epoch,
    result: work => owner.workResult({ kind: "namespace", namespace: f.namespace }, work.work_id) }));
  expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", output: null, workflow: { projection_current: true, state: "needs-attention", facts: { coordinator: "blocked" } } });
  await expect(old.apply(closed)).rejects.toThrow("generation is obsolete");
  expect(f.database.prepare("SELECT count(*) n FROM action_work_projection_history WHERE action_id=? AND generation=?").get(f.work.action_id, oldEpoch)).toEqual({ n: 1 });
});

it("reads compatibility fields and workflow facts from one snapshot while another connection rebuilds", async () => {
  const f = await fixture(); await f.owner.pump(); const closed = f.owner.workById(f.namespace, f.work.work_id)!;
  await f.target.apply(closed);
  const writer = new Database(f.database.name); let changed = false;
  const target = createActionWorkProjection({ database: writer, namespace: f.namespace, generation: "reader-race", result: f.result });
  const prepare = f.database.prepare.bind(f.database);
  const spy = vi.spyOn(f.database, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql === "SELECT * FROM action_runs WHERE id = ?") {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...args) => {
        const value = get(...args);
        if (!changed) {
          changed = true;
          prepareActionWorkProjectionGeneration({ database: writer, namespace: f.namespace, generation: "reader-race" });
          void target.apply(f.work);
        }
        return value;
      });
    }
    return statement;
  });
  try {
    expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "complete", workflow: { state: "completed" } });
    expect(await ActionRuns.get(f.work.action_id!)).toMatchObject({ status: "started", output: null, workflow: { state: "queued" } });
  } finally { spy.mockRestore(); writer.close(); }
});
