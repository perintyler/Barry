/** Real startup filesystem/SQLite/CAS ownership. Only registry.register is
 * mocked: these tests claim no native inspection or qualified executable code. */
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import type { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { registerInstalledWorkflowRuntimes } from "./workflow-runtime-installation.js";
import { WorkflowRuntimeRegistry } from "./workflow-runtime-registry.js";

const disposals: (() => void)[] = [];
const register = vi.spyOn(WorkflowRuntimeRegistry.prototype, "register");
beforeEach(() => { register.mockReset(); });
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
type RegistryInputs = { db: Database.Database; artifacts: WorkArtifactStore; allowedRoots: string[]; spoolRoot: string; workerEntrypoint: string };
function inputs(registry: WorkflowRuntimeRegistry): RegistryInputs { return Reflect.get(registry, "options") as RegistryInputs; }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-installation-unit-")));disposals.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "service"), configuration = join(root, "installation.json");
  const adapters = { installed: () => [], withSelection<T>(_id: string, operation: (record: InstalledAdapter | undefined) => T): T { return operation(undefined); } };
  const config = { version: 1, harnesses: ["first", "second"], allowedRoots: [root], registrationTimeoutMs: 30000 };
  const save = (value: unknown = config) => writeFileSync(configuration, JSON.stringify(value), { mode: 0o600 });save();
  const start = () => registerInstalledWorkflowRuntimes({ configuration, directory, adapters });
  return { root, directory, configuration, adapters, config, save, start };
}
function persistMockGeneration(registry: WorkflowRuntimeRegistry, harness: string) {
  const { db, artifacts } = inputs(registry);
  const bytes = artifacts.stage(Buffer.from("mock registration metadata for " + harness), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
  const runtime = { version: 1 as const, protocol: 1 as const, digest: bytes.digest, bytes: bytes.bytes }, generation = "mock-generation-" + harness;
  db.prepare("INSERT OR IGNORE INTO workflow_runtime_generations (generation,harness,runtime_json,record_hash,record_json,state,probe_directory) VALUES (?,?,?,?,?,'qualified',?)")
    .run(generation, harness, JSON.stringify(runtime), "mock-record-hash", "{}", inputs(registry).spoolRoot);
  return { generation, harness, runtime, recordHash: "mock-record-hash" };
}

it.each([
  { version: 1, harnesses: [], allowedRoots: ["/installed"] },
  { version: 1, harnesses: ["same", "same"], allowedRoots: ["/installed"] },
  { version: 1, harnesses: ["one"], allowedRoots: ["relative"] },
  { version: 1, harnesses: ["one"], allowedRoots: ["/installed"], apiKey: "must-not-persist" },
  { version: 1, harnesses: ["one"], allowedRoots: ["/installed"], env: { TOKEN: "must-not-persist" } },
])("rejects invalid or secret-bearing installation configuration before store creation: %j", async value => {
  const f = fixture();f.save(value);await expect(f.start()).rejects.toThrow();
  expect(register).not.toHaveBeenCalled();expect(existsSync(f.directory)).toBe(false);
});
it("requires an absolute configuration path before reading any service stores", async () => {
  const f = fixture();await expect(registerInstalledWorkflowRuntimes({ ...f, configuration: "installation.json" })).rejects.toThrow("WorkflowRuntimeInstallationConfigurationUnavailable");
  expect(register).not.toHaveBeenCalled();expect(existsSync(f.directory)).toBe(false);
});
it.each(["group-writable", "world-writable", "symlink"] as const)("refuses unsafe configuration ownership %s before persistent stores", async kind => {
  const f = fixture();
  if (kind === "group-writable") chmodSync(f.configuration, 0o620);
  if (kind === "world-writable") chmodSync(f.configuration, 0o602);
  if (kind === "symlink") {
    const target = join(f.root, "actual-configuration.json");writeFileSync(target, JSON.stringify(f.config), { mode: 0o600 });
    rmSync(f.configuration);symlinkSync(target, f.configuration);
  }
  await expect(f.start()).rejects.toThrow("WorkflowRuntimeInstallationConfigurationUnavailable");
  expect(register).not.toHaveBeenCalled();expect(existsSync(f.directory)).toBe(false);
});

it("owns private durable stores and serializes harness registration before returning the startup handle", async () => {
  const f = fixture();let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered: string[] = [];
  let firstInputs!: RegistryInputs;
  register.mockImplementation(async function (this: WorkflowRuntimeRegistry, harness: string, deadline: number) {
    entered.push(harness);expect(deadline).toBeGreaterThan(Date.now());
    if (harness === "first") { firstInputs = inputs(this);await gate; }
    return persistMockGeneration(this, harness);
  });
  const starting = f.start();await Promise.resolve();
  expect(entered).toEqual(["first"]);expect(firstInputs.db.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(firstInputs.db.pragma("synchronous", { simple: true })).toBe(2);
  expect(firstInputs.allowedRoots).toEqual([f.root]);expect(firstInputs.workerEntrypoint).toMatch(/workflow-harness-child\.(?:ts|js)$/);
  release();const service = await starting;disposals.push(service.close);
  expect(entered).toEqual(["first", "second"]);expect(service.registrations.map(row => row.harness)).toEqual(entered);
  for (const path of [f.directory, join(f.directory, "registration-spool"), join(f.directory, "artifacts")]) expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.directory, "generations.db")).mode & 0o777).toBe(0o600);
  const retained = service.registrations[0];expect(service.registry.get(retained.generation)).toEqual(retained);
  const closeArtifacts = vi.spyOn(firstInputs.artifacts, "close");service.close();service.close();
  expect(firstInputs.db.open).toBe(false);expect(closeArtifacts).toHaveBeenCalledTimes(1);
  const reopened = await f.start();disposals.push(reopened.close);
  expect(reopened.registry.get(retained.generation)).toEqual(retained);
  const persisted = new Database(join(f.directory, "generations.db"), { readonly: true });
  try { expect(persisted.prepare("SELECT count(*) AS count FROM workflow_runtime_generations").get()).toEqual({ count: 2 }); }
  finally { persisted.close(); }
  expect(readFileSync(f.configuration, "utf8")).not.toContain("TOKEN");
});

it.each(["public-directory", "symlink-directory", "public-database", "symlink-database"] as const)("refuses unsafe startup storage %s before registration", kind => {
  const f = fixture();mkdirSync(f.directory, { mode: 0o700 });
  if (kind === "public-directory") chmodSync(f.directory, 0o755);
  if (kind === "symlink-directory") { const target = join(f.root, "real-service");mkdirSync(target, { mode: 0o700 });rmSync(f.directory, { recursive: true });symlinkSync(target, f.directory, "dir"); }
  if (kind === "public-database") { writeFileSync(join(f.directory, "generations.db"), "");chmodSync(join(f.directory, "generations.db"), 0o644); }
  if (kind === "symlink-database") { const target = join(f.root, "other.db");writeFileSync(target, "");symlinkSync(target, join(f.directory, "generations.db")); }
  return expect(f.start()).rejects.toThrow().then(() => { expect(register).not.toHaveBeenCalled(); });
});

it("closes owned handles after a later registration failure while preserving the already durable journal", async () => {
  const f = fixture(), failure = new Error("actual inspection refused");let captured!: RegistryInputs;
  register.mockImplementation(async function (this: WorkflowRuntimeRegistry, harness: string) {
    captured = inputs(this);
    if (harness === "second") throw failure;
    return persistMockGeneration(this, harness);
  });
  await expect(f.start()).rejects.toBe(failure);expect(captured.db.open).toBe(false);
  const reopened = new Database(join(f.directory, "generations.db"), { readonly: true });
  try { expect(reopened.prepare("SELECT generation,harness FROM workflow_runtime_generations").all()).toEqual([{ generation: "mock-generation-first", harness: "first" }]); }
  finally { reopened.close(); }
  expect(existsSync(join(f.directory, "artifacts"))).toBe(true);expect(existsSync(join(f.directory, "registration-spool"))).toBe(true);
});
it.each(["regular-file", "symlink-to-file"] as const)("closes the real SQLite owner when CAS construction fails on %s", async kind => {
  const f = fixture();mkdirSync(f.directory, { mode: 0o700 });
  const path = join(f.directory, "artifacts");
  if (kind === "regular-file") writeFileSync(path, "not a directory", { mode: 0o600 });
  else { const target = join(f.root, "not-a-directory");writeFileSync(target, "not a directory", { mode: 0o600 });symlinkSync(target, path); }
  const close = vi.spyOn(Database.prototype, "close");
  try {
    await expect(f.start()).rejects.toThrow();expect(register).not.toHaveBeenCalled();
    const closed = close.mock.contexts as Database.Database[];
    expect(closed.some(db => db.name === join(f.directory, "generations.db") && !db.open)).toBe(true);
  } finally { close.mockRestore(); }
  // The same persistent database remains usable after the failed owner exits.
  const reopened = new Database(join(f.directory, "generations.db"));
  try { reopened.exec("BEGIN EXCLUSIVE; CREATE TABLE startup_recovery (id INTEGER PRIMARY KEY); COMMIT"); }
  finally { reopened.close(); }
});
