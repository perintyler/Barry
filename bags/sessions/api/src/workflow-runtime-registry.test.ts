/** Real SQLite/CAS publication tests. Capture and native probe are mocked:
 * these cases assert registry atomicity/identity, not executable eligibility. */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { installedAdapter } from "./test-helpers/installed-adapter.js";
import { captureWorkflowRuntime, type WorkflowRuntimeReference } from "./workflow-runtime-closure.js";
import { probeWorkflowRuntimeRegistration } from "./workflow-runtime-registration-probe.js";
import { WorkflowRuntimeRegistry } from "./workflow-runtime-registry.js";

vi.mock("./workflow-runtime-closure.js", async importOriginal => ({
  ...await importOriginal<typeof import("./workflow-runtime-closure.js")>(), captureWorkflowRuntime: vi.fn(),
}));
vi.mock("./workflow-runtime-registration-probe.js", () => ({ probeWorkflowRuntimeRegistration: vi.fn() }));

const disposals: (() => void)[] = [];
beforeEach(() => { vi.mocked(captureWorkflowRuntime).mockReset();vi.mocked(probeWorkflowRuntimeRegistration).mockReset(); });
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-runtime-registry-")));
  disposals.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(join(root, "registry.db"));disposals.push(() => db.close());
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));disposals.push(() => artifacts.close());
  const directory = join(root, "adapter");mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/pi", version: "1.0.0", type: "module", exports: { ".": { import: "./index.js" } }, barry: { sessionAdapter: { contractVersion: 1 } } }));
  writeFileSync(join(directory, "index.js"), "export default {}; // never imported by mocked capture/probe\n");
  const record = installedAdapter("pi", {
    packageName: "@fixture/pi", path: directory, version: "1.0.0", aliases: ["pi-alias"], defaultMode: "hosted",
    modes: { guest: null, instrumented: null, hosted: {
      approvalContinuation: "durable", verifiedOn: "1.0.0", evidence: { check: "registry-fixture", proves: "metadata only" }, egressSandbox: false,
      native: { controllable: [] }, guarantees: { capture: "total", delivery: "wake", steer: true, interrupt: true, gating: "per-call", keepsVendorUi: false, identity: "inherent" },
    } },
  });
  let selected: InstalledAdapter[] = [record];
  let beforeSelection: (() => void) | undefined;
  function reference(label: string): WorkflowRuntimeReference {
    const ref = artifacts.stage(Buffer.from(label), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
    return { version: 1, protocol: 1, digest: ref.digest, bytes: ref.bytes };
  }
  const first = reference("mocked captured generation A"), second = reference("mocked captured generation B");
  vi.mocked(captureWorkflowRuntime).mockReturnValue(first);
  vi.mocked(probeWorkflowRuntimeRegistration).mockResolvedValue(undefined);
  const options = { db, artifacts, adapters: {
    installed: () => selected,
    withSelection<T>(id: string, operation: (record: InstalledAdapter | undefined) => T): T {
      beforeSelection?.();return operation(findInstalled(selected, id));
    },
  }, workerEntrypoint: join(root, "worker.mjs"), allowedRoots: [root], spoolRoot: join(root, "spool") };
  mkdirSync(options.spoolRoot, { mode: 0o700 });
  writeFileSync(options.workerEntrypoint, "// registry metadata fixture\n");
  return { db, record, first, second, options, registry: new WorkflowRuntimeRegistry(options),
    select: (rows: InstalledAdapter[]) => { selected = rows; },
    beforeSelection: (operation: () => void) => { beforeSelection = operation; }, deadline: () => Date.now() + 30000 };
}

it("publishes only after capture and probe, then restores historical and current identity from real SQLite", async () => {
  const f = fixture(), entered = gate(), proceed = gate();
  vi.mocked(probeWorkflowRuntimeRegistration).mockImplementation(async () => { entered.release();await proceed.promise; });
  const registration = f.registry.register("pi", f.deadline());
  await entered.promise;
  expect(captureWorkflowRuntime).toHaveBeenCalledTimes(1);expect(f.registry.current("pi")).toBeUndefined();
  proceed.release();const accepted = await registration;
  expect(accepted).toMatchObject({ harness: "pi", runtime: f.first });
  expect(accepted.generation).toEqual(expect.any(String));expect(accepted.recordHash).toMatch(/^[a-f0-9]{64}$/);
  const restarted = new WorkflowRuntimeRegistry(f.options);
  expect(restarted.get(accepted.generation)).toEqual(accepted);expect(restarted.current("pi")).toEqual(accepted);
});

it.each(["capture", "probe"] as const)("does not publish or replace an accepted generation when %s fails", async phase => {
  const f = fixture(), original = await f.registry.register("pi", f.deadline());
  if (phase === "capture") vi.mocked(captureWorkflowRuntime).mockImplementationOnce(() => { throw new Error("capture refused"); });
  else { vi.mocked(captureWorkflowRuntime).mockReturnValue(f.second);vi.mocked(probeWorkflowRuntimeRegistration).mockRejectedValueOnce(new Error("probe refused")); }
  await expect(f.registry.register("pi", f.deadline())).rejects.toThrow(`${phase} refused`);
  expect(f.registry.current("pi")).toEqual(original);expect(f.registry.get(original.generation)).toEqual(original);
  if (phase === "capture") expect(probeWorkflowRuntimeRegistration).toHaveBeenCalledTimes(1);
});

it.each(["removed", "changed", "readded"] as const)("refuses publication when the selected record is %s during the awaited probe", async change => {
  const f = fixture(), entered = gate(), proceed = gate();
  vi.mocked(probeWorkflowRuntimeRegistration).mockImplementationOnce(async () => { entered.release();await proceed.promise; });
  const pending = f.registry.register("pi", f.deadline());
  // Attach rejection immediately; the gate is controlled independently.
  const refused = expect(pending).rejects.toThrow();await entered.promise;
  if (change === "readded") f.select([]);
  f.select(change === "removed" ? [] : [{ ...f.record, ...(change === "changed" ? { version: "2.0.0" } : { installedAt: "2026-10-15T12:00:00.000Z" }) }]);
  proceed.release();await refused;expect(f.registry.current("pi")).toBeUndefined();
  const restarted = new WorkflowRuntimeRegistry(f.options);expect(restarted.current("pi")).toBeUndefined();
});

it("keeps historical lookup independent of removal and refuses a changed current catalog record", async () => {
  const f = fixture(), accepted = await f.registry.register("pi", f.deadline());
  f.select([]);expect(f.registry.current("pi")).toBeUndefined();expect(f.registry.get(accepted.generation)).toEqual(accepted);
  f.select([{ ...f.record, installedAt: "2026-10-15T12:00:00.000Z" }]);
  expect(new WorkflowRuntimeRegistry(f.options).current("pi")).toBeUndefined();
  expect(f.registry.get(accepted.generation)).toEqual(accepted);
});

it("canonicalizes installed aliases without creating an alias-owned generation", async () => {
  const f = fixture(), accepted = await f.registry.register("pi-alias", f.deadline());
  expect(accepted.harness).toBe("pi");expect(f.registry.current("pi")).toEqual(accepted);expect(f.registry.current("pi-alias")).toEqual(accepted);
  expect(vi.mocked(captureWorkflowRuntime).mock.calls[0][0].harness).toBe("pi");
});

it("isolates persisted records from caller and installed-record object mutation", async () => {
  const f = fixture(), accepted = await f.registry.register("pi", f.deadline()), original = structuredClone(accepted);
  accepted.runtime.digest = "0".repeat(64);accepted.recordHash = "0".repeat(64);accepted.harness = "changed";
  const read = f.registry.get(original.generation)!;read.runtime.digest = "f".repeat(64);
  expect(f.registry.get(original.generation)).toEqual(original);
  f.record.label = "mutated selected metadata";
  expect(f.registry.current("pi")).toBeUndefined();expect(f.registry.get(original.generation)).toEqual(original);
});

it("distinguishes same-version executable generations and keeps the older accepted identity on restart", async () => {
  const f = fixture(), first = await f.registry.register("pi", f.deadline());
  vi.mocked(captureWorkflowRuntime).mockReturnValue(f.second);
  const second = await f.registry.register("pi", f.deadline());
  expect(second.runtime).toEqual(f.second);expect(second.generation).not.toBe(first.generation);expect(second.recordHash).toBe(first.recordHash);
  const restarted = new WorkflowRuntimeRegistry(f.options);
  expect(restarted.current("pi")).toEqual(second);expect(restarted.get(first.generation)).toEqual(first);expect(restarted.get(second.generation)).toEqual(second);
});

it("does not let an earlier overlapping probe overwrite a later published generation", async () => {
  const f = fixture(), entered = gate(), proceed = gate();
  vi.mocked(captureWorkflowRuntime).mockReturnValueOnce(f.first).mockReturnValueOnce(f.second);
  vi.mocked(probeWorkflowRuntimeRegistration).mockImplementationOnce(async () => { entered.release();await proceed.promise; });
  const pending = f.registry.register("pi", f.deadline());
  const stale = expect(pending).rejects.toThrow();await entered.promise;
  const latest = await f.registry.register("pi", f.deadline());proceed.release();await stale;
  expect(latest.runtime).toEqual(f.second);expect(f.registry.current("pi")).toEqual(latest);
  expect(new WorkflowRuntimeRegistry(f.options).current("pi")).toEqual(latest);
});

it.each(["removed", "changed", "lock-error"] as const)("checks the latest selection inside the publication lock when it is %s", async change => {
  const f = fixture(), original = await f.registry.register("pi-alias", f.deadline());
  vi.mocked(captureWorkflowRuntime).mockReturnValue(f.second);
  let lockEntries = 0;
  f.beforeSelection(() => {
    lockEntries++;
    // This mutation happens after the probe, at entry to the synchronous
    // selection lock, rather than via an earlier installed() snapshot.
    if (change === "removed") f.select([]);
    else if (change === "changed") f.select([{ ...f.record, installedAt: "2026-10-15T12:00:00.000Z" }]);
    else throw new Error("selection lock unavailable");
  });
  await expect(f.registry.register("pi-alias", f.deadline())).rejects.toThrow();
  expect(lockEntries).toBe(1);expect(f.registry.get(original.generation)).toEqual(original);
  const latest = f.db.prepare("SELECT generation,state FROM workflow_runtime_generations WHERE generation<>?").all(original.generation) as { generation: string; state: string }[];
  expect(latest).toHaveLength(1);expect(latest[0].state).toBe("refused");expect(f.registry.get(latest[0].generation)).toBeUndefined();
  expect(new WorkflowRuntimeRegistry(f.options).current("pi")).toEqual(change === "lock-error" ? original : undefined);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM workflow_runtime_generations WHERE state='qualified'").get()).toEqual({ count: 1 });
});

it("refuses uninstalled and non-durable metadata before capture or probe", async () => {
  const f = fixture();f.select([]);
  await expect(f.registry.register("pi", f.deadline())).rejects.toThrow();
  f.select([{ ...f.record, modes: { ...f.record.modes, hosted: { ...f.record.modes.hosted!, approvalContinuation: "live" } } }]);
  await expect(f.registry.register("pi", f.deadline())).rejects.toThrow();
  expect(captureWorkflowRuntime).not.toHaveBeenCalled();expect(probeWorkflowRuntimeRegistration).not.toHaveBeenCalled();
});

it("does not probe or publish when SQLite refuses the initial generation INSERT", async () => {
  const f = fixture();
  f.db.exec("CREATE TEMP TRIGGER refuse_generation BEFORE INSERT ON workflow_runtime_generations BEGIN SELECT RAISE(ABORT,'generation insert refused'); END");
  await expect(f.registry.register("pi", f.deadline())).rejects.toThrow("generation insert refused");
  expect(probeWorkflowRuntimeRegistration).not.toHaveBeenCalled();expect(f.registry.current("pi")).toBeUndefined();
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM workflow_runtime_generations").get()).toEqual({ count: 0 });
  f.db.exec("DROP TRIGGER refuse_generation");
  const accepted = await f.registry.register("pi", f.deadline());expect(f.registry.current("pi")).toEqual(accepted);
});

it("rolls back qualification when SQLite refuses the first current-pointer INSERT", async () => {
  const f = fixture();
  f.db.exec("CREATE TEMP TRIGGER refuse_current BEFORE INSERT ON workflow_runtime_current BEGIN SELECT RAISE(ABORT,'current insert refused'); END");
  await expect(f.registry.register("pi", f.deadline())).rejects.toThrow("current insert refused");
  const rejected = f.db.prepare("SELECT generation,state FROM workflow_runtime_generations").all() as { generation: string; state: string }[];
  expect(rejected).toHaveLength(1);expect(rejected[0].state).toBe("refused");
  expect(f.registry.get(rejected[0].generation)).toBeUndefined();expect(new WorkflowRuntimeRegistry(f.options).current("pi")).toBeUndefined();
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM workflow_runtime_current").get()).toEqual({ count: 0 });
  f.db.exec("DROP TRIGGER refuse_current");
  const accepted = await f.registry.register("pi", f.deadline());expect(f.registry.current("pi")).toEqual(accepted);
});

it("rolls back replacement qualification and preserves the previous generation when pointer UPDATE aborts", async () => {
  const f = fixture(), original = await f.registry.register("pi", f.deadline());
  vi.mocked(captureWorkflowRuntime).mockReturnValue(f.second);
  f.db.exec("CREATE TEMP TRIGGER refuse_replacement BEFORE UPDATE ON workflow_runtime_current BEGIN SELECT RAISE(ABORT,'current update refused'); END");
  await expect(f.registry.register("pi", f.deadline())).rejects.toThrow("current update refused");
  const rejected = f.db.prepare("SELECT generation,state FROM workflow_runtime_generations WHERE generation<>?").all(original.generation) as { generation: string; state: string }[];
  expect(rejected).toHaveLength(1);expect(rejected[0].state).toBe("refused");expect(f.registry.get(rejected[0].generation)).toBeUndefined();
  const restarted = new WorkflowRuntimeRegistry(f.options);
  expect(restarted.current("pi")).toEqual(original);expect(restarted.get(original.generation)).toEqual(original);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM workflow_runtime_generations WHERE state='qualified'").get()).toEqual({ count: 1 });
  f.db.exec("DROP TRIGGER refuse_replacement");
  const accepted = await f.registry.register("pi", f.deadline());expect(accepted.runtime).toEqual(f.second);expect(restarted.current("pi")).toEqual(accepted);
});

it("resolves detached historical declarations without following a replacement or exposing mutable catalog objects", async () => {
  const f = fixture(), accepted = await f.registry.register("pi", f.deadline());
  const original = f.registry.descriptor(accepted.generation)!;
  expect(original.registration).toEqual(accepted);expect(original.record).toEqual(f.record);
  original.record.label = "caller mutation";original.registration.runtime.digest = "0".repeat(64);
  f.select([]);expect(f.registry.current("pi")).toBeUndefined();
  expect(f.registry.descriptor(accepted.generation)).toEqual({ registration: accepted, record: f.record });
});

it("refuses retained declaration corruption before returning a historical executable descriptor", async () => {
  const f = fixture(), accepted = await f.registry.register("pi", f.deadline());
  f.db.prepare("UPDATE workflow_runtime_generations SET record_json=? WHERE generation=?").run(JSON.stringify({ ...f.record, label: "changed after qualification" }), accepted.generation);
  expect(() => f.registry.descriptor(accepted.generation)).toThrow("WorkflowRuntimeDeclarationChanged");
  expect(f.registry.descriptor("unknown-generation")).toBeUndefined();
});
