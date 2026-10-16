/** Proposed finite F2 native regression; source authored, not yet executed.
 * Real Work admission, worker, supervisor, executor journal and host broker.
 * Only the authentication/catalog callbacks are trusted fixture composition.
 * Neither receipts nor native-cessation probes are mocked or constructed here.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { inspectArtifact } from "./artifacts.js";
import { ProcessExecutor } from "./executor.js";
import { connectWorkOwnerV3, dispatchWorkerRequest } from "./protocol.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import type { WorkAuthority } from "./work-authority.js";
import { executionBindingSchema, type WorkSubmission } from "./work-contracts.js";
import { prepareProcessProgram } from "./work-process-program.js";
import { processBootIdentity } from "./work-process-supervisor.js";
import { createProcessWorkWorker } from "./work-process-worker.js";
import { WorkResourceBroker } from "./work-resource-broker.js";
import { WorkflowOwner } from "./workflow-owner.js";

// Fixed before qualification: no timeout tuning after observations.
const CHILD_LIFETIME_MS = 15000, READY_WAIT_MS = 5000, OBSERVATION_MS = 20000, CLEANUP_WAIT_MS = 25000;
type NativeIdentity = { pid: number; pgid: number; start: string; state: string; boot: string; host: string };
function native(pid: number): NativeIdentity | undefined {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;throw error; }
  let row: string;
  try { row = execFileSync("/bin/ps", ["-o", "pgid=,state=,lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" } }).trim(); }
  catch (error) {
    // A concurrent honest exit is absence only when the kernel confirms ESRCH.
    try { process.kill(pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") return undefined; }
    throw error;
  }
  const match = /^(\d+)\s+(\S+)\s+(.+)$/.exec(row);
  if (!match) throw new Error("Unrecognized task-owned native identity");
  return { pid, pgid: Number(match[1]), state: match[2]!, start: match[3]!, boot: processBootIdentity(), host: hostname() };
}
function sameChild(captured: NativeIdentity): NativeIdentity | undefined {
  const current = native(captured.pid);
  if (!current) return undefined;
  if (current.start !== captured.start || current.boot !== captured.boot || current.host !== captured.host || current.pgid !== captured.pgid)
    throw new Error("Task-owned child identity changed; preserve unknown instead of using a recycled PID");
  return current;
}
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

it.each(["ordinary", "detached"] as const)("keeps honest physical settlement through actual accepted process execution: %s", async mode => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-review-detached-"))), workspace = join(root, "workspace"), temp = join(root, "process-temp");
  mkdirSync(workspace, { mode: 0o700 });mkdirSync(temp, { mode: 0o700 });
  const readyPath = join(workspace, "detached-ready.json"), expiredPath = join(workspace, "detached-expired.json");
  const wrapperPath = join(root, "wrapper.mjs"), mainPath = join(root, "main.mjs"), type = "fixture:detached@1";
  writeFileSync(wrapperPath, `export const definitions=[{type:'action-script',version:'1',*run(input){return yield {kind:'activity',type:${JSON.stringify(type)},input};}}];`, { mode: 0o600 });
  // Exactly one finite detached child. It writes only task-owned markers and
  // exits itself; no network, credentials, repeat spawn or cleanup signal.
  const childCode = `import {writeFileSync} from 'node:fs';
const ready=${JSON.stringify(readyPath)},expired=${JSON.stringify(expiredPath)};
const began=Date.now(),expires=began+${CHILD_LIFETIME_MS};
writeFileSync(ready,JSON.stringify({pid:process.pid,ready_at:began,expires_at:expires}),{flag:'wx',mode:0o600});
setTimeout(()=>{writeFileSync(expired,JSON.stringify({pid:process.pid,expired_at:Date.now()}),{flag:'wx',mode:0o600});process.exit(0);},Math.max(1,expires-Date.now()));`;
  writeFileSync(mainPath, mode === "ordinary" ? "process.stdout.write(JSON.stringify({root_completed:true}));" : `import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';
const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});child.unref();
const deadline=Date.now()+${READY_WAIT_MS};while(!existsSync(${JSON.stringify(readyPath)})){if(Date.now()>=deadline)throw Error('Task-owned detached child never became ready');await new Promise(r=>setTimeout(r,20));}
process.stdout.write(JSON.stringify({root_completed:true}));`, { mode: 0o600 });
  const artifacts = new WorkArtifactStore(join(root, "artifacts"), 192 * 1024 * 1024);
  let owner: WorkflowOwner | undefined, host: ReturnType<typeof createProcessWorkWorker> | undefined, broker: WorkResourceBroker | undefined;
  let captured: NativeIdentity | undefined, failed = false, accepted: Awaited<ReturnType<WorkAdmissionService<string>["submit"]>> | undefined;
  const failures: unknown[] = [], observations: unknown[] = [], workerErrors: string[] = [];
  const binding = () => {
    const db = new SqliteDatabase(join(root, "executor.db"));
    try { const row = db.prepare("SELECT binding FROM executions LIMIT 1").get();return row ? executionBindingSchema.parse(JSON.parse(String(row.binding))) : undefined; }
    finally { db.close(); }
  };
  const preserve = (label: string) => {
    for (const name of ["owner.db", "executor.db", "broker.db"]) for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(root, name + suffix);if (existsSync(path)) copyFileSync(path, join(root, `${label}-${name}${suffix}`));
    }
    writeFileSync(join(root, `${label}.json`), JSON.stringify({ root, accepted, captured, observations, workerErrors,
      errors: failures.map(error => error instanceof Error ? { name: error.name, message: error.message } : String(error)),
      note: "Raw DB/WAL/SHM copies are crash-state evidence, not a coherent backup. No raw PID signals were sent." }, null, 2), { flag: "wx", mode: 0o600 });
  };
  try {
    const base = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], bounds: [], boundByName: async () => undefined });
    const { fingerprint: _fingerprint, ...evidence } = base;
    const ceiling = { ...evidence, tools: { "bash:Bash": "write" as const }, contracts: { "bash:Bash": boundFingerprint({ fixture: "Bash" }) } };
    const scope = { ...ceiling, fingerprint: boundFingerprint(ceiling) };
    const prepared = prepareProcessProgram({ artifacts, source: mainPath, runtime: process.execPath, installation: "owner", activity_type: type, scope,
      argv: [{ source: true }], cwd: workspace, env: {}, secret_names: [], credential_owner: { kind: "none" }, output: "json" });
    const wrapper = inspectArtifact(wrapperPath, "action-script", "1"), wrapperSource = artifacts.stage(readFileSync(wrapperPath), { purpose: "source", media_type: "text/javascript", owner_identity: null });
    broker = new WorkResourceBroker({ path: join(root, "broker.db"), broker: "host", limits: { local: { kind: "host" } } });
    const currentBroker = broker;
    owner = new WorkflowOwner({ id: "owner", path: join(root, "owner.db"), artifacts: [wrapper], activityArtifacts: { [type]: prepared.source.digest }, executor: new ProcessExecutor(), workArtifacts: artifacts,
      authorizeWork: () => scope, workResources: { host: () => ({ broker: "host", resource: "local" }), brokers: new Map([["host", currentBroker]]) } });
    const currentOwner = owner;
    const request: WorkSubmission = { version: 2, request_id: "a8d6fd25-537f-4681-bf93-a693a00c2fc1", idempotency_key: "detached-review", authority_ref: "trusted-fixture",
      definition: { kind: "action", reference: "fixture:detached", catalog_namespace: "fixture" }, inputs: {}, origin: { entry_point: "native-review-fixture", trigger: "manual" } };
    const authority: WorkAuthority = { namespace: { installation: "owner", principal_kind: "identity", principal_id: "alice", identity_id: "alice", caller_session_id: null }, origin: request.origin, caller_ceiling: scope, run_identity: "alice" };
    const grant = { version: 2 as const, grant_ref: "detached-grant", revision: 1, namespace: authority.namespace, authorizer: "alice", created_by: "alice", approved_at: Date.now(),
      original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
    const resolution: WorkResolution = { title: "Finite detached child", grant, workflow_input: request.inputs, plan: {
      version: 2, definition: request.definition, workflow: { type: wrapper.type, version: wrapper.version, artifact_digest: wrapper.digest, runtime_abi: wrapper.abi, input_digest: boundFingerprint(request.inputs) },
      source_closure: [wrapperSource, ...prepared.sources], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "detached-review",
      execution_profile: "portable", effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: { mode: "json-schema", schema: { type: "object", required: ["root_completed"], properties: { root_completed: { const: true } }, additionalProperties: false } },
      process_program: prepared.program, resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: null },
      workspace: { kind: "host-bound", installation: "owner", resource_ref: boundFingerprint(prepared.program.cwd), mapping_version: 1 },
      selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "fixture" }, execution_budget_ms: 30000, dispatch_budget_ms: 60000,
    } };
    const service = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async () => structuredClone(resolution) });
    const client = connectWorkOwnerV3("owner", input => dispatchWorkerRequest(currentOwner, "owner", input));
    host = createProcessWorkWorker({ installation: "owner", journalPath: join(root, "executor.db"), artifactRoot: artifacts.root, connections: [{ owner: "owner", client }],
      advertisement: { types: [type], artifacts: { [type]: prepared.source.digest } }, capacity: 1, maxArtifactBytes: 192 * 1024 * 1024, tempRoot: temp, onError: error => workerErrors.push(String(error)) });
    accepted = await service.submit(request, "trusted-fixture-credential");
    if (mode === "ordinary") {
      await expect.poll(async () => {
        await currentOwner.pump();await host!.worker.tick();
        const retained = binding();return retained ? host!.journal.receipt(retained) : null;
      }, { timeout: 35000 }).not.toBeNull();
      await expect.poll(async () => { await currentOwner.pump();await host!.worker.tick();return host!.journal.pendingDeliveryCount() === 0 && currentOwner.get(accepted!.workflow_id).status !== "running"; }).toBe(true);
      const retained = binding()!, receipt = host.journal.receipt(retained)!, start = host.journal.retainedStart(retained)!;
      observations.push({ at: Date.now(), receipt, reservation: currentBroker.inspect(start.resources.host_reservation!) });
      expect(receipt).toMatchObject({ physical_state: "ceased", outcome: "complete", validation: "passed" });
      expect(currentBroker.inspect(start.resources.host_reservation!)?.state).toBe("released");
      expect(currentOwner.workResult({ kind: "installation", installation: "owner" }, accepted.work_id).outcome).toEqual({ ok: true, value: { root_completed: true } });
      expect(workerErrors).toEqual([]);
    } else {
      await expect.poll(async () => { await currentOwner.pump();await host!.worker.tick();return existsSync(readyPath); }, { timeout: 35000 }).toBe(true);
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { pid: number; ready_at: number; expires_at: number };
      expect(Number.isSafeInteger(ready.pid) && ready.pid > 0).toBe(true);
      expect(Number.isSafeInteger(ready.ready_at) && ready.ready_at > 0).toBe(true);
      expect(Number.isSafeInteger(ready.expires_at) && ready.expires_at > 0).toBe(true);
      expect(ready.expires_at - ready.ready_at).toBe(CHILD_LIFETIME_MS);
      expect(Date.now(), "Late first observation is inconclusive, not proof of containment").toBeLessThan(ready.expires_at);
      captured = native(ready.pid);
      expect(Date.now(), "The native identity probe must finish within the declared child lifetime").toBeLessThan(ready.expires_at);
      if (captured) expect(captured.pgid).toBe(captured.pid);
      // A future enforceable containment implementation may already have ended
      // the child. Kernel-confirmed absence is acceptable; a missing ready marker
      // or an unsupported/disabled whole process path is not this control.
      if (!captured) expect(existsSync(expiredPath), "Natural expiry must not masquerade as early containment").toBe(false);
      observations.push({ at: Date.now(), ready, firstNativeObservation: captured ?? null });
      const observedUntil = Date.now() + OBSERVATION_MS;
      while (captured && Date.now() < observedUntil) {
        await currentOwner.pump();await host.worker.tick();
        let current = sameChild(captured!);
        const retainedBinding = binding(), receipt = retainedBinding && host.journal.receipt(retainedBinding);
        const start = retainedBinding && host.journal.retainedStart(retainedBinding);
        let reservation = start?.resources.host_reservation ? currentBroker.inspect(start.resources.host_reservation) : undefined;
        if (receipt?.physical_state === "ceased" && current && !current.state.startsWith("Z")) {
          // Deliver the actual immutable receipt through the actual worker before
          // observing broker release; no direct owner completion or fake ACK.
          await host.worker.tick();await currentOwner.pump();
          current = sameChild(captured!);
          reservation = start?.resources.host_reservation ? currentBroker.inspect(start.resources.host_reservation) : undefined;
        }
        const executing = current !== undefined && !current.state.startsWith("Z");
        observations.push({ at: Date.now(), child: current, receipt, reservation });
        if (executing) {
          // The substantive end-to-end assertions: real receipt and real broker,
          // while an independently captured same-start detached child is live.
          expect(receipt?.physical_state, "A live new-session descendant forbids a full-execution ceased receipt").not.toBe("ceased");
          expect(reservation?.state, "Physical host capacity must not be released while that descendant is executing").not.toBe("released");
        }
        if (!current) break;
        await sleep(100);
      }
      expect(captured ? sameChild(captured) : undefined, "Task-owned descendant must cease; no fixture PID signal substitutes for proof").toBeUndefined();
    }
  } catch (error) {
    failed = true;failures.push(error);
    try { preserve("failure-before-cleanup"); } catch (preservation) { failures.push(preservation); }
  } finally {
    // Let the one child end itself. Never signal a persisted/recycled PID.
    try {
      if (!captured && existsSync(readyPath)) {
        const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { pid: number };captured = native(ready.pid);
      }
      if (captured) {
        const until = Date.now() + CLEANUP_WAIT_MS;
        while (sameChild(captured) && Date.now() < until) await sleep(100);
        if (sameChild(captured)) { failed = true;failures.push(new Error("Finite child absence remains unknown; original scratch retained")); }
      } else if (mode === "detached" && accepted && !existsSync(readyPath)) {
        failed = true;failures.push(new Error("Child native identity unavailable; retain unknown scratch without an absence claim"));
      }
    } catch (error) { failed = true;failures.push(error); }
    try { await host?.close(); } catch (error) { failed = true;failures.push(error); }
    try { await owner?.drain(); } catch (error) { failed = true;failures.push(error); }
    try { owner?.close();broker?.close();artifacts.close(); } catch (error) { failed = true;failures.push(error); }
    if (failed) { try { preserve("failure-after-cleanup"); } catch (error) { failures.push(error); } }
    else rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, `Detached descendant regression failed; retained ${root}`);
}, 90000);
