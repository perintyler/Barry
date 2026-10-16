import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WorkflowOwner } from "./workflow-owner.js";
import { ProcessExecutor } from "./executor.js";
import { inspectArtifact } from "./artifacts.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { WorkResourceBroker } from "./work-resource-broker.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { createProcessWorkWorker } from "./work-process-worker.js";
import { connectWorkOwnerV3, dispatchWorkerRequest } from "./protocol.js";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import type { WorkAuthority } from "./work-authority.js";
import { workReceiptDigest } from "./executor-journal.js";
import { executionBindingSchema, logicalStageEffectKey, type WorkSubmission } from "./work-contracts.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import type { Json } from "./types.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(source: string, options: { schema?: Record<string, Json> | null; pure?: boolean; budget?: number; restrictedNetwork?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "work-node-job-")); cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const wrapperPath = join(root, "wrapper.mjs"), jobPath = join(root, "job.mjs"), type = "fixture:job@1";
  writeFileSync(wrapperPath, "export const definitions=[{type:'job',version:'1',*run(input){return yield {kind:'activity',type:input.job,input:input.input,...(input.attemptTimeoutMs?{attemptTimeoutMs:input.attemptTimeoutMs}:{})};}}];");
  writeFileSync(jobPath, source);
  const wrapper = inspectArtifact(wrapperPath, "job", "1"), job = inspectArtifact(jobPath, type, "1", false);
  const artifacts = new WorkArtifactStore(join(root, "artifacts")); cleanup.push(() => artifacts.close());
  const refs = [wrapper, job].map(artifact => artifacts.stage(readFileSync(artifact.path), { purpose: "source", media_type: "text/javascript", owner_identity: null }));
  const scope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], bounds: [{ files: { allow: [] }, nodes: { allow: ["local"] }, ...(options.restrictedNetwork ? { network: { deny: ["example.com"] } } : {}) }], boundByName: async () => undefined });
  const broker = new WorkResourceBroker({ path: join(root, "broker.db"), broker: "host", limits: { local: { kind: "host" } } }); cleanup.push(() => broker.close());
  const schema = options.schema === undefined ? { type: "object" } : options.schema;
  const database = join(root, "owner.db"), owner = new WorkflowOwner({ id: "owner", path: database, artifacts: [wrapper], activityArtifacts: { [type]: job.digest },
    jobs: [{ type, digest: job.digest, nodes: { allow: ["local"] }, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, timeoutMs: options.budget ?? 10000, ...(schema ? { outputSchema: schema } : {}) }],
    executor: new ProcessExecutor(), workArtifacts: artifacts, workResources: { host: () => ({ broker: "host", resource: "local" }), brokers: new Map([["host", broker]]) }, authorizeWork: () => scope });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const request: WorkSubmission = { version: 2, request_id: "815f58b2-ea9a-4eba-8c0e-e2249ea7b837", idempotency_key: "node-job", authority_ref: "trusted-fixture", definition: { kind: "job", reference: type }, inputs: { value: "node-job-result" }, origin: { entry_point: "fixture", trigger: "manual" } };
  const authority: WorkAuthority = { namespace: { installation: "owner", principal_kind: "identity", principal_id: "alice", identity_id: "alice", caller_session_id: null }, origin: request.origin, caller_ceiling: scope, run_identity: "alice" };
  const grant = { version: 2 as const, grant_ref: "job-grant", revision: 1, namespace: authority.namespace, authorizer: "alice", created_by: "alice", approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const resolution = (input: WorkSubmission): WorkResolution => ({ title: "Registered node job", grant, workflow_input: { job: type, input: input.inputs }, plan: {
    version: 2, definition: input.definition, workflow: { type: wrapper.type, version: wrapper.version, artifact_digest: wrapper.digest, runtime_abi: wrapper.abi, input_digest: boundFingerprint(input.inputs) }, source_closure: refs,
    grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable",
    effect_policy: options.pure ? { class: "pure", max_attempts: 1, retry_budget_ms: 60000 } : { class: "non-repeatable", max_attempts: 1 },
    validation: schema ? { mode: "json-schema", schema } : { mode: "none" }, node_job: { activity_type: type, source_digest: job.digest, scope, output: schema ? "json" : "none" },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "assigned-by-owner", host_reservation: null, endpoint: null }, workspace: { kind: "none" },
    selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: options.budget ?? 10000, dispatch_budget_ms: 120000,
  } });
  const service = (resolve = async (input: WorkSubmission) => resolution(input)) => new WorkAdmissionService({ owner, authenticate: async () => authority, resolve });
  const client = connectWorkOwnerV3("owner", input => dispatchWorkerRequest(owner, "owner", input)), errors: unknown[] = [];
  const host = createProcessWorkWorker({ installation: "owner", journalPath: join(root, "executor.db"), artifactRoot: artifacts.root, connections: [{ owner: "owner", client }], advertisement: { types: [type], artifacts: { [type]: job.digest } }, capacity: 1, onError: error => errors.push(error) });
  cleanup.push(() => host.close());
  const binding = () => {
    const db = new SqliteDatabase(join(root, "executor.db"));
    try { return executionBindingSchema.parse(JSON.parse(String(db.prepare("SELECT binding FROM executions LIMIT 1").get()!.binding))); } finally { db.close(); }
  };
  const finish = async (accepted: Awaited<ReturnType<WorkAdmissionService<string>["submit"]>>) => {
    await expect.poll(async () => { await owner.pump(); await host.worker.tick(); return host.journal.receipt(binding()); }, { timeout: 15000 }).not.toBeNull();
    await expect.poll(async () => { await owner.pump(); await host.worker.tick(); return host.journal.pendingDeliveryCount(); }).toBe(0);
    await owner.pump(); return { receipt: host.journal.receipt(binding())!, result: owner.workResult({ kind: "installation", installation: "owner" }, accepted.work_id) };
  };
  return { root, job, owner, scope, broker, artifacts, authority, request, resolution, service, client, host, errors, binding, finish };
}
const echo = 'const input=JSON.parse(process.getBuiltinModule("node:fs").readFileSync(0,"utf8"));process.stdout.write(JSON.stringify({value:input.value,key:process.env.BARRY_JOB_KEY,attempt:process.env.BARRY_JOB_ATTEMPT,credential:process.env.BARRY_SECRET??null}));';
it("node job: executes a raw installed program through owner, journal, declared validation and retained output", async () => {
  const f = await fixture(echo); vi.stubEnv("BARRY_SECRET", "must-not-reach-job"); cleanup.push(() => vi.unstubAllEnvs());
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(receipt).toMatchObject({ outcome: "complete", physical_state: "ceased", validation: "passed" });
  expect(result.outcome).toMatchObject({ ok: true, value: { value: "node-job-result", attempt: "1", credential: null } });
  if (result.outcome?.ok) expect((result.outcome.value as { key: string }).key).toBe(logicalStageEffectKey("owner", f.binding().workflow_id, f.binding().activity_id, "execution"));
  expect(f.host.journal.stageReceipts(f.binding()).map(stage => stage.stage)).toEqual(["execution", "validation"]); expect(f.errors).toEqual([]);
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});
it("node job: required validation retains output without executing the program a second time", async () => {
  let effects = 0; const server = createServer((_request, response) => { effects++; response.end(JSON.stringify({ received: true })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const f = await fixture(`const value=await (await fetch('http://127.0.0.1:${(server.address() as { port: number }).port}',{method:'POST'})).json();process.stdout.write(JSON.stringify(value));`, { schema: { type: "number" } });
  const complete = f.client.complete.bind(f.client);
  vi.spyOn(f.client, "complete").mockImplementationOnce(async (token, receipt) => { await complete(token, receipt); throw new Error("receipt reply lost"); });
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(effects).toBe(1); expect(receipt).toMatchObject({ outcome: "failed", validation: "failed", physical_state: "ceased" });
  expect(result.retained_output?.value).toEqual({ received: true }); expect(result.outcome?.ok).toBe(false);
  expect(f.errors.some(error => String(error).includes("receipt reply lost"))).toBe(true);
});
it.each(["process.getBuiltinModule('node:fs').readFileSync('/etc/hosts')", "process.getBuiltinModule('node:child_process').spawnSync(process.execPath,['-e','0'])"])("node job: permission model denies escape %s and retains genuine cessation", async expression => {
  const f = await fixture(`${expression};process.stdout.write('{}');`), accepted = await f.service().submit(f.request, "alice"), { receipt } = await f.finish(accepted);
  expect(receipt).toMatchObject({ outcome: "uncertain", physical_state: "ceased", effect_certainty: "uncertain" }); expect(receipt.summary).toMatch(/ERR_ACCESS_DENIED|denied|restricted/);
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});
it("node job: stdout without an output declaration keeps the legacy null result", async () => {
  const f = await fixture("process.stdout.write('ordinary job log');", { schema: null }), accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: null });
});
it("node job: bounded stderr tail preserves the legacy log volume contract", async () => {
  const f = await fixture("process.stderr.write('log'.repeat(30000));process.stdout.write('{}');"), accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} });
});
it("node job: invalid raw JSON remains retained with genuine physical settlement", async () => {
  const f = await fixture("process.stdout.write('not-json');"), accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(receipt).toMatchObject({ physical_state: "ceased", outcome: "uncertain" });
  expect(f.artifacts.verify(receipt.output!).toString()).toBe("not-json"); expect(result.retained_output?.invalid_reason).toMatch(/JSON/);
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});
it("node job: oversized raw stdout is bounded and cannot strand stopped capacity", async () => {
  const f = await fixture("process.stdout.write(JSON.stringify('x'.repeat(300000)));"), accepted = await f.service().submit(f.request, "alice"), { receipt } = await f.finish(accepted);
  expect(receipt.physical_state).toBe("ceased"); expect(receipt.outcome).toBe("uncertain");
  expect(receipt.failure?.code).toBe("ResultTooLarge");
  if (receipt.output) expect(f.artifacts.verify(receipt.output).length).toBeLessThanOrEqual(262144);
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});
it("node job: an original deadline stops a non-repeatable native loop and retains uncertainty", async () => {
  const f = await fixture("while(true){}", { budget: 750 }), accepted = await f.service().submit(f.request, "alice"), { receipt } = await f.finish(accepted);
  expect(receipt).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});
it("node job: a module-only worker is skipped before any raw source import", async () => {
  const f = await fixture(echo), accepted = await f.service().submit(f.request, "alice"); await f.owner.pump();
  await f.client.advertise({ types: [f.job.type], artifacts: { [f.job.type]: f.job.digest }, capacity: 1 }, {
    version: 2, installation: "owner", boot_identity: "old-module-worker", observed_at: Date.now(), expires_at: Date.now() + 15000, executors: ["process"],
    features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "declared-validation", "bounded-retries"], runtimes: {}, workspaces: [], containment: "portable", requires_validation_declaration: true,
  });
  expect(await f.client.claim("old-worker-claim")).toBeNull();
  const db = new SqliteDatabase(join(f.root, "owner.db")); try { expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(0); } finally { db.close(); }
  expect(f.owner.get(accepted.workflow_id).status).toBe("running");
});
it("node job: changing the installed path after acceptance cannot replace retained code", async () => {
  const f = await fixture(echo), accepted = await f.service().submit(f.request, "alice"); writeFileSync(f.job.path, "process.stdout.write(JSON.stringify({mutated:true}));");
  const { result } = await f.finish(accepted); expect(result.outcome).toMatchObject({ ok: true, value: { value: "node-job-result" } });
});
it("node job: unsupported or widened declarations refuse before admission", async () => {
  const f = await fixture(echo);
  for (const change of ["files", "scope", "source"] as const) {
    const service = f.service(async request => { const resolution = f.resolution(request), declaration = resolution.plan.node_job!;
      return { ...resolution, plan: { ...resolution.plan, node_job: { ...declaration,
        ...(change === "files" ? { scope: { ...declaration.scope, bound: null } } : change === "scope" ? { scope: { ...declaration.scope, identity: "other" } } : { source_digest: "0".repeat(64) }) } } }; });
    await expect(service.submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedNodeJob" });
  }
  expect(f.owner.listWork({ kind: "installation", installation: "owner" }, {}).total).toBe(0);
});
it("node job: missing declarations and changed output contracts cannot fall back to module execution", async () => {
  const f = await fixture(echo);
  for (const change of ["missing", "validation", "output"] as const) {
    const service = f.service(async request => {
      const resolution = f.resolution(request), plan = resolution.plan;
      if (change === "missing") { delete plan.node_job; return { ...resolution, plan }; }
      return { ...resolution, plan: { ...plan, ...(change === "validation" ? { validation: { mode: "none" as const } } : { node_job: { ...plan.node_job!, output: "none" as const } }) } };
    });
    await expect(service.submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedNodeJob" });
  }
});
it("node job: a real narrower network ceiling refuses before admission rather than granting all network", async () => {
  const f = await fixture(echo, { restrictedNetwork: true });
  await expect(f.service().submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedNodeJob" });
  expect(f.owner.listWork({ kind: "installation", installation: "owner" }, {}).total).toBe(0);
});
it("node job: registered input and execution-time contracts are enforced before acceptance", async () => {
  const f = await fixture(echo);
  await expect(f.service().submit({ ...f.request, inputs: { value: 42 } }, "alice")).rejects.toMatchObject({ code: "InvalidInput" });
  const widened = f.service(async request => { const resolution = f.resolution(request); return { ...resolution, plan: { ...resolution.plan, execution_budget_ms: 10001 } }; });
  await expect(widened.submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedNodeJob" });
  const changed = f.service(async request => ({ ...f.resolution(request), workflow_input: { job: f.job.type, input: { value: "changed after authorization" } } }));
  await expect(changed.submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedNodeJob" });
  expect(f.owner.listWork({ kind: "installation", installation: "owner" }, {}).total).toBe(0);
});

it("node job: bounded ordinary stdout and stderr survive lost delivery and coordinated backup", async () => {
  const f = await fixture("process.stdout.write('<img src=x onerror=alert(1)>'.repeat(2000));process.stderr.write('old'.repeat(30000)+'final diagnostic');", { schema: null });
  const complete = f.client.complete.bind(f.client);
  vi.spyOn(f.client, "complete").mockImplementationOnce(async (token, receipt) => { await complete(token, receipt); throw new Error("log receipt reply lost"); });
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: null }); expect(result.logs).toHaveLength(1);
  const log = result.logs![0]!;
  expect(log).toMatchObject({ stage: "execution", reference: { purpose: "log", owner_identity: "alice" }, invalid_reason: null,
    value: { stdout_bytes: 56000, stderr_bytes: 90016, stdout_truncated: true, stderr_truncated: true } });
  expect(log.value!.stdout.length).toBe(16384); expect(log.value!.stderr.length).toBe(4096); expect(log.value!.stderr).toMatch(/final diagnostic$/);
  expect(receipt.stages[0]!.logs).toEqual(log.reference);
  expect(f.host.journal.retainedStageOutput(f.binding(), "execution", "log")).toEqual(log.reference);
  expect(() => f.owner.workResult({ kind: "identity", installation: "owner", identity_id: "other" }, accepted.work_id)).toThrow(/unavailable/);
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const snapshot = join(f.root, "snapshot"), destination = join(f.root, "restored");
  const manifest = await snapshotWorkflows(join(f.root, "owner.db"), snapshot, "owner", [inspectArtifact(join(f.root, "wrapper.mjs"), "job", "1"), f.job], f.artifacts.root, {
    version: 1, components: [
      { id: "executor", role: "executor", identity: "owner", path: join(f.root, "executor.db"), workers: ["owner"], artifact_root: f.artifacts.root },
      { id: "broker", role: "broker", identity: "host", path: join(f.root, "broker.db") },
    ],
  });
  expect(manifest.workRecovery).toBeDefined(); await restoreWorkflows(snapshot, destination, "owner", true, true);
  const restored = new WorkArtifactStore(join(destination, "work-artifacts")); cleanup.push(() => restored.close());
  expect(JSON.parse(restored.verify(log.reference).toString())).toEqual(log.value);
  expect(f.errors.filter(error => !String(error).includes("log receipt reply lost"))).toEqual([]);
});
it("node job: failed validation preserves stderr separately from retained output", async () => {
  const f = await fixture("process.stderr.write('retained failure details');process.stdout.write('{}');", { schema: { type: "number" } });
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(receipt).toMatchObject({ physical_state: "ceased", validation: "failed", outcome: "failed" });
  expect(result.logs?.[0]?.value?.stderr).toBe("retained failure details"); expect(result.retained_output?.value).toEqual({});
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});
it("node job: workers without log negotiation retain their existing receipt shape", async () => {
  const f = await fixture("process.stderr.write('old host log');process.stdout.write('{}');");
  const advertise = f.client.advertise.bind(f.client);
  vi.spyOn(f.client, "advertise").mockImplementation((advertisement, features) => advertise(advertisement, features && { ...features, features: features.features.filter(value => value !== "stage-logs") }));
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(f.host.journal.retainedStart(f.binding())).not.toHaveProperty("capture_logs");
  expect(receipt.stages.every(stage => !stage.logs)).toBe(true); expect(result).not.toHaveProperty("logs");
  expect(result.outcome).toEqual({ ok: true, value: {} });
});

it("node job: malformed digest-valid logs cannot prevent proven cessation settlement", async () => {
  const f = await fixture("process.stderr.write('valid native log');process.stdout.write('{}');");
  const invalid = f.artifacts.stage(Buffer.from('not-json'), { purpose: "log", media_type: "application/json", owner_identity: "alice" });
  const complete = f.client.complete.bind(f.client);
  vi.spyOn(f.client, "complete").mockImplementation((token, receipt) => {
    const { receipt_digest: _digest, ...unsigned } = receipt;
    const rewritten = { ...unsigned, stages: unsigned.stages.map(stage => stage.stage === "execution" ? { ...stage, logs: invalid } : stage) };
    return complete(token, { ...rewritten, receipt_digest: workReceiptDigest(rewritten) });
  });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} });
  expect(result.logs?.[0]).toMatchObject({ reference: invalid, value: null, invalid_reason: expect.stringMatching(/valid bounded log/) });
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});

it("node job: undeclared output ignores binary stdout while retaining bounded logs", async () => {
  const f = await fixture("process.stdout.write(Buffer.from([255,254,253]));", { schema: null });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: null }); expect(result.logs?.[0]?.value?.stdout_bytes).toBe(3);
});
