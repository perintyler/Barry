import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, renameSync, existsSync, copyFileSync, cpSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { WorkflowOwner } from "./workflow-owner.js";
import { ProcessExecutor } from "./executor.js";
import { processBootIdentity } from "./work-process-supervisor.js";
import { inspectArtifact } from "./artifacts.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { WorkResourceBroker } from "./work-resource-broker.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import { createProcessWorkWorker } from "./work-process-worker.js";
import { connectWorkOwnerV3, dispatchWorkerRequest } from "./protocol.js";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import type { WorkAuthority } from "./work-authority.js";
import { prepareProcessProgram, sealedSystemRuntime } from "./work-process-program.js";
import { prepareProcessBundle } from "./work-process-bundle.js";
import { executionBindingSchema, logicalStageEffectKey, type WorkSubmission, type WorkProcessProgram } from "./work-contracts.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import type { Json } from "./types.js";

type NativeIdentity = { pid: number; pgid: number; startedAt: number; boot: string; host: string };
function nativePresent(pid: number): boolean { try { process.kill(pid, 0);return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; } }
function nativeIdentity(pid: number): NativeIdentity {
  return { pid, pgid: Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()),
    startedAt: Math.floor(Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()) / 1000), boot: processBootIdentity(), host: hostname() };
}
function sameNative(owned: NativeIdentity): boolean {
  if (!nativePresent(owned.pid)) return false;
  const current = nativeIdentity(owned.pid);
  if (!Number.isFinite(owned.startedAt) || JSON.stringify(current) !== JSON.stringify(owned)) throw new Error("Fixture native identity changed; refusing cleanup signal");
  return true;
}
async function cleanupNative(owned: NativeIdentity | undefined): Promise<void> {
  if (owned && sameNative(owned)) { process.kill(owned.pid, "SIGKILL");await expect.poll(() => nativePresent(owned.pid), { timeout: 5000 }).toBe(false); }
}

const retainedDiagnostics = new Map<string, () => void>();
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(source: string, options: { otherClaim?: () => Promise<null>; otherCapacity?: (capacity: number) => void; commands?: Partial<Record<"preflight" | "postcondition", { command?: string; timeout_ms?: number; files_exist?: string[] }>>; argv?: WorkProcessProgram["argv"]; bundleFiles?: Record<string, string>; envelope?: boolean; secondSource?: string; schema?: Record<string, Json> | null; budget?: number; secret?: string; noSecretResolver?: boolean; runtime?: string; native?: boolean; nativeCopy?: boolean; maxArtifactBytes?: number; sourceName?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "work-process-program-")); cleanup.push(() => {
    const retained = retainedDiagnostics.get(root);
    if (retained) { retainedDiagnostics.delete(root);retained(); }
    else rmSync(root, { force: true, recursive: true });
  });
  const workspace = join(root, "workspace"), processTempRoot = join(root, "process-temp"); mkdirSync(workspace); mkdirSync(processTempRoot);
  const wrapperPath = join(root, "wrapper.mjs"), jobPath = join(root, options.native ? "program" : options.sourceName ?? "main.sh"), type = "fixture:script@1";
  writeFileSync(wrapperPath, "export const definitions=[{type:'action-script',version:'1',*run(input){return yield {kind:'activity',type:'fixture:script@1',input};}}];");
  if (options.envelope) writeFileSync(wrapperPath, readFileSync(new URL("../../../bags/workflows/src/process-artifact.mjs", import.meta.url)));
  if (!options.native) writeFileSync(jobPath, source);
  if (options.nativeCopy) copyFileSync("/usr/bin/true", jobPath);
  const wrapper = inspectArtifact(wrapperPath, "action-script", options.envelope ? "2" : "1");
  const artifacts = new WorkArtifactStore(join(root, "artifacts"), options.maxArtifactBytes); cleanup.push(() => artifacts.close());
  const baseScope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], bounds: [], boundByName: async () => undefined });
  const { fingerprint: _fingerprint, ...base } = baseScope;
  const value = { ...base, tools: { "bash:Bash": "write" as const }, contracts: { "bash:Bash": boundFingerprint({ fixture: "Bash contract" }) } }, scope = { ...value, fingerprint: boundFingerprint(value) };
  const runtimePath = options.runtime ?? "/bin/bash";
  const bundleFiles = Object.entries(options.bundleFiles ?? {}).map(([path, content]) => {
    const file = join(root, "bundle-input", path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, content); return { path, source: file };
  });
  const bundle = options.bundleFiles ? prepareProcessBundle({ artifacts, allowedRoots: [root], files: [{ path: options.sourceName ?? "main.sh", source: jobPath }, ...bundleFiles] }) : undefined;
  const prepared = prepareProcessProgram({ artifacts, source: options.native ? options.nativeCopy ? jobPath : "/bin/echo" : jobPath, runtime: options.native ? undefined : runtimePath,
    activity_type: type, installation: "owner", scope, argv: options.argv ?? (options.native ? ["native process"] : [{ source: true }]), cwd: workspace,
    env: { DECLARED: "explicit", BARRY_ACTION_DIR: workspace }, secret_names: options.secret ? ["DECLARED_SECRET"] : [], credential_owner: options.secret ? { kind: "identity", identity: "alice" } : { kind: "none" }, output: options.schema === null ? "text-tail" : "json",
    ...(bundle ? { bundle: { source: bundle.source, entry: options.sourceName ?? "main.sh" }, sourceEnvironment: ["BARRY_ACTION_DIR"] } : {}) });
  const job = { path: jobPath, digest: prepared.source.digest, type };
  if (options.commands) {
    const path = realpathSync("/bin/sh"), shell = artifacts.stage(readFileSync(path), { purpose: "source", media_type: "application/octet-stream", owner_identity: null });
    prepared.sources = [...new Map([...prepared.sources, shell].map(ref => [ref.digest, ref])).values()];
    prepared.program.commands = Object.fromEntries(Object.entries(options.commands).map(([stage, command]) => [stage, { runtime: shell, ...(sealedSystemRuntime(path) ? { runtime_path: path } : {}), cwd: prepared.program.cwd, timeout_ms: command.timeout_ms ?? 1000, files_exist: command.files_exist ?? [], ...(command.command ? { command: command.command } : {}) }]));
  }
  const secondPath = join(root, "second.sh");
  if (options.secondSource) writeFileSync(secondPath, options.secondSource);
  const second = options.secondSource ? prepareProcessProgram({ artifacts, source: secondPath, runtime: runtimePath, activity_type: "fixture:second@1", installation: "owner", scope, argv: [{ source: true }], cwd: workspace, output: "json" }) : undefined;
  const activityArtifacts = { [type]: job.digest, ...(second ? { [second.program.activity_type]: second.source.digest } : {}) };
  const refs = [...new Map([artifacts.stage(readFileSync(wrapperPath), { purpose: "source", media_type: "text/javascript", owner_identity: null }), ...prepared.sources, ...(second?.sources ?? [])].map(ref => [ref.digest, ref])).values()];
  const broker = new WorkResourceBroker({ path: join(root, "broker.db"), broker: "host", limits: { local: { kind: "host" } } }); cleanup.push(() => broker.close());
  const schema = options.schema === undefined ? { type: "object" } : options.schema;
  const database = join(root, "owner.db"), owner = new WorkflowOwner({ id: "owner", path: database, artifacts: [wrapper], activityArtifacts,
    executor: new ProcessExecutor(), workArtifacts: artifacts, workResources: { host: () => ({ broker: "host", resource: "local" }), brokers: new Map([["host", broker]]) }, authorizeWork: () => scope });
  cleanup.push(async () => { await owner.drain(); owner.close(); });
  const request: WorkSubmission = { version: 2, request_id: "815f58b2-ea9a-4eba-8c0e-e2249ea7b837", idempotency_key: "process-program", authority_ref: "trusted-fixture", definition: { kind: "action", reference: "fixture:script", catalog_namespace: "fixture" }, inputs: { value: "script-result" }, origin: { entry_point: "fixture", trigger: "manual" } };
  const authority: WorkAuthority = { namespace: { installation: "owner", principal_kind: "identity", principal_id: "alice", identity_id: "alice", caller_session_id: null }, origin: request.origin, caller_ceiling: scope, run_identity: "alice" };
  const grant = { version: 2 as const, grant_ref: "job-grant", revision: 1, namespace: authority.namespace, authorizer: "alice", created_by: "alice", approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "fixture" };
  const resolution = (input: WorkSubmission): WorkResolution => {
    const selected = input.definition.reference === "fixture:second" ? second! : prepared;
    const workflowInput = options.envelope ? { activity_type: selected.program.activity_type, input: input.inputs, execution_budget_ms: options.budget ?? 10000 } : input.inputs;
    return { title: "Script action", grant, workflow_input: workflowInput, plan: {
    version: 2, definition: input.definition, workflow: { type: wrapper.type, version: wrapper.version, artifact_digest: wrapper.digest, runtime_abi: wrapper.abi, input_digest: boundFingerprint(workflowInput) }, source_closure: refs,
    grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable",
    effect_policy: { class: "non-repeatable", max_attempts: 1 },
    validation: schema ? { mode: "json-schema", schema } : { mode: "none" }, process_program: { ...selected.program, ...(options.envelope ? { input_digest: boundFingerprint(input.inputs) } : {}) },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "assigned-by-owner", host_reservation: null, endpoint: null }, workspace: { kind: "host-bound", installation: "owner", resource_ref: boundFingerprint(prepared.program.cwd), mapping_version: 1 },
    selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: options.budget ?? 10000, dispatch_budget_ms: 120000,
  } }; };
  const service = (resolve = async (input: WorkSubmission) => resolution(input)) => new WorkAdmissionService({ owner, authenticate: async () => authority, resolve });
  const client = connectWorkOwnerV3("owner", input => dispatchWorkerRequest(owner, "owner", input)), errors: unknown[] = [];
  const host = createProcessWorkWorker({ installation: "owner", journalPath: join(root, "executor.db"), artifactRoot: artifacts.root, connections: [{ owner: "owner", client }, ...(options.otherCapacity ? [{ owner: "second-owner", client: { ...client, advertise: async (advertisement: { capacity: number }) => { options.otherCapacity!(advertisement.capacity); }, claim: options.otherClaim ?? (async () => null) } }] : [])], advertisement: { types: Object.keys(activityArtifacts), artifacts: activityArtifacts }, capacity: 1, tempRoot: processTempRoot, maxArtifactBytes: options.maxArtifactBytes, resolveProcessSecrets: options.noSecretResolver ? undefined : async start => { expect(start.process_program?.secret_names).toEqual(["DECLARED_SECRET"]); expect(start.process_program?.credential_owner).toEqual({ kind: "identity", identity: "alice" }); return { DECLARED_SECRET: options.secret! }; }, onError: error => errors.push(error) });
  cleanup.push(() => host.close());
  const binding = (workId?: string) => {
    const db = new SqliteDatabase(join(root, "executor.db"));
    try { return executionBindingSchema.parse(JSON.parse(String(db.prepare("SELECT binding FROM executions WHERE (? IS NULL OR json_extract(binding,'$.work_id')=?) LIMIT 1").get(workId ?? null, workId ?? null)!.binding))); } finally { db.close(); }
  };
  const finish = async (accepted: Awaited<ReturnType<WorkAdmissionService<string>["submit"]>>) => {
    await expect.poll(async () => { await owner.pump(); await host.worker.tick(); return host.journal.receipt(binding(accepted.work_id)); }, { timeout: (options.budget ?? 10000) + 5000 }).not.toBeNull();
    await expect.poll(async () => { await owner.pump(); await host.worker.tick(); return host.journal.pendingDeliveryCount() === 0 && owner.get(accepted.workflow_id).status !== "running"; }).toBe(true);
    await owner.pump(); return { receipt: host.journal.receipt(binding(accepted.work_id))!, result: owner.workResult({ kind: "installation", installation: "owner" }, accepted.work_id) };
  };
  return { root, workspace, processTempRoot, runtimePath, wrapper, prepared, job, owner, scope, broker, artifacts, authority, request, resolution, service, client, host, errors, binding, finish, bundleFiles };
}

it("process bundle: retained modules, package metadata and file-origin resources survive installed mutations", async () => {
  const f = await fixture(`import value from 'fixture-package';
import {readFileSync,writeFileSync} from 'node:fs';
const asset=readFileSync(new URL('./assets/value.txt',import.meta.url),'utf8');
if(readFileSync(process.env.BARRY_ACTION_DIR+'/assets/value.txt','utf8')!==asset)throw Error('source mapping');
writeFileSync('workspace-marker','once');process.stdout.write(JSON.stringify({value,asset,loader:process.env.RETAINED_LOADER}));`, {
    envelope: true, sourceName: "main.mjs", runtime: process.execPath, budget: 30000, maxArtifactBytes: 192 * 1024 * 1024,
    argv: ["--import", { file: "loader.mjs", format: "file-url" }, { source: true }],
    bundleFiles: { "node_modules/fixture-package/package.json": '{"type":"module","exports":"./index.mjs"}', "node_modules/fixture-package/index.mjs": 'export default "retained-dependency";', "assets/value.txt": "retained-resource", "loader.mjs": 'process.env.RETAINED_LOADER="retained-loader";' },
  });
  const accepted = await f.service().submit(f.request, "alice");
  writeFileSync(f.job.path, 'throw Error("changed main");');
  for (const file of f.bundleFiles) writeFileSync(file.source, "changed installed bytes");
  const { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: { value: "retained-dependency", asset: "retained-resource", loader: "retained-loader" } });
  expect(readFileSync(join(f.workspace, "workspace-marker"), "utf8")).toBe("once");
  expect(f.errors).toEqual([]);
});

it("process bundle: altered entry and missing closure refuse before admission", async () => {
  const f = await fixture("printf '{}'", { envelope: true, bundleFiles: { "other.sh": "printf changed" } });
  for (const change of ["entry", "closure", "argument"] as const) {
    await expect(f.service(async request => {
      const value = structuredClone(f.resolution(request));
      if (change === "entry") value.plan.process_program!.bundle!.entry = "other.sh";
      if (change === "closure") value.plan.source_closure = value.plan.source_closure.filter(ref => ref.digest !== value.plan.process_program!.bundle!.source.digest);
      if (change === "argument") value.plan.process_program!.argv.push({ file: "absent.mjs", format: "file-url" });
      return value;
    }).submit(f.request, "alice")).rejects.toMatchObject({ code: "WorkSourceManifestInvalid" });
  }
});

it("process envelope: one retained wrapper dispatches two programs with original application input", async () => {
  const f = await fixture("cat > first-input; printf '{\"program\":1}'", { envelope: true, secondSource: "cat > second-input; printf '{\"program\":2}'" });
  const first = await f.service().submit(f.request, "alice");
  expect((await f.finish(first)).result.outcome).toEqual({ ok: true, value: { program: 1 } });
  const request = { ...f.request, request_id: "78e21285-9983-40cc-8017-652bd173f5bb", idempotency_key: "second-program", definition: { ...f.request.definition, reference: "fixture:second" }, inputs: { activity_type: "application-owned", input: "ordinary input field", value: 2 } };
  const second = await f.service().submit(request, "alice");
  expect((await f.finish(second)).result.outcome).toEqual({ ok: true, value: { program: 2 } });
  expect(JSON.parse(readFileSync(join(f.workspace, "first-input"), "utf8"))).toEqual(f.request.inputs);
  expect(JSON.parse(readFileSync(join(f.workspace, "second-input"), "utf8"))).toEqual(request.inputs);
  expect(f.host.journal.retainedStart(f.binding(second.work_id))?.inputs).toEqual(request.inputs);
  expect(f.errors).toEqual([]);
});

it("process envelope: altered dispatch, input, budget and digest refuse before admission", async () => {
  const f = await fixture("printf '{}'", { envelope: true });
  for (const change of ["dispatch", "input", "budget", "digest", "missing", "extra"] as const) {
    await expect(f.service(async request => {
      const value = structuredClone(f.resolution(request));
      const envelope = value.workflow_input as { activity_type: string; input: Json; execution_budget_ms: number };
      if (change === "dispatch") envelope.activity_type = "fixture:other@1";
      if (change === "input") envelope.input = { substituted: true };
      if (change === "budget") envelope.execution_budget_ms++;
      if (change === "digest") value.plan.process_program!.input_digest = boundFingerprint({ substituted: true });
      if (change === "missing") delete value.plan.process_program!.input_digest;
      if (change === "extra") value.workflow_input = { ...envelope, extra: true };
      value.plan.workflow.input_digest = boundFingerprint(value.workflow_input);
      return value;
    }).submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedProcessProgram" });
  }
  expect(f.owner.listWork({ kind: "installation", installation: "owner" }, {}).total).toBe(0);
});

it("command stages: advisory failures preserve main success, separate effect keys and retained main output", async () => {
  const f = await fixture("printf main >> effects; printf '{}'", { commands: { preflight: { command: "printf probe >> effects; printf '%s' \"$BARRY_JOB_KEY\" > probe-key; exit 1" }, postcondition: { command: "printf post >> effects; printf '%s' \"$BARRY_JOB_KEY\" > post-key; exit 1", files_exist: ["missing-file"] } } });
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} });
  expect(receipt.stages.map(stage => stage.stage)).toEqual(["preflight", "execution", "validation", "postcondition"]);
  expect(result.action_checks).toMatchObject({ preflight: { passed: false, unknown: false }, postcondition: { passed: false, unknown: false, failures: expect.arrayContaining(["expected file not found: missing-file"]) } });
  expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("probemainpost");
  expect(readFileSync(join(f.workspace, "probe-key"), "utf8")).not.toBe(readFileSync(join(f.workspace, "post-key"), "utf8"));
});
it.each(["preflight", "postcondition"] as const)("command stages: a lost committed %s acknowledgement never repeats earlier effects", async stage => {
  const f = await fixture("printf main >> effects; printf '{}'", { commands: { preflight: { command: "printf probe >> effects; exit 1" }, postcondition: { command: "printf post >> effects; exit 1" } } });
  const complete = f.host.journal.completeStage.bind(f.host.journal); let lost = false;
  vi.spyOn(f.host.journal, "completeStage").mockImplementation((binding, receipt, physical) => { const value = complete(binding, receipt, physical); if (!lost && receipt.stage === stage) { lost = true; throw new Error("lost committed command stage reply"); } return value; });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(lost).toBe(true); expect(result.outcome).toEqual({ ok: true, value: {} });
  expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("probemainpost");
  expect(result.action_checks).toMatchObject({ preflight: { passed: false, unknown: false }, postcondition: { passed: false, unknown: false } });
});
it("command stages: many failed file checks stay bounded without stranding a successful main result", async () => {
  const f = await fixture("printf '{}'", { commands: { postcondition: { files_exist: Array.from({ length: 120 }, (_, index) => `${"不存在".repeat(30)}${index}`) } } });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} }); expect(result.action_checks?.postcondition?.passed).toBe(false);
  expect(result.action_checks?.postcondition?.failures).toHaveLength(100);
  expect(result.action_checks?.postcondition?.failures.at(-1)).toContain("additional file checks failed");
});
it("command stages: metadata-only publication retains negative command reports and never reruns effects", async () => {
  const f = await fixture("printf main >> effects; printf '{}'", { commands: { preflight: { command: "printf probe >> effects; exit 1" }, postcondition: { command: "printf post >> effects; exit 1" } } });
  const commit = vi.spyOn(f.host.journal, "commitReceipt").mockImplementation(() => { throw new Error("fixture interrupts receipt publication"); });
  const accepted = await f.service().submit(f.request, "alice");
  await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return f.errors.some(error => String(error).includes("interrupts receipt publication")); }, { timeout: 10000 }).toBe(true);
  await expect.poll(() => f.host.supervisor.owns(f.binding())).toBe(false); commit.mockRestore();
  const receipt = f.host.journal.publishRetainedResult(f.binding(), { summary: "Metadata-only command repair", validation: "passed", validation_failures: [] });
  expect(receipt.stages.map(stage => stage.stage)).toEqual(["preflight", "execution", "validation", "postcondition"]); expect(receipt.action_checks).toMatchObject({ preflight: { passed: false }, postcondition: { passed: false } });
  const { result } = await f.finish(accepted); expect(result.outcome).toEqual({ ok: true, value: {} });
  expect(result.action_checks).toMatchObject({ preflight: { passed: false }, postcondition: { passed: false } });
  expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("probemainpost");
});
it.each(["preflight", "postcondition"] as const)("command stages: a timed-out %s remains UNKNOWN and holds capacity until group cessation", async stage => {
  const f = await fixture("printf main >> effects; printf '{}'", { budget: 12000, commands: { [stage]: { command: "trap '' TERM; printf probe >> effects; while :; do :; done", timeout_ms: 200 } } });
  const accepted = await f.service().submit(f.request, "alice");
  await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return existsSync(join(f.workspace, "effects")); }).toBe(true);
  const reservation = f.host.journal.retainedStart(f.binding())!.resources.host_reservation!;
  expect(f.broker.inspect(reservation)?.state).toBe("held");
  const { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} }); expect(result.action_checks?.[stage]).toMatchObject({ passed: false, unknown: true, detail: "command timed out" });
  expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe(stage === "preflight" ? "probemain" : "mainprobe"); expect(f.broker.inspect(reservation)?.state).toBe("released");
});
it.each(["preflight", "postcondition"] as const)("command stages: a surviving %s descendant retains occupancy until proven cessation without repeating main", async stage => {
  const program = 'process.on("SIGTERM",()=>{});process.getBuiltinModule("node:fs").writeFileSync("descendant.pid",String(process.pid));setInterval(()=>{},1000)';
  const command = `printf '%s' $$ > root.pid; ${JSON.stringify(process.execPath)} --eval '${program}' </dev/null >/dev/null 2>&1 &
while [ ! -f descendant.pid ]; do /bin/sleep .01; done
while [ ! -f exit-root ]; do /bin/sleep .01; done
:`;
  const f = await fixture("printf main >> effects; printf '{}'", { budget: 20000, commands: { [stage]: { command, timeout_ms: 15000 } } });
  let descendant: NativeIdentity | undefined, root: NativeIdentity | undefined, guardian: NativeIdentity | undefined;
  const diagnostics = process.env.BARRY_WORK_SURVIVOR_DIAGNOSTICS === "1", began = performance.now();
  const traces: Record<string, unknown>[] = [], diagnosticSpies: { mockRestore(): void }[] = [];
  const anchors = new Map<string, { first: Record<string, unknown>; latest: Record<string, unknown>; count: number }>();
  const anchorPhases = new Set(["accepted", "before-root-absence-wait", "after-root-absence-wait", "owner-before-finish",
    "rpc-complete-before", "rpc-complete-after", "rpc-complete-error", "owner-after-complete", "finish-returned", "all-assertions-passed",
    "failure", "owner-at-failure", "executor-at-failure", "native-at-failure", "after-cleanup"]);
  let droppedTraces = 0;
  let acceptedIds: { work_id: string; workflow_id: string } | undefined, finalEvidence: unknown;
  const detail = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
  const trace = (phase: string, data: Record<string, unknown> = {}) => {
    if (!diagnostics) return;
    if (traces.length >= 200) { traces.shift();droppedTraces++; }
    const entry = { phase, wall: Date.now(), elapsed: performance.now() - began, ...data };
    traces.push(entry);
    if (anchorPhases.has(phase)) {
      const retained = anchors.get(phase);
      if (retained) { retained.latest = entry;retained.count++; }
      else if (anchors.size < 32) anchors.set(phase, { first: entry, latest: entry, count: 1 });
    }
  };
  const rows = (name: string, sql: string, ...parameters: string[]) => {
    const db = new SqliteDatabase(join(f.root, name));
    try { return db.prepare(sql).all(...parameters); } finally { db.close(); }
  };
  const ownerState = () => {
    if (!acceptedIds) return { accepted: false };
    const id = acceptedIds.workflow_id;
    return { result: f.owner.workResult({ kind: "installation", installation: "owner" }, acceptedIds.work_id),
      work: f.owner.workById(f.authority.namespace, acceptedIds.work_id),
      run: rows("owner.db", "SELECT * FROM workflow_runs WHERE id=?", id),
      commands: rows("owner.db", "SELECT * FROM workflow_commands WHERE run_id=? LIMIT 10", id),
      attempts: rows("owner.db", "SELECT a.* FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=? LIMIT 10", id),
      grants: rows("owner.db", "SELECT * FROM workflow_work_grants WHERE run_id=? LIMIT 10", id),
      executions: rows("owner.db", "SELECT * FROM workflow_work_executions WHERE run_id=? LIMIT 10", id),
      history: f.owner.inspect(id),
    };
  };
  if (diagnostics) {
    const heartbeat = f.client.heartbeat.bind(f.client);
    diagnosticSpies.push(vi.spyOn(f.client, "heartbeat").mockImplementation(async token => {
      trace("rpc-heartbeat-before", { token });
      try { const result = await heartbeat(token);trace("rpc-heartbeat-after", { token, result });return result; }
      catch (error) { trace("rpc-heartbeat-error", { token, error: detail(error) });throw error; }
    }));
    const complete = f.client.complete.bind(f.client);
    diagnosticSpies.push(vi.spyOn(f.client, "complete").mockImplementation(async (token, receipt) => {
      trace("rpc-complete-before", { token, receipt });
      try {
        const result = await complete(token, receipt);trace("rpc-complete-after", { token, result });
        try { trace("owner-after-complete", ownerState()); } catch (error) { trace("owner-after-complete-observation-error", { error: detail(error) }); }
        return result;
      } catch (error) { trace("rpc-complete-error", { token, error: detail(error) });throw error; }
    }));
    const inspect = f.client.inspect.bind(f.client);
    diagnosticSpies.push(vi.spyOn(f.client, "inspect").mockImplementation(async token => {
      trace("rpc-inspect-before", { token });
      try { const result = await inspect(token);trace("rpc-inspect-after", { token, result });return result; }
      catch (error) { trace("rpc-inspect-error", { token, error: detail(error) });throw error; }
    }));
    const observe = f.client.observe.bind(f.client);
    diagnosticSpies.push(vi.spyOn(f.client, "observe").mockImplementation(async (token, observation) => {
      trace("rpc-observe-before", { token, observation });
      try { const result = await observe(token, observation);trace("rpc-observe-after", { token, result });return result; }
      catch (error) { trace("rpc-observe-error", { token, error: detail(error) });throw error; }
    }));
  }
  const actual = ProcessExecutor.prototype.supervisedCommand, evidence: { code: number | null; signal: string | null; spawn_failed: boolean }[] = [];
  const observed = vi.spyOn(ProcessExecutor.prototype, "supervisedCommand").mockImplementation(function (this: ProcessExecutor, artifact, task, declaration, signal, observer) {
    trace("native-command-entry", { task, declaration });
    return actual.call(this, artifact, task, declaration, signal, { ...observer,
      ...(diagnostics ? { beforeInput: async (pid: number) => {
        trace("native-before-input", { pid });
        try { await observer.beforeInput(pid);trace("native-after-input-authority", { pid }); }
        catch (error) { trace("native-before-input-error", { pid, error: detail(error) });throw error; }
      } } : {}),
      closed: value => {
        trace("native-closed", { ...value, output: value.output.subarray(0, 2048).toString("utf8"), output_bytes: value.output.length });
        if (value.command) evidence.push(value.command);observer.closed(value);
      },
    });
  });
  try {
    const accepted = await f.service().submit(f.request, "alice");
    acceptedIds = { work_id: accepted.work_id, workflow_id: accepted.workflow_id };trace("accepted", { accepted });
    await expect.poll(async () => { await f.owner.pump();await f.host.worker.tick();return existsSync(join(f.workspace, "descendant.pid")); }, { timeout: 10000 }).toBe(true);
    descendant = nativeIdentity(Number(readFileSync(join(f.workspace, "descendant.pid"), "utf8")));
    root = nativeIdentity(Number(readFileSync(join(f.workspace, "root.pid"), "utf8")));
    const binding = f.binding(), handle = f.host.journal.inspect(binding)!.handle!;
    if (handle.kind !== "process" || !handle.pid) throw new Error("Missing captured fixture guardian");
    guardian = nativeIdentity(handle.pid);expect(guardian.pgid).toBe(guardian.pid);
    expect(root.pgid).toBe(guardian.pgid);expect(descendant.pgid).toBe(guardian.pgid);
    const reservation = f.host.journal.retainedStart(binding)!.resources.host_reservation!;
    writeFileSync(join(f.workspace, "exit-root"), "exit");
    if (diagnostics) {
      try { trace("before-root-absence-wait", ownerState()); } catch (error) { trace("before-root-wait-observation-error", { error: detail(error) }); }
    }
    await expect.poll(() => nativePresent(root!.pid)).toBe(false);
    if (diagnostics) {
      try { trace("after-root-absence-wait", ownerState()); } catch (error) { trace("after-root-wait-observation-error", { error: detail(error) }); }
    }
    // The root's known zero verdict cannot release capacity while its actual
    // TERM-resistant detached-stdio child is still executing.
    expect(sameNative(descendant)).toBe(true);expect(f.broker.inspect(reservation)?.state).toBe("held");
    expect(f.host.journal.receipt(binding)).toBeNull();
    expect(existsSync(join(f.workspace, "effects"))).toBe(stage === "postcondition");
    if (stage === "postcondition") expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("main");
    if (diagnostics) {
      try { trace("owner-before-finish", ownerState()); } catch (error) { trace("before-finish-observation-error", { error: detail(error) }); }
    }
    const { receipt, result } = await f.finish(accepted);
    finalEvidence = { receipt, result };trace("finish-returned", { receipt, result });
    expect(nativePresent(descendant.pid)).toBe(false);expect(nativePresent(-guardian.pgid)).toBe(false);
    expect(receipt.physical_state).toBe("ceased");expect(result.outcome).toEqual({ ok: true, value: {} });
    expect(result.action_checks?.[stage]).toMatchObject({ passed: true, unknown: false });
    expect(evidence).toContainEqual({ code: 0, signal: null, spawn_failed: false });
    expect(f.broker.inspect(reservation)?.state).toBe("released");expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("main");
    const replay = await f.service().submit(f.request, "alice");expect(replay.work_id).toBe(accepted.work_id);
    await f.finish(replay);expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("main");expect(f.errors).toEqual([]);
    const directory = diagnostics ? process.env.BARRY_WORK_SURVIVOR_DIAGNOSTICS_DIR : undefined;
    if (directory) {
      try {
        if (!isAbsolute(directory)) throw new Error("Survivor diagnostic directory must be absolute");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const info = lstatSync(directory);
        if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0
          || process.getuid && info.uid !== process.getuid() || realpathSync(directory) !== directory)
          throw new Error("Survivor diagnostic directory must be canonical, private and owned by the current user");
        if (!/^[A-Za-z0-9_-]+$/.test(accepted.work_id)) throw new Error("Unexpected diagnostic Work identifier");
        trace("all-assertions-passed");
        const path = join(directory, `${stage}-${accepted.work_id}.json`);
        writeFileSync(path, JSON.stringify({ status: "passed", node: process.execPath, version: process.version, root: f.root, stage,
          acceptedIds, finalEvidence, evidence, anchors: Object.fromEntries(anchors), droppedTraces, traces }, null, 2), { flag: "wx", mode: 0o600 });
      } catch (failure) {
        trace("success-diagnostic-persistence-error", { error: detail(failure) });
        console.error("survivor success diagnostic persistence failed", detail(failure));
      }
    }
  } catch (error) {
    if (diagnostics) {
      trace("failure", { error: detail(error), acceptedIds, finalEvidence, evidence, errors: f.errors.map(detail) });
      try { trace("owner-at-failure", ownerState()); } catch (failure) { trace("owner-state-error", { error: detail(failure) }); }
      try {
        const binding = f.binding(acceptedIds?.work_id), start = f.host.journal.retainedStart(binding);
        trace("executor-at-failure", { binding, start, observation: f.host.journal.inspect(binding), stages: f.host.journal.stageReceipts(binding),
          receipt: f.host.journal.receipt(binding), pendingDeliveryCount: f.host.journal.pendingDeliveryCount(),
          executions: rows("executor.db", "SELECT * FROM executions LIMIT 10"),
          receipts: rows("executor.db", "SELECT * FROM execution_receipts LIMIT 10"),
          deliveries: rows("executor.db", "SELECT * FROM execution_deliveries LIMIT 10"),
          reservation: start?.resources.host_reservation ? f.broker.inspect(start.resources.host_reservation) : null });
      } catch (failure) { trace("executor-state-error", { error: detail(failure) }); }
      try {
        const pids = new Set([process.pid, root?.pid, descendant?.pid, guardian?.pid].filter(pid => pid !== undefined).map(String));
        const nativeRows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,lstart=,command="], { encoding: "utf8", timeout: 1000, maxBuffer: 4194304 }).split("\n")
          .filter(line => { const fields = line.trim().split(/\s+/);return pids.has(fields[0]) || guardian && fields[2] === String(guardian.pgid); });
        trace("native-at-failure", { root, descendant, guardian, rows: nativeRows });
      } catch (failure) { trace("native-state-error", { error: detail(failure) }); }
      const persist = () => writeFileSync(join(f.root, "survivor-diagnostic.json"), JSON.stringify({ node: process.execPath, version: process.version, root: f.root, stage, anchors: Object.fromEntries(anchors), droppedTraces, traces }, null, 2), { mode: 0o600 });
      retainedDiagnostics.set(f.root, () => { try { trace("after-cleanup");persist(); } catch (failure) { console.error("survivor diagnostic finalization failed", detail(failure)); } });
      try {
        if (existsSync(f.processTempRoot)) cpSync(f.processTempRoot, join(f.root, "diagnostic-process-temp"), { recursive: true });
        // Pre-cleanup crash-state copies, not a coherent online SQLite backup.
        for (const name of ["owner.db", "executor.db", "broker.db"]) for (const suffix of ["", "-wal", "-shm"]) {
          const source = join(f.root, name + suffix);
          if (existsSync(source)) copyFileSync(source, join(f.root, "diagnostic-raw-" + name + suffix));
        }
      } catch (failure) { trace("snapshot-error", { error: detail(failure) }); }
      try { persist();console.error("survivor failure diagnostic retained", f.root); }
      catch (failure) { console.error("survivor diagnostic persistence failed", detail(failure)); }
    }
    throw error;
  } finally {
    observed.mockRestore();for (const spy of diagnosticSpies.reverse()) spy.mockRestore();
    await cleanupNative(root);await cleanupNative(descendant);
  }
}, 30000);
it("command stages: stdout budget failure is UNKNOWN rather than a passing probe", async () => {
  const f = await fixture("printf '{}'", { commands: { preflight: { command: "i=0; while [ \"$i\" -lt 20000 ]; do printf '%070d\\n' \"$i\"; i=$((i+1)); done", timeout_ms: 4000 } } });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} });
  expect(result.action_checks?.preflight).toMatchObject({ passed: false, unknown: true, detail: "command output exceeded 1 MiB" });
});
it("command stages: preflight consumes the original execution budget and cannot extend main launch", async () => {
  const f = await fixture("printf main > main-effect; printf '{}'", { budget: 2000, commands: { preflight: { command: "trap '' TERM; printf probe > probe-effect; while :; do :; done", timeout_ms: 10000 } } });
  await f.service().submit(f.request, "alice");
  await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return existsSync(join(f.workspace, "probe-effect")); }).toBe(true);
  const receipt = await f.host.supervisor.wait(f.binding());
  expect(receipt).toMatchObject({ outcome: "timed-out", physical_state: "ceased" });
  expect(receipt?.stages.map(stage => stage.stage)).toEqual(["preflight"]); expect(existsSync(join(f.workspace, "main-effect"))).toBe(false);
});
it("command stages: an owned pipeline retains its capacity-one slot while awaiting postcondition authority", async () => {
  let otherCapacity = -1;
  const f = await fixture("printf main >> effects; printf '{}'", { otherCapacity: value => { otherCapacity = value; }, commands: { postcondition: { command: "printf post >> effects" } } });
  let held = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const begin = f.client.begin.bind(f.client);
  vi.spyOn(f.client, "begin").mockImplementation(async token => {
    const permit = await begin(token);
    if (!held && existsSync(join(f.workspace, "effects")) && f.host.journal.stageReceipts(f.binding()).some(stage => stage.stage === "validation" && stage.state === "passed")) { held = true; await gate; }
    return permit;
  });
  try {
    const first = await f.service().submit(f.request, "alice");
    await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return held; }, { timeout: 10000 }).toBe(true);
    const second = await f.service().submit({ ...f.request, request_id: "b08a5c13-8996-4ab8-b7ae-638626ffaf23", idempotency_key: "second-command-pipeline" }, "alice");
    for (let index = 0; index < 20; index++) { await f.owner.pump(); await f.host.worker.tick(); }
    expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("main"); expect(otherCapacity).toBe(0);
    release(); await f.finish(first); await f.finish(second);
    expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("mainpostmainpost");
    await expect.poll(async () => { await f.host.worker.tick(); return otherCapacity; }, { timeout: 1000 }).toBe(1);
  } finally { release(); }
});
it("process program: native shell preserves cwd, JSON stdin, explicit env, action identity and isolated validation", async () => {
  vi.stubEnv("BARRY_SECRET", "ambient-installation-credential"); cleanup.push(() => vi.unstubAllEnvs());
  const f = await fixture(`test "$PWD" -ef "$BARRY_ACTION_DIR" || exit 3
test "$DECLARED" = explicit || exit 4
test -z "$BARRY_SECRET" || exit 5
test "$BARRY_ACTION_INPUTS" = "$(cat)" || exit 6
printf '{"id":"%s","key":"%s"}' "$BARRY_ACTION_RUN_ID" "$BARRY_JOB_KEY"
`);
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(receipt, JSON.stringify({ summary: receipt.summary, logs: result.logs })).toMatchObject({ outcome: "complete", physical_state: "ceased", validation: "passed" });
  expect(result.outcome).toMatchObject({ ok: true, value: { id: accepted.action_id, key: logicalStageEffectKey("owner", f.binding().workflow_id, f.binding().activity_id, "execution") } });
  expect(f.errors).toEqual([]);
});
it("process program: retained source executes after its original path changes", async () => {
  const f = await fixture("printf '{\"original\":true}'"); const accepted = await f.service().submit(f.request, "alice");
  writeFileSync(f.job.path, "printf '{\"mutated\":true}'");
  const { result } = await f.finish(accepted); expect(result.outcome).toEqual({ ok: true, value: { original: true } });
});
it("process program: native command and ordinary text-tail output remain available", async () => {
  const f = await fixture("", { native: true, schema: null }), accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: "native process" }); expect(result.logs?.[0]?.value?.stdout).toBe("native process\n");
});
it("process program: selected secrets are resolved at execution and never enter retained permits", async () => {
  const f = await fixture(`test -n "$DECLARED_SECRET" || exit 4; printf '{}'`, { secret: "expected-owner-value" });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} });
  expect(JSON.stringify(f.host.journal.retainedStart(f.binding()))).not.toContain("expected-owner-value");
});
it("process program: unavailable selected secrets cannot fall back to ambient credentials", async () => {
  const f = await fixture("printf '{}'", { secret: "missing", noSecretResolver: true }), accepted = await f.service().submit(f.request, "alice"), { receipt } = await f.finish(accepted);
  expect(receipt.failure?.code).toBe("ProcessCredentialsUnavailable"); expect(receipt.physical_state).toBe("ceased");
  expect(f.broker.inspect(f.host.journal.retainedStart(f.binding())!.resources.host_reservation!)?.state).toBe("released");
});

it("process program: a replaced live cwd cannot receive application input", async () => {
  const f = await fixture("printf ran > marker; printf '{}'"), accepted = await f.service().submit(f.request, "alice");
  renameSync(f.workspace, join(f.root, "old-workspace")); mkdirSync(f.workspace);
  const { receipt } = await f.finish(accepted);
  expect(receipt).toMatchObject({ outcome: "failed", physical_state: "ceased", effect_certainty: "known", failure: { code: "WorkWorkspaceChanged" } });
  expect(existsSync(join(f.workspace, "marker"))).toBe(false); expect(existsSync(join(f.root, "old-workspace", "marker"))).toBe(false);
});
it("process program: failed output validation and lost completion do not repeat a native effect", async () => {
  const f = await fixture("printf once >> marker; printf '{}'", { schema: { type: "number" } });
  const complete = f.client.complete.bind(f.client);
  vi.spyOn(f.client, "complete").mockImplementationOnce(async (token, receipt) => { await complete(token, receipt); throw new Error("native receipt reply lost"); });
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(receipt).toMatchObject({ outcome: "failed", validation: "failed", physical_state: "ceased" });
  expect(result.retained_output?.value).toEqual({}); expect(readFileSync(join(f.workspace, "marker"), "utf8")).toBe("once");
});
it.each([false, true])("process program: cancellation keeps capacity until actual TERM/KILL group cessation (ignore TERM=%s)", async ignoreTerm => {
  const source = ignoreTerm ? "trap '' TERM; printf ready > ready; while :; do :; done" : "trap 'printf flushed > flushed; sleep 1; exit 0' TERM; printf ready > ready; while :; do sleep .05; done";
  const f = await fixture(source, { budget: 15000 }), accepted = await f.service().submit(f.request, "alice");
  await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return existsSync(join(f.workspace, "ready")); }, { timeout: 10000 }).toBe(true);
  const reservation = f.host.journal.retainedStart(f.binding())!.resources.host_reservation!;
  f.owner.stopWork(accepted.work_id, { request_id: "5a9d6a2b-253e-4f4f-a797-73d99b318b7e", expected_revision: f.owner.workById(f.authority.namespace, accepted.work_id)!.revision }, "alice");
  await f.host.worker.tick(); expect(f.broker.inspect(reservation)?.state).toBe("held");
  const { receipt } = await f.finish(accepted);
  expect(receipt).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
  expect(f.broker.inspect(reservation)?.state).toBe("released");
  expect(readdirSync(f.processTempRoot, { recursive: true }).some(path => String(path).includes("program-"))).toBe(false);
  if (!ignoreTerm) expect(readFileSync(join(f.workspace, "flushed"), "utf8")).toBe("flushed");
});
it("process program: bounded, missing-tool and foreign-workspace declarations refuse before admission", async () => {
  const f = await fixture("printf '{}'");
  for (const change of ["bound", "tool", "host", "runtime", "input", "secret-owner"] as const) {
    const service = f.service(async request => {
      const value = structuredClone(f.resolution(request)), declaration = value.plan.process_program!;
      if (change === "secret-owner") { declaration.secret_names = ["SECRET"]; declaration.credential_owner = { kind: "installation", installation: "owner" }; }
      if (change === "host") declaration.installation = "another-host";
      if (change === "runtime") value.plan.source_closure = value.plan.source_closure.filter(ref => ref.digest !== declaration.runtime.digest);
      if (change === "input") value.workflow_input = {};
      if (change === "bound" || change === "tool") {
        const { fingerprint: _fingerprint, ...old } = declaration.scope;
        const scope = { ...old, ...(change === "bound" ? { bound: { files: { allow: [] } } } : { tools: {} }) };
        declaration.scope = { ...scope, fingerprint: boundFingerprint(scope) }; value.grant.effective_scope = declaration.scope; value.plan.grant_digest = boundFingerprint(value.grant);
      }
      return value;
    });
    await expect(service.submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedProcessProgram" });
  }
  expect(f.owner.listWork({ kind: "installation", installation: "owner" }, {}).total).toBe(0);
});

it("process program: a retained native binary executes after its original file is replaced", async () => {
  const f = await fixture("", { native: true, nativeCopy: true, schema: null }), accepted = await f.service().submit(f.request, "alice");
  expect(f.prepared.program.runtime_path).toBeUndefined();
  writeFileSync(f.job.path, "invalid executable"); const { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: null });
});
it("process program: executes JavaScript with a retained Node interpreter and a separately named source", async () => {
  const f = await fixture("const value=JSON.parse(process.getBuiltinModule('node:fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({value:value.value}));", {
    runtime: process.execPath, sourceName: "main.mjs", maxArtifactBytes: 192 * 1024 * 1024, budget: 30000 });
  const accepted = await f.service().submit(f.request, "alice"), { receipt, result } = await f.finish(accepted);
  expect(receipt, receipt.summary).toMatchObject({ outcome: "complete", validation: "passed", physical_state: "ceased" });
  expect(result.outcome).toEqual({ ok: true, value: { value: "script-result" } });
});
it("process program: missing declarations and fake system runtime mappings cannot use a module fallback", async () => {
  const f = await fixture("printf '{}'");
  await expect(f.service(async request => { const value = structuredClone(f.resolution(request)); delete value.plan.process_program; return value; }).submit(f.request, "alice")).rejects.toMatchObject({ code: "UnsupportedProcessProgram" });
  await expect(f.service(async request => { const value = structuredClone(f.resolution(request)); value.plan.process_program!.runtime_path = f.job.path; return value; }).submit(f.request, "alice")).rejects.toMatchObject({ code: "WorkRuntimeChanged" });
});
it.each(["module", "envelope", "bundle", "commands"] as const)("process program: older advertisements cannot claim unsupported %s", async feature => {
  const f = await fixture("printf '{}'", { envelope: feature !== "module", ...(feature === "bundle" ? { bundleFiles: {} } : {}), ...(feature === "commands" ? { commands: { preflight: { command: ":" } } } : {}) });
  const advertise = f.client.advertise.bind(f.client);
  vi.spyOn(f.client, "advertise").mockImplementation((advertisement, features) => advertise(advertisement, features && { ...features, features: features.features.filter(value => value !== (feature === "module" ? "process-program" : feature === "envelope" ? "process-program-envelope" : feature === "bundle" ? "process-program-bundle" : "action-command-stages")) }));
  await f.service().submit(f.request, "alice"); await f.owner.pump(); await f.host.worker.tick();
  const db = new SqliteDatabase(join(f.root, "owner.db"));
  try { expect(db.prepare("SELECT count(*) n FROM workflow_attempts").get()?.n).toBe(0); } finally { db.close(); }
});

it("process program: ordinary stdout keeps the legacy bounded text tail without killing verbose scripts", async () => {
  const f = await fixture("/usr/bin/yes ordinary-log | /usr/bin/head -c 400000; printf final-marker", { schema: null });
  const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome?.ok).toBe(true);
  if (result.outcome?.ok) { expect(String(result.outcome.value).length).toBe(4096); expect(String(result.outcome.value)).toMatch(/final-marker$/); }
  expect(result.logs?.[0]?.value?.stdout_bytes).toBe(400012); expect(result.logs?.[0]?.value?.stdout_truncated).toBe(true);
});

it("process program: stdin larger than a pipe buffer remains identical to the declared input environment", async () => {
  const f = await fixture(`test "$(cat)" = "$BARRY_ACTION_INPUTS" || exit 4; printf '{}'`);
  const request = { ...f.request, inputs: { value: "x".repeat(70000) } };
  const accepted = await f.service().submit(request, "alice"), { result } = await f.finish(accepted);
  expect(result.outcome).toEqual({ ok: true, value: {} });
});

it("process program: coordinated recovery preserves raw source, interpreter and bundled resources", async () => {
  const f = await fixture(`test "$(cat "$BARRY_ACTION_DIR/value.txt")" = preserved || exit 3; printf '{}'`, { envelope: true, bundleFiles: { "value.txt": "preserved" }, commands: { preflight: { command: ":" }, postcondition: { command: ":" } } }), accepted = await f.service().submit(f.request, "alice"); await f.finish(accepted);
  const { snapshotWorkflows, restoreWorkflows } = await import("./recovery.js");
  const snapshot = join(f.root, "snapshot"), destination = join(f.root, "restored");
  const main = { path: f.artifacts.path(f.prepared.source), digest: f.prepared.source.digest, type: f.job.type, version: "activity", abi: f.wrapper.abi };
  await snapshotWorkflows(join(f.root, "owner.db"), snapshot, "owner", [f.wrapper, main], f.artifacts.root, { version: 1, components: [
    { id: "executor", role: "executor", identity: "owner", path: join(f.root, "executor.db"), workers: ["owner"], artifact_root: f.artifacts.root },
    { id: "broker", role: "broker", identity: "host", path: join(f.root, "broker.db") },
  ] });
  await restoreWorkflows(snapshot, destination, "owner", true, true);
  const owner = new WorkArtifactStore(join(destination, "work-artifacts")), executor = new WorkArtifactStore(join(destination, "work-recovery", "executor-artifacts"));
  cleanup.push(() => owner.close()); cleanup.push(() => executor.close());
  for (const artifact of f.prepared.sources) {
    expect(owner.verify(artifact)).toEqual(f.artifacts.verify(artifact)); expect(executor.verify(artifact)).toEqual(f.artifacts.verify(artifact));
  }
});

it("process program: actual guardian loss retains private files and capacity before and after an unknown descendant ceases", async () => {
  const program = 'process.on("SIGTERM",()=>{});const fs=process.getBuiltinModule("node:fs");fs.writeFileSync("descendant.pid",String(process.pid));const timer=setInterval(()=>{if(fs.existsSync("exit-root")){clearInterval(timer);setTimeout(()=>{fs.writeFileSync("descendant-finished","done");process.exit(0)},2500)}},10)';
  const source = `printf '%s' $$ > root.pid; ${JSON.stringify(process.execPath)} --eval '${program}' </dev/null >/dev/null 2>&1 &
while [ ! -f descendant.pid ]; do /bin/sleep .01; done
while [ ! -f exit-root ]; do /bin/sleep .01; done
printf '{}'`;
  const f = await fixture(source), accepted = await f.service().submit(f.request, "alice");
  let descendant: NativeIdentity | undefined, root: NativeIdentity | undefined, guardian: NativeIdentity | undefined;
  try {
    await expect.poll(async () => { await f.owner.pump();await f.host.worker.tick();return existsSync(join(f.workspace, "descendant.pid")); }, { timeout: 10000 }).toBe(true);
    descendant = nativeIdentity(Number(readFileSync(join(f.workspace, "descendant.pid"), "utf8")));
    root = nativeIdentity(Number(readFileSync(join(f.workspace, "root.pid"), "utf8")));
    const binding = f.binding(), handle = f.host.journal.inspect(binding)!.handle!;
    if (handle.kind !== "process" || !handle.pid) throw new Error("Missing captured fixture guardian");
    guardian = nativeIdentity(handle.pid);expect(guardian.pgid).toBe(guardian.pid);
    expect(root.pgid).toBe(guardian.pgid);expect(descendant.pgid).toBe(guardian.pgid);
    const reservation = f.host.journal.retainedStart(binding)!.resources.host_reservation!;
    writeFileSync(join(f.workspace, "exit-root"), "exit");
    await expect.poll(() => nativePresent(root!.pid)).toBe(false);
    expect(sameNative(descendant)).toBe(true);expect(sameNative(guardian)).toBe(true);
    // Kill only the freshly revalidated live guardian. Its unknown surviving
    // group must never be signaled through a recovered numeric PGID.
    process.kill(guardian.pid, "SIGKILL");
    await expect.poll(async () => { await f.owner.pump();await f.host.worker.tick();return f.errors.some(error => String(error).includes("cessation is not proven")); }, { timeout: 5000 }).toBe(true);
    expect(sameNative(descendant)).toBe(true);expect(f.broker.inspect(reservation)?.state).toBe("held");
    expect(f.host.journal.receipt(binding)).toBeNull();
    const privateFiles = () => readdirSync(f.processTempRoot, { recursive: true }).some(path => String(path).includes("program-"));
    expect(privateFiles()).toBe(true);expect(f.owner.workById(f.authority.namespace, accepted.work_id)!.facts.has_result).toBe(false);
    await expect.poll(() => existsSync(join(f.workspace, "descendant-finished")), { timeout: 5000 }).toBe(true);
    await expect.poll(() => nativePresent(descendant!.pid), { timeout: 5000 }).toBe(false);
    for (let tick = 0; tick < 3; tick++) { await f.owner.pump();await f.host.worker.tick(); }
    await f.host.close();
    // Later native absence is not an authenticated recovery receipt and cannot
    // retroactively release the retained unknown fence or discard private data.
    expect(privateFiles()).toBe(true);expect(f.broker.inspect(reservation)?.state).toBe("held");
    const persisted = new SqliteDatabase(join(f.root, "executor.db"));
    try { expect(persisted.prepare("SELECT COUNT(*) AS count FROM execution_receipts").get()).toEqual({ count: 0 }); } finally { persisted.close(); }
    expect(f.owner.workById(f.authority.namespace, accepted.work_id)!.facts.has_result).toBe(false);
  } finally { await cleanupNative(root);await cleanupNative(descendant); }
}, 20000);

it.each(["execution", "preflight", "postcondition"] as const)("review R2-1: %s stop, deadline and drain retain escalation through leader exit", async stage => {
  for (const trigger of ["stop", "deadline", "drain"] as const) {
    const descendantProgram = 'process.on("SIGTERM",()=>{});process.getBuiltinModule("node:fs").writeFileSync("descendant.pid",String(process.pid));setInterval(()=>{},1000)';
    const script = `${JSON.stringify(process.execPath)} --eval '${descendantProgram}' </dev/null >/dev/null 2>&1 &\ntrap 'exit 0' TERM\nwhile :; do /bin/sleep 0.1; done`;
    const f = await fixture(stage === "execution" ? script : "printf main >> effects; printf '{}'", {
      budget: trigger === "deadline" ? 2000 : 20000, schema: stage === "execution" ? null : undefined,
      ...(stage === "execution" ? {} : { commands: { [stage]: { command: script, timeout_ms: 15000 } } }),
    });
    let descendant: number | undefined;
    const alive = () => { try { if (!descendant) return false; process.kill(descendant, 0); return true; } catch { return false; } };
    try {
      await f.service().submit(f.request, "alice");
      // The fixed invocation deadline may expire during earlier stages. That
      // is valid settlement, not evidence that a postcondition child launched.
      await expect.poll(async () => {
        await f.owner.pump(); await f.host.worker.tick();
        return existsSync(join(f.workspace, "descendant.pid")) || trigger === "deadline" && f.host.journal.receipt(f.binding()) !== null;
      }, { timeout: 10000 }).toBe(true);
      if (!existsSync(join(f.workspace, "descendant.pid"))) {
        const binding = f.binding(), receipt = f.host.journal.receipt(binding)!;
        expect(trigger).toBe("deadline"); expect(Date.now()).toBeGreaterThanOrEqual(binding.deadline);
        expect(receipt.physical_state).toBe("ceased");
        expect(receipt.outcome).toBe(stage === "execution" && receipt.effect_certainty === "uncertain" ? "uncertain" : "timed-out");
        expect(f.host.journal.stageReceipts(binding).filter(value => value.stage === "execution").length).toBeLessThanOrEqual(1);
        expect(f.host.journal.stageReceipts(binding).some(value => value.stage === "postcondition" && value.state === "passed")).toBe(false);
        const reservation = f.host.journal.retainedStart(binding)!.resources.host_reservation!;
        await expect.poll(async () => { await f.host.worker.tick(); return f.broker.inspect(reservation)?.state; }, { timeout: 5000 }).toBe("released");
        console.log("R2-1 deadline settled before descendant readiness", { stage, stages: receipt.stages.map(value => ({ stage: value.stage, state: value.state })), outcome: receipt.outcome });
        continue;
      }
      descendant = Number(readFileSync(join(f.workspace, "descendant.pid"), "utf8"));
      const binding = f.binding(), reservation = f.host.journal.retainedStart(binding)!.resources.host_reservation!;
      let draining: Promise<void> | undefined;
      if (trigger === "stop") f.host.supervisor.cancel(binding);
      if (trigger === "drain") draining = f.host.supervisor.close();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(alive()).toBe(true); expect(f.broker.inspect(reservation)?.state).toBe("held"); expect(f.host.journal.receipt(binding)).toBeNull();
      const receipt = await f.host.supervisor.wait(binding); await draining;
      if (alive()) {
        let processState: string;
        try { processState = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,state=,command=", "-p", String(descendant)], { encoding: "utf8" }); }
        catch (error) { processState = String(error); }
        console.error("R2-1 descendant still observed after supervisor wait", JSON.stringify({ stage, trigger, processState, receipt,
          observation: f.host.journal.inspect(binding), stages: f.host.journal.stageReceipts(binding), errors: f.errors.map(String) }));
      }
      expect(alive()).toBe(false); expect(receipt?.physical_state).toBe("ceased");
      expect(receipt?.outcome).toBe(stage === "execution" ? "uncertain" : trigger === "deadline" ? "timed-out" : "cancelled");
      expect(f.host.journal.stageReceipts(binding).filter(value => value.stage === "execution")).toHaveLength(stage === "preflight" ? 0 : 1);
      if (stage !== "execution") expect(existsSync(join(f.workspace, "effects"))).toBe(stage === "postcondition");
      await f.owner.pump(); await f.host.worker.tick();
      expect(f.host.journal.receipt(binding)?.receipt_digest).toBe(receipt?.receipt_digest);
      await expect.poll(async () => { await f.host.worker.tick(); return f.broker.inspect(reservation)?.state; }, { timeout: 5000 }).toBe("released");
      if (stage === "postcondition") expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("main");
    } finally {
      if (alive()) process.kill(descendant!, "SIGKILL");
      await expect.poll(alive, { timeout: 5000 }).toBe(false);
    }
  }
}, 40000);

it("command stages: native command budget starts after fresh authority and guardian startup", async () => {
  const f = await fixture("printf main >> effects; printf '{}'", { commands: { preflight: { command: "printf probe >> effects", timeout_ms: 1000 } } });
  // Keep recurrence evidence without successful-path console/native probing.
  // A prior broad run stalled here; passing diagnostics did not explain it.
  const began = performance.now(), traces: Record<string, unknown>[] = [];
  const trace = (phase: string, detail: Record<string, unknown> = {}) => traces.push({ phase, wall: Date.now(), elapsed: performance.now() - began, ...detail });
  const errorDetail = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
  let guardianPid: number | undefined, commandFinished = false, testFinished = false, watchdog: ReturnType<typeof setTimeout> | undefined;
  const nativeState = () => {
    const state: Record<string, unknown> = { parent: process.pid, guardianPid };
    try {
      state.rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state=,lstart=,command="], { encoding: "utf8", timeout: 1000, maxBuffer: 4194304 }).split("\n")
        .filter(line => { const fields = line.trim().split(/\s+/);return fields[0] === String(process.pid) || fields[0] === String(guardianPid) || fields[2] === String(guardianPid); });
    } catch (error) { state.psError = errorDetail(error); }
    if (guardianPid) try { state.fds = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(guardianPid), "-d", "0-4", "-Fn"], { encoding: "utf8", timeout: 1000, maxBuffer: 65536 }); }
    catch (error) { state.fdError = errorDetail(error); }
    return state;
  };
  const persist = () => writeFileSync(join(f.root, "delayed-input-diagnostic.json"), JSON.stringify({ node: process.execPath, version: process.version, root: f.root, traces }, null, 2), { mode: 0o600 });
  const command = ProcessExecutor.prototype.supervisedCommand;
  const delayedInput = vi.spyOn(ProcessExecutor.prototype, "supervisedCommand").mockImplementation(function (this: ProcessExecutor, artifact, task, declaration, signal, observer) {
    trace("command-entry", { deadline: task.work?.deadline });
    return command.call(this, artifact, task, declaration, signal, { ...observer, beforeInput: async pid => {
      guardianPid = pid;trace("authority-before", { pid });
      try { await observer.beforeInput(pid);trace("authority-after"); }
      catch (error) { trace("authority-rejected", errorDetail(error));throw error; }
      // Delay a real guardian after durable handle/authority, before releasing
      // application input, longer than the declared native command budget.
      trace("gate-scheduled");
      await new Promise(done => setTimeout(done, 2000));
      trace("gate-fired");
      // A printf command still pending three seconds after input is overdue.
      // Observe only; never signal a PID obtained from diagnostic metadata.
      if (!testFinished) watchdog = setTimeout(() => { if (!commandFinished) trace("overdue-native-state", nativeState()); }, 3000).unref();
    }, closed: evidence => {
      trace("closed", { ...evidence, output: evidence.output.toString("utf8") });observer.closed(evidence);
    } }).then(report => { commandFinished = true;clearTimeout(watchdog);trace("command-return", { report });return report; }, error => {
      commandFinished = true;clearTimeout(watchdog);trace("command-rejected", errorDetail(error));throw error;
    });
  });
  try {
    const accepted = await f.service().submit(f.request, "alice"), { result } = await f.finish(accepted);
    expect(result.action_checks?.preflight).toMatchObject({ passed: true, unknown: false });
    expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("probemain");
  } catch (error) {
    try {
      console.error("delayed guardian input failure", JSON.stringify({ observation: f.host.journal.inspect(f.binding()), stages: f.host.journal.stageReceipts(f.binding()), errors: f.errors.map(String) }));
      trace("failure", { error: errorDetail(error), native: nativeState() });
    } catch (failure) { trace("observation-error", errorDetail(failure)); }
    // Keep actual pre-cleanup state; ordinary host/owner drain still runs.
    // Diagnostics must never replace the original assertion failure.
    retainedDiagnostics.set(f.root, () => { try { trace("after-cleanup");persist(); } catch (failure) { console.error("delayed input diagnostic finalization failed", errorDetail(failure)); } });
    try {
      if (existsSync(f.processTempRoot)) cpSync(f.processTempRoot, join(f.root, "diagnostic-process-temp"), { recursive: true });
      // Raw DB/WAL/SHM copies are crash-state diagnostics, not a verified
      // online backup. Avoid an unbounded asynchronous backup in a failed test.
      for (const name of ["owner.db", "executor.db", "broker.db"]) for (const suffix of ["", "-wal", "-shm"]) {
        const source = join(f.root, name + suffix);
        if (existsSync(source)) copyFileSync(source, join(f.root, "diagnostic-raw-" + name + suffix));
      }
    } catch (failure) { trace("snapshot-error", errorDetail(failure)); }
    try { persist();console.error("delayed input diagnostic retained", f.root); }
    catch (failure) { console.error("delayed input diagnostic failed", errorDetail(failure)); }
    throw error;
  } finally { testFinished = true;clearTimeout(watchdog);delayedInput.mockRestore(); }
});

it("empty peer claim probes do not advertise away an otherwise idle owner's capacity", async () => {
  let release!: () => void, probing = false;
  const gate = new Promise<void>(done => { release = done; });
  const f = await fixture("printf '{}'", { otherCapacity: () => {}, otherClaim: async () => { probing = true; await gate; return null; } });
  const ads = vi.spyOn(f.client, "advertise");
  try {
    await expect.poll(async () => { await f.host.worker.tick(); return probing; }).toBe(true);
    for (let index = 0; index < 8; index++) await f.host.worker.tick();
    expect(ads.mock.calls.at(-1)?.[0].capacity).toBe(1);
    release();
    const accepted = await f.service().submit(f.request, "alice");
    expect((await f.finish(accepted)).result.outcome).toEqual({ ok: true, value: {} });
  } finally { release(); }
});

it.each(["preflight", "postcondition"] as const)("review R2-1: %s command deadline kills a ready TERM-resistant descendant without repeating main", async stage => {
  const program = 'process.on("SIGTERM",()=>{});process.getBuiltinModule("node:fs").writeFileSync("descendant.pid",String(process.pid));setInterval(()=>{},1000)';
  const command = `${JSON.stringify(process.execPath)} --eval '${program}' </dev/null >/dev/null 2>&1 &\ntrap 'exit 0' TERM\nwhile :; do /bin/sleep 0.1; done`;
  const f = await fixture("printf main >> effects; printf '{}'", { budget: 20000, commands: { [stage]: { command, timeout_ms: 2000 } } });
  let descendant: number | undefined;
  const alive = () => { try { if (!descendant) return false; process.kill(descendant, 0); return true; } catch { return false; } };
  try {
    const accepted = await f.service().submit(f.request, "alice");
    await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return existsSync(join(f.workspace, "descendant.pid")); }, { timeout: 10000 }).toBe(true);
    descendant = Number(readFileSync(join(f.workspace, "descendant.pid"), "utf8"));
    const reservation = f.host.journal.retainedStart(f.binding())!.resources.host_reservation!;
    expect(alive()).toBe(true); expect(f.broker.inspect(reservation)?.state).toBe("held"); expect(f.host.journal.receipt(f.binding())).toBeNull();
    const { receipt, result } = await f.finish(accepted);
    expect(alive()).toBe(false); expect(receipt.physical_state).toBe("ceased");
    expect(result.outcome).toEqual({ ok: true, value: {} });
    expect(result.action_checks?.[stage]).toMatchObject({ passed: false, unknown: true, detail: "command timed out" });
    expect(readFileSync(join(f.workspace, "effects"), "utf8")).toBe("main");
    expect(f.broker.inspect(reservation)?.state).toBe("released");
  } finally {
    if (alive()) process.kill(descendant!, "SIGKILL");
    await expect.poll(alive, { timeout: 5000 }).toBe(false);
  }
}, 40000);

it.each(["execution", "preflight"] as const)("guardian shutdown acknowledgement precedes group TERM for %s", async stage => {
  const program = 'process.on("SIGTERM",()=>{});process.getBuiltinModule("node:fs").writeFileSync("descendant.pid",String(process.pid));setInterval(()=>{},1000)';
  const script = `${JSON.stringify(process.execPath)} --eval '${program}' </dev/null >/dev/null 2>&1 &\ntrap 'exit 0' TERM\nwhile :; do /bin/sleep 0.1; done`;
  const f = await fixture(stage === "execution" ? script : "printf '{}'", { budget: 20000, schema: null,
    ...(stage === "execution" ? {} : { commands: { preflight: { command: script, timeout_ms: 15000 } } }) });
  let guardian: number | undefined, descendant: number | undefined, suspended = false;
  const alive = () => { try { if (!descendant) return false; process.kill(descendant, 0); return true; } catch { return false; } };
  const signals = vi.spyOn(process, "kill");
  try {
    await f.service().submit(f.request, "alice");
    await expect.poll(async () => { await f.owner.pump(); await f.host.worker.tick(); return existsSync(join(f.workspace, "descendant.pid")); }, { timeout: 10000 }).toBe(true);
    descendant = Number(readFileSync(join(f.workspace, "descendant.pid"), "utf8"));
    const binding = f.binding(), handle = f.host.journal.inspect(binding)!.handle!;
    if (handle.kind !== "process") throw new Error("fixture did not retain a process handle"); guardian = handle.pid!;
    process.kill(guardian, "SIGSTOP"); suspended = true;
    await expect.poll(() => execFileSync("/bin/ps", ["-o", "state=", "-p", String(guardian)], { encoding: "utf8" }).trim().startsWith("T")).toBe(true);
    f.host.supervisor.cancel(binding);
    expect(signals.mock.calls.some(([pid, signal]) => pid === -guardian! && signal === "SIGTERM")).toBe(false);
    const reservation = f.host.journal.retainedStart(binding)!.resources.host_reservation!;
    expect(f.broker.inspect(reservation)?.state).toBe("held"); expect(f.host.journal.receipt(binding)).toBeNull();
    process.kill(guardian, "SIGCONT"); suspended = false;
    await expect.poll(() => signals.mock.calls.some(([pid, signal]) => pid === -guardian! && signal === "SIGTERM"), { timeout: 10000 }).toBe(true);
    expect((await f.host.supervisor.wait(binding))?.physical_state).toBe("ceased"); expect(alive()).toBe(false);
    await expect.poll(async () => { await f.host.worker.tick(); return f.broker.inspect(reservation)?.state; }, { timeout: 5000 }).toBe("released");
  } finally {
    if (suspended) process.kill(guardian!, "SIGCONT");
    if (alive()) process.kill(descendant!, "SIGKILL");
    await expect.poll(alive, { timeout: 5000 }).toBe(false); signals.mockRestore();
  }
}, 40000);
