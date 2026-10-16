import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { SqliteDatabase } from "@barry-rocks/sdk/internal/stores";
import { WorkAdmissionService, WorkArtifactStore, WorkResourceBroker, WorkflowOwner, ProcessExecutor, ExecutorJournal,
  WorkProcessSupervisor, WorkReadService, WorkControlService, inspectArtifact, executionBindingSchema, type WorkAuthority } from "@barry-rocks/sdk/internal/workflows";
import { createWorkflowServer } from "../src/server.js";

/** Fault fixture: actual isolated execution/receipt; lease expiry before owner delivery. */
export async function recoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), "work-recovery-browser-"));
  const artifact = inspectArtifact(fileURLToPath(new URL("../../../sdk/src/workflows/execution-fixture.mjs", import.meta.url)), "echo", "1");
  const artifacts = new WorkArtifactStore(join(root, "artifacts")), source = artifacts.stage(readFileSync(artifact.path), { owner_identity: null, purpose: "source", media_type: "text/javascript" });
  const broker = new WorkResourceBroker({ path: join(root, "broker.db"), broker: "owner", limits: { local: { kind: "host" } } });
  const scope = await approveWorkflowBounds({ bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const ownerOptions = { id: "owner", path: join(root, "owner.db"), artifacts: [artifact], activityArtifacts: { echo: artifact.digest },
    workArtifacts: artifacts, workResources: { brokers: new Map([[broker.id, broker]]), host: () => ({ broker: "owner", resource: "local" }) }, authorizeWork: () => scope };
  let owner = new WorkflowOwner({ ...ownerOptions, executor: new ProcessExecutor() });
  const journal = new ExecutorJournal({ path: join(root, "executor.db"), installation: "owner", artifacts });
  const errors: unknown[] = [];
  const supervisor = new WorkProcessSupervisor({ installation: "owner", journal, artifacts, executor: new ProcessExecutor(), outputIdentity: () => null,
    authorize: async start => owner.assertWorkEffect("owner", start.attempt_id) ? owner.beginWork("owner", start.attempt_id) : null, onError: error => errors.push(error) });
  let server: ReturnType<typeof createWorkflowServer>, timer: ReturnType<typeof setInterval>, url = "";
  const pumps = new Set<Promise<unknown>>();
  async function listen() {
    const authority = { actor: "local-operator", scope: { kind: "installation" as const, installation: "owner" }, controls: ["inspect", "result", "stop", "reconcile"] as const };
    server = createWorkflowServer({ owner, secret: "recovery-browser-secret", authenticateWorker: () => null,
      workReads: new WorkReadService({ owner, authorize: async () => authority }), workControls: new WorkControlService({ owner, authorize: async () => authority }) });
    await new Promise<void>(resolve => server.listen(url ? Number(new URL(url).port) : 0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    timer = setInterval(() => { const pump = owner.pump().catch(error => errors.push(error)); pumps.add(pump); void pump.finally(() => pumps.delete(pump)); }, 50);
  }
  async function stopServer() { clearInterval(timer); await Promise.all(pumps); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
  await listen();
  return {
    get url() { return url; }, get owner() { return owner; }, journal, errors,
    async late(message: string) {
      const authority: WorkAuthority = { namespace: { installation: "owner", principal_kind: "operator", principal_id: "local-operator", identity_id: null, caller_session_id: null },
        run_identity: null, origin: { entry_point: "browser-recovery-fixture", trigger: "manual" }, caller_ceiling: scope };
      const service = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async request => {
        const grant = { version: 2 as const, grant_ref: randomUUID(), revision: 1, namespace: authority.namespace, authorizer: "local-operator", created_by: "local-operator", approved_at: Date.now(),
          original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
        return { grant, title: "Recovery task", workflow_input: message, plan: { version: 2, definition: request.definition,
          workflow: { type: "echo", version: "1", artifact_digest: artifact.digest, runtime_abi: artifact.abi, input_digest: boundFingerprint(message) },
          source_closure: [source], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable",
          effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 30000 }, validation: { mode: "none" }, resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: null },
          workspace: { kind: "none" }, selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: 60000, dispatch_budget_ms: 120000 } };
      } });
      const work = await service.submit({ version: 2, request_id: randomUUID(), idempotency_key: randomUUID(), authority_ref: "fixture-original-authority", definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: message, origin: authority.origin }, null);
      await owner.pump();
      owner.advertiseWork("owner", { types: ["echo"], artifacts: { echo: artifact.digest }, capacity: 1 }, { version: 2, installation: "owner", boot_identity: supervisor.bootIdentity,
        observed_at: Date.now() - 1, expires_at: Date.now() + 15000, executors: ["process"], features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "declared-validation"],
        runtimes: {}, workspaces: [], containment: "portable" });
      let task = owner.claimWork("owner", randomUUID());
      for (let turn = 0; !task && turn < 4; turn++) { await owner.pump(); task = owner.claimWork("owner", randomUUID()); }
      if (!task) throw new Error(`Fixture admission was not claimable: ${owner.get(work.workflow_id).status}`);
      task.work = owner.beginWork("owner", task.token); task.deadline = task.work.deadline;
      const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, task.work![key as keyof typeof task.work]])));
      await supervisor.start(task); const receipt = await supervisor.wait(binding); if (!receipt) throw new Error("Fixture did not retain a receipt");
      const db = new SqliteDatabase(join(root, "owner.db"));
      try {
        db.prepare("UPDATE workflow_commands SET lease_until=0 WHERE id=?").run(task.activityId);
        // Fault injection must wake the durable due index as a real lease expiry would.
        db.prepare("UPDATE workflow_due SET due_at=0 WHERE run_id=?").run(work.workflow_id);
      } finally { db.close(); }
      owner.tick(); if (owner.completeWorkReceipt("owner", task.token, receipt) !== "stale") throw new Error("Fixture receipt was not late");
      return { workId: work.work_id, workflowId: work.workflow_id, binding, receipt };
    },
    async restart() { await owner.pump(); await stopServer(); await owner.drain(); owner.close(); owner = new WorkflowOwner({ ...ownerOptions, executor: new ProcessExecutor() }); await listen(); },
    async close() { await stopServer(); await supervisor.close(); journal.close(); await owner.drain(); owner.close(); broker.close(); artifacts.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
