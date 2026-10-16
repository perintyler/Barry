/** Real SQLite/CAS/filesystem proof-boundary tests. Tiny captured graphs use
 * mocked compiler/native-eligibility metadata, never executable native claims.
 * The final case separately prepares a real owned guardian and proves its exit. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { SessionReconciliationRequired, WorkflowSessionTurns, workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { WorkArtifactStore, prepareOwnedProcess, type WorkArtifactRef } from "@barry-rocks/sdk/internal/workflows";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { captureWorkflowRuntime, type WorkflowRuntimeManifest } from "./workflow-runtime-closure.js";
import { prepareWorkflowProcessHarness, workflowHarnessPreparationRefusal, type WorkflowProcessHarnessOptions } from "./workflow-process-harness.js";
import { canonicalWorkflowHarnessJson } from "./workflow-harness-protocol.js";
import { SessionsWorkflowBackend, type WorkflowHarnessLaunch } from "./workflow-session-backend.js";

vi.mock("@barry-rocks/sdk/internal/workflows", async importOriginal => {
  const actual = await importOriginal<typeof import("@barry-rocks/sdk/internal/workflows")>();
  return { ...actual, prepareOwnedProcess: vi.fn(actual.prepareOwnedProcess),
    captureOwnedProcessEntrypoint: vi.fn(() => Buffer.from("// inert compiler metadata\n")),
    captureOwnedProcessBootstrap: vi.fn(() => Buffer.from("// inert guardian metadata\n")) };
});
vi.mock("./workflow-runtime-native.js", () => ({ workflowRuntimeNativeIdentity: () => "mocked-refusal-metadata-only", assertWorkflowRuntimeNativeFiles: vi.fn(), isWorkflowRuntimeNativeImage: () => false }));

const roots: string[] = [], artifacts: WorkArtifactStore[] = [];
const preservedRoots = new Set<string>();
beforeEach(async () => {
  closeSessionsDb();
  const actual = await vi.importActual<typeof import("@barry-rocks/sdk/internal/workflows")>("@barry-rocks/sdk/internal/workflows");
  vi.mocked(prepareOwnedProcess).mockReset().mockImplementation(actual.prepareOwnedProcess);
});
afterEach(() => {
  closeSessionsDb();vi.unstubAllEnvs();
  for (const store of artifacts.splice(0)) store.close();
  for (const root of roots.splice(0)) if (!preservedRoots.has(root)) rmSync(root, { recursive: true, force: true });
});
const evidence = { identity: "preparation-identity", traits: [], bound: null, harness: "refusal-fixture", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const artifact = (ref: { digest: string; bytes: number }): WorkArtifactRef => ({ digest: ref.digest, bytes: ref.bytes, purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-preparation-refusal-")));roots.push(root);
  const spool = join(root, "spool"), adapter = join(root, "adapter"), runtime = join(root, "metadata-node"), worker = join(root, "metadata-worker.mjs");
  mkdirSync(spool, { mode: 0o700 });mkdirSync(adapter, { mode: 0o700 });
  writeFileSync(join(adapter, "package.json"), JSON.stringify({ name: "refusal-metadata", version: "1.0.0", type: "module", exports: "./index.js" }));
  writeFileSync(join(adapter, "index.js"), "export default {id:'refusal-fixture'};\n");writeFileSync(runtime, "not an executable: metadata-only refusal fixture\n");writeFileSync(worker, "// source for compiler metadata mock\n");
  const store = new WorkArtifactStore(join(root, "cas"));artifacts.push(store);
  const reference = captureWorkflowRuntime({ artifacts: store, allowedRoots: [root], harness: "refusal-fixture", adapterModule: pathToFileURL(join(adapter, "index.js")).href,
    workerEntrypoint: worker, runtime, nodeVersion: "v26.11.1" });
  const bindingKey = "refusal/binding", sessionId = workflowSessionId(bindingKey, scope.identity!);
  const declaration = { bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope,
    selection: { harness: "refusal-fixture", model: "unit/model", endpoint: "http://127.0.0.1:1/v1", cwd: root, maxTurns: 1, deadline: Date.now() + 30000, runtime: reference } };
  const launch: WorkflowHarnessLaunch = { sessionId, turnId: "turn", segmentId: "segment", owner: "owner", declaration };
  const directory = (selected: WorkflowHarnessLaunch = launch) => join(spool, createHash("sha256").update(canonicalWorkflowHarnessJson({ sessionId: selected.sessionId, turnId: selected.turnId, segmentId: selected.segmentId, owner: selected.owner })).digest("hex"));
  const configure = vi.fn(async () => { throw new Error("Configuration must not run in a pre-native refusal"); });
  const options = (authorize: WorkflowProcessHarnessOptions["authorize"]): WorkflowProcessHarnessOptions => ({ harnessId: "refusal-fixture", spoolRoot: spool, inertEnvironment: { HOME: root, BARRY_HOME: root, PATH: process.env.PATH ?? "" }, runtime: { artifacts: store, reference }, authorize, configure });
  return { root, spool, store, reference, declaration, launch, directory, configure, options };
}
async function caught(operation: () => Promise<unknown>): Promise<unknown> {
  try { await operation(); } catch (error) { return error; }
  throw new Error("Expected preparation refusal");
}

it("brands only an exact owned pre-native post-copy refusal and rejects reconstructed errors or changed launch bindings", async () => {
  const f = fixture(), failure = new Error("Policy revoked after materialization");let checks = 0;
  const error = await caught(() => prepareWorkflowProcessHarness(f.options(async () => { if (++checks === 2) throw failure; }), f.launch));
  expect(checks).toBe(2);
  if (!(error instanceof Error)) throw new Error("Missing preparation refusal error");
  expect(error.cause).toBe(failure);
  expect(existsSync(join(f.directory(), "runtime/.closure.json"))).toBe(true);
  expect(workflowHarnessPreparationRefusal(error, f.launch)).toBe(true);
  expect(workflowHarnessPreparationRefusal(error, structuredClone(f.launch))).toBe(true);
  for (const lookalike of [new Error(failure.message), structuredClone(failure), JSON.parse(JSON.stringify(failure))]) expect(workflowHarnessPreparationRefusal(lookalike, f.launch)).toBe(false);
  for (const launch of [{ ...f.launch, owner: "other" }, { ...f.launch, segmentId: "other" }, { ...f.launch, declaration: { ...f.declaration, selection: { ...f.declaration.selection, model: "other/model" } } }]) expect(workflowHarnessPreparationRefusal(error, launch)).toBe(false);
  expect(prepareOwnedProcess).not.toHaveBeenCalled();expect(f.configure).not.toHaveBeenCalled();
});

it.each(["missing", "corrupt"] as const)("brands verified %s runtime refusal only after fresh spool ownership, before native preparation", async kind => {
  const f = fixture(), manifest = JSON.parse(f.store.verify(artifact(f.reference)).toString("utf8")) as WorkflowRuntimeManifest;
  const chunk = artifact(manifest.chunks[0]!);
  if (kind === "corrupt") writeFileSync(f.store.path(chunk), Buffer.alloc(chunk.bytes, 0x78));
  else {
    const path = f.store.path(chunk), namespace = createHash("sha256").update("null").digest("hex");
    rmSync(path);rmSync(join(f.store.root, ".executor-retained", namespace, chunk.digest));
  }
  const error = await caught(() => prepareWorkflowProcessHarness(f.options(async () => {}), f.launch));
  expect(workflowHarnessPreparationRefusal(error, f.launch)).toBe(true);
  expect(prepareOwnedProcess).not.toHaveBeenCalled();expect(f.configure).not.toHaveBeenCalled();
});

it("does not rebrand an existing directory and preserves the prior preparation evidence", async () => {
  const f = fixture();let checks = 0;
  const options = f.options(async () => { if (++checks === 2) throw new Error("Original post-copy refusal"); });
  const original = await caught(() => prepareWorkflowProcessHarness(options, f.launch));
  expect(workflowHarnessPreparationRefusal(original, f.launch)).toBe(true);
  const binding = readFileSync(join(f.directory(), "binding.json"));
  const second = await caught(() => prepareWorkflowProcessHarness(options, f.launch));
  expect(workflowHarnessPreparationRefusal(second, f.launch)).toBe(false);
  expect(workflowHarnessPreparationRefusal(original, f.launch)).toBe(true);
  expect(readFileSync(join(f.directory(), "binding.json")).equals(binding)).toBe(true);
  expect(prepareOwnedProcess).not.toHaveBeenCalled();
});

it("does not brand policy denial before directory creation or a replaced owned directory", async () => {
  const f = fixture();
  const initial = await caught(() => prepareWorkflowProcessHarness(f.options(async () => { throw new Error("Initial policy denial"); }), f.launch));
  expect(workflowHarnessPreparationRefusal(initial, f.launch)).toBe(false);expect(existsSync(f.directory())).toBe(false);
  let checks = 0;
  const replaced = await caught(() => prepareWorkflowProcessHarness(f.options(async () => {
    if (++checks !== 2) return;
    renameSync(f.directory(), f.directory() + "-original");mkdirSync(f.directory(), { mode: 0o700 });throw new Error("Directory replaced after copy");
  }), f.launch));
  expect(workflowHarnessPreparationRefusal(replaced, f.launch)).toBe(false);expect(prepareOwnedProcess).not.toHaveBeenCalled();
});

it("does not brand a failure inside the native preparation invocation even when it throws immediately", async () => {
  const f = fixture(), failure = new Error("Native acquisition is indeterminate");
  vi.mocked(prepareOwnedProcess).mockImplementationOnce(() => { throw failure; });
  const error = await caught(() => prepareWorkflowProcessHarness(f.options(async () => {}), f.launch));
  expect(error).toBe(failure);expect(prepareOwnedProcess).toHaveBeenCalledTimes(1);
  expect(workflowHarnessPreparationRefusal(error, f.launch)).toBe(false);
});

async function backendFixture(mode: "refusal" | "generic" | "native-configure") {
  const f = fixture();vi.stubEnv("BARRY_SESSIONS_DB", join(f.root, "sessions.db"));
  const db = getSessionsSqlite(), key = "refusal/turn";let releases = 0, checks = 0, captured: WorkflowHarnessLaunch | undefined, originalError: unknown;
  const { runtime: _runtime, ...legacySelection } = f.declaration.selection;
  const declaration = mode === "native-configure" ? { ...f.declaration, selection: legacySelection } : f.declaration;
  const backend = new SessionsWorkflowBackend({ db, declaration, enforceable: selected => boundFingerprint(selected) === boundFingerprint(scope), authorize: async () => {}, authorizeTool: async () => ({ allow: false }),
    acquire: async () => ({ release: () => { releases++; } }), prepare: async launch => {
      captured = structuredClone(launch);
      try {
        if (mode === "generic") throw new Error("Unproven host preparation error");
        if (mode === "native-configure") return await prepareWorkflowProcessHarness({ harnessId: "refusal-fixture", spoolRoot: f.spool,
          inertEnvironment: { HOME: f.root, BARRY_HOME: f.root, PATH: process.env.PATH ?? "" }, adapterModule: pathToFileURL(join(f.root, "adapter/index.js")).href,
          workerEntrypoint: fileURLToPath(new URL("./workflow-harness-child.ts", import.meta.url)), authorize: async () => {}, configure: async () => { originalError = new Error("Configuration refused after actual guardian acquisition");throw originalError; } }, launch);
        return await prepareWorkflowProcessHarness(f.options(async () => { if (++checks === 2) throw new Error("Post-copy policy refusal"); }), launch);
      } catch (error) { originalError = error;throw error; }
    } });
  const turns = new WorkflowSessionTurns(workflowTurnsStore, backend), id = await turns.ensure(declaration.bindingKey, scope);
  return { ...f, db, backend, turns, key, id, declaration, get releases() { return releases; }, get launch() { return captured; }, get originalError() { return originalError; } };
}

it("settles a branded pre-native refusal through the actual migrated backend, appending a receipt and releasing its slot", async () => {
  const f = await backendFixture("refusal");
  try {
    await expect(f.turns.turn(f.key, f.id, { text: "Original input" }, scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    const found = f.backend.destination.inspect(f.key)!;
    expect(f.backend.destination.settlements(found.turnId)).toMatchObject([{ phase: "not_started", handle: null, inputAt: null, ceasedAt: expect.any(String) }]);
    expect(f.backend.destination.unsettled()).toEqual([]);expect(f.releases).toBe(1);
    expect(f.db.prepare("SELECT count(*) AS n FROM session_workflow_preparation_refusals").get()).toEqual({ n: 1 });
    expect(workflowHarnessPreparationRefusal(f.originalError, f.launch!)).toBe(true);expect(prepareOwnedProcess).not.toHaveBeenCalled();
  } finally { await f.backend.close(); }
});

it("keeps generic preparation failure uncertain instead of manufacturing a not-started receipt or releasing its slot", async () => {
  const f = await backendFixture("generic");
  await expect(f.turns.turn(f.key, f.id, { text: "Original input" }, scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
  const found = f.backend.destination.inspect(f.key)!;
  expect(f.backend.destination.settlements(found.turnId)).toMatchObject([{ phase: "preparing", handle: null, inputAt: null, ceasedAt: null }]);
  expect(f.db.prepare("SELECT count(*) AS n FROM session_workflow_preparation_refusals").get()).toEqual({ n: 0 });
  expect(f.releases).toBe(0);expect(workflowHarnessPreparationRefusal(f.originalError, f.launch!)).toBe(false);
  const closeError = await caught(() => f.backend.close());
  expect(closeError).toBeInstanceOf(AggregateError);
  if (!(closeError instanceof AggregateError)) throw new Error("Missing uncertain cleanup aggregate");
  expect(closeError.errors).toEqual(expect.arrayContaining([expect.any(SessionReconciliationRequired)]));
});

it("uses actual guardian cessation after post-native configure refusal, with no pre-native brand or preparation receipt", async () => {
  const f = await backendFixture("native-configure"), failures: unknown[] = [];
  try {
    await expect(f.turns.turn(f.key, f.id, { text: "Original input" }, scope)).rejects.toBeInstanceOf(SessionReconciliationRequired);
    const found = f.backend.destination.inspect(f.key)!, fences = f.backend.destination.settlements(found.turnId);
    expect(fences).toHaveLength(1);expect(fences[0]).toMatchObject({ phase: "ceased", inputAt: null, ceasedAt: expect.any(String) });
    expect(prepareOwnedProcess).toHaveBeenCalledTimes(1);
    expect(f.originalError).toBeInstanceOf(Error);expect(workflowHarnessPreparationRefusal(f.originalError, f.launch!)).toBe(false);
    const handle = fences[0]!.handle as { pid: number; pgid: number };expect(handle.pid).toBe(handle.pgid);
    let absent = false;try { process.kill(-handle.pgid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
    expect(absent).toBe(true);expect(f.backend.destination.unsettled()).toEqual([]);expect(f.releases).toBe(1);
    expect(f.db.prepare("SELECT count(*) AS n FROM session_workflow_preparation_refusals").get()).toEqual({ n: 0 });
  } catch (error) { failures.push(error); }
  try { await f.backend.close(); } catch (error) { failures.push(error); }
  if (failures.length) {
    preservedRoots.add(f.root);
    try { writeFileSync(join(f.root, "native-configure-failure.json"), JSON.stringify({ fences: f.backend.destination.unsettled(), errors: failures.map(error => error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown" }) }), { mode: 0o600 }); }
    catch (error) { failures.push(error); }
    throw new AggregateError(failures, "Actual guardian configure refusal failed; preserved " + f.root);
  }
}, 20000);
