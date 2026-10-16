import { expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { WorkflowOwner, WorkArtifactStore, ProcessExecutor, WorkAdmissionService, WorkResourceBroker, prepareProcessProgram,
  createProcessWorkWorker, connectWorkOwnerV3, dispatchWorkerRequest, inspectArtifact, type WorkResolution } from "@barry-rocks/sdk/internal/workflows";

/** Trusted admission fixture; the surrounding test supplies the actual Sessions
 * HTTP authentication/control chain. No activity or Stop is simulated here. */
export async function createNativeControlWork(root: string, identity: string, installation: string) {
  const directory = join(root, "native-control"), workspace = join(directory, "workspace"), temporary = join(directory, "process-temp");
  mkdirSync(workspace, { recursive: true }); mkdirSync(temporary);
  const workflowType = "action-script", activityType = "fixture:native-control@1";
  const wrapperPath = join(directory, "workflow.mjs"), sourcePath = join(directory, "main.sh");
  writeFileSync(wrapperPath, `export const definitions=[{type:${JSON.stringify(workflowType)},version:'1',*run(input){return yield {kind:'activity',type:${JSON.stringify(activityType)},input};}}];`);
  // Readiness follows installing the signal disposition and committing the
  // single effect. TERM resistance leaves an observable occupied interval.
  writeFileSync(sourcePath, "trap '' TERM\nprintf once >> effects\nprintf '%s' \"$$\" > ready\nwhile :; do /bin/sleep 0.1; done\n");
  const wrapper = inspectArtifact(wrapperPath, workflowType, "1"), artifacts = new WorkArtifactStore(join(directory, "artifacts"));
  const base = await approveWorkflowBounds({ identity, bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const { fingerprint: _fingerprint, ...value } = base;
  const scopeValue = { ...value, tools: { "bash:Bash": "write" as const }, contracts: { "bash:Bash": boundFingerprint({ fixture: "native-control Bash contract" }) } };
  const scope = { ...scopeValue, fingerprint: boundFingerprint(scopeValue) };
  const prepared = prepareProcessProgram({ artifacts, source: sourcePath, runtime: "/bin/bash", activity_type: activityType, installation, scope,
    argv: [{ source: true }], cwd: workspace, output: "text-tail", credential_owner: { kind: "none" }, secret_names: [] });
  const closure = [artifacts.stage(readFileSync(wrapperPath), { purpose: "source", media_type: "text/javascript", owner_identity: null }), ...prepared.sources];
  const namespace = { installation, principal_kind: "identity" as const, principal_id: identity, identity_id: identity, caller_session_id: "owned" };
  const origin = { entry_point: "fixture", trigger: "manual" as const, caller_session_id: "owned" };
  const grant = { version: 2 as const, grant_ref: "native-control-fixture", revision: 1, namespace, authorizer: identity, created_by: identity,
    approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const broker = new WorkResourceBroker({ path: join(directory, "broker.db"), broker: "native-control-host", limits: { local: { kind: "host" } } });
  const owner = new WorkflowOwner({ id: installation, path: join(directory, "owner.db"), artifacts: [wrapper], activityArtifacts: { [activityType]: prepared.source.digest },
    executor: new ProcessExecutor(), workArtifacts: artifacts, authorizeWork: () => scope,
    workResources: { host: () => ({ broker: broker.id, resource: "local" }), brokers: new Map([[broker.id, broker]]) } });
  const errors: unknown[] = [], client = connectWorkOwnerV3(installation, async input => dispatchWorkerRequest(owner, installation, input));
  const host = createProcessWorkWorker({ installation, journalPath: join(directory, "executor.db"), artifactRoot: artifacts.root, connections: [{ owner: installation, client }],
    advertisement: { types: [activityType], artifacts: { [activityType]: prepared.source.digest } }, capacity: 1, tempRoot: temporary, onError: error => errors.push(error) });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    try { await host.close(); }
    finally { try { await owner.drain(); } finally { owner.close(); broker.close(); artifacts.close(); } }
  })();
  try {
    const admission = new WorkAdmissionService({ owner, authenticate: async () => ({ namespace, origin, run_identity: identity, caller_ceiling: scope }),
      resolve: async (input): Promise<WorkResolution> => ({ title: "Native control fixture", grant, workflow_input: input.inputs, plan: {
        version: 2, definition: input.definition, workflow: { type: wrapper.type, version: wrapper.version, artifact_digest: wrapper.digest, runtime_abi: wrapper.abi, input_digest: boundFingerprint(input.inputs) },
        source_closure: closure, grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable",
        effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: { mode: "none" }, process_program: prepared.program,
        resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner", host_reservation: null, endpoint: null },
        workspace: { kind: "host-bound", installation, resource_ref: boundFingerprint(prepared.program.cwd), mapping_version: 1 },
        selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" },
        execution_budget_ms: 60000, dispatch_budget_ms: 60000,
      } }) });
    const work = await admission.submit({ version: 2, request_id: randomUUID(), idempotency_key: "native-control", authority_ref: "trusted-fixture", origin,
      definition: { kind: "action", reference: "fixture:native-control", catalog_namespace: "fixture" }, inputs: {} }, null);
    const tick = async () => { await owner.pump(); await host.worker.tick(); };
    let binding: ReturnType<typeof host.journal.unfinished>["entries"][number]["binding"] | undefined;
    const requireBinding = () => { if (!binding) throw new Error("Native readiness has not been established."); return binding; };
    const childAlive = () => {
      if (!existsSync(join(workspace, "ready"))) return false;
      const pid = Number(readFileSync(join(workspace, "ready"), "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    const receipt = () => host.journal.receipt(requireBinding());
    const reservation = (): 0 | 1 => {
      const retained = host.journal.retainedStart(requireBinding())!.resources.host_reservation;
      if (!retained) throw new Error("Native execution has no retained host reservation.");
      const held = broker.inspect(retained);
      if (!held) throw new Error("Native host reservation is missing from the broker.");
      return held.state === "released" ? 0 : 1;
    };
    const effectCount = () => existsSync(join(workspace, "effects")) ? readFileSync(join(workspace, "effects"), "utf8").split("once").length - 1 : 0;
    const waitStarted = async () => {
      await expect.poll(async () => { await tick(); return childAlive(); }, { timeout: 20000 }).toBe(true);
      binding = host.journal.unfinished(installation).entries.find(entry => entry.binding.work_id === work.work_id)?.binding;
      expect(childAlive()).toBe(true); expect(reservation()).toBe(1); expect(effectCount()).toBe(1); expect(receipt()).toBeNull();
    };
    const waitCeased = async () => {
      await expect.poll(async () => { await tick(); return receipt()?.physical_state; }, { timeout: 15000 }).toBe("ceased");
      expect(receipt()).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
      expect(childAlive()).toBe(false);
      await expect.poll(async () => { await tick(); return reservation(); }, { timeout: 5000 }).toBe(0);
      expect(effectCount()).toBe(1);
    };
    return { owner, work, namespace, workflowType, waitStarted, reservation, close, tick, waitCeased, childAlive, receipt, effectCount, errors };
  } catch (error) { await close(); throw error; }
}
