import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, it } from "vitest";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { loadDeclaredStores, prepareBackupGeneration, createBackup, prepareStoreGeneration, StoreRegistry, validatePreparedStoreGeneration, validateSnapshot } from "@barry-rocks/sdk/internal/stores";
import { openLocalArtifactStore } from "./store.js";
import { activateLocalArtifactRestore, prepareLocalArtifactRestore } from "./restore.js";
import { createArtifactCreator } from "../create.js";
import { createArtifactCore } from "../core.js";
import { sealArtifactGeneration } from "./index-store.js";

const directories: string[] = [];
beforeAll(() => { execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "--build"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "pipe" }); });
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "barry-artifact-restore-")); directories.push(path); return path; }
const capturedAt = "2026-10-03T20:00:00.000Z", restoredAt = "2026-10-03T20:01:00.000Z";
const access = { async authorize() { return { identityId: "alice", actorId: 1, credentialId: "fixture" }; } };
const request = { filename: "report.txt", mimeType: "text/plain", kind: "text" as const, idempotencyKey: "first" };
async function* bytes() { yield Buffer.from("immutable report"); }
function creator(store: Awaited<ReturnType<typeof openLocalArtifactStore>>, timestamp: string) {
  return createArtifactCreator({ repository: store.repository, blobs: store.blobs, access, now: () => timestamp, newId: randomUUID, hashText: async text => createHash("sha256").update(text).digest("hex") });
}
async function fixture() {
  const directory = await root(), registry = new StoreRegistry("desktop", directory), bagRoot = fileURLToPath(new URL("../../", import.meta.url));
  await loadDeclaredStores(registry, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest: parseManifest(bagRoot) }]);
  const filepath = join(directory, "identities/alice/artifacts/default.db"), store = await openLocalArtifactStore({ node: "desktop", identity: "alice", bag: "artifacts", store: "default", engine: "sqlite", owned_by: "identity", filepath });
  try {
    const first = await creator(store, capturedAt).create(request, bytes());
    await createArtifactCore({ repository: store.repository, access, now: () => restoredAt }).updateMetadata({ id: first.id, expectedRevision: 1, title: "edited", tags: ["retained"] });
    const child = await creator(store, capturedAt).create({ ...request, idempotencyKey: "child", derivedFrom: first.id }, bytes());
    store.repository.beginIntent({ id: "unfinished", createdAt: capturedAt, expiresAt: "2026-10-03T20:02:00.000Z" });
    store.maintenance.pin("old-backup", [first.content.sha256]);
    const original = await store.repository.get(first.id);
    return { directory, registry, filepath, first: original!, child };
  } finally { store.close(); }
}
async function capture(fixture: Awaited<ReturnType<typeof fixture>>) {
  return fixture.registry.snapshot({ node: "desktop", identity: "alice", bag: "artifacts", store: "default" }, join(fixture.directory, "snapshots"));
}
it("whole-generation preparation retains an untouched artifact catalog, metadata, intents, pins and exact bytes", async () => {
  const source = await fixture(), root = join(source.directory, "stores"), previous = join(root, "generations/previous");
  await mkdir(previous, { recursive: true }); await rename(join(source.directory, "identities"), join(previous, "identities"));
  await writeFile(join(root, "active.json"), JSON.stringify({ id: "previous" }));
  const prepared = await prepareStoreGeneration({ root, previousId: "previous", servicesStopped: true });
  expect(await validatePreparedStoreGeneration(root, prepared.id)).toEqual(prepared);
  const filepath = join(prepared.directory, "identities/alice/artifacts/default.db"), database = new Database(filepath, { readonly: true });
  try {
    expect(database.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT title,revision FROM artifact_metadata WHERE artifact_id=?").get(source.first.id)).toEqual({ title: "edited", revision: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status FROM blob_intents WHERE id='unfinished'").get()).toEqual({ status: "uploading" });
  } finally { database.close(); }
  expect(await validatePreparedStoreGeneration(root, prepared.id)).toEqual(prepared);
  const relative = `identities/alice/artifacts/default.db.blobs/sha256/${source.first.content.sha256.slice(0, 2)}/${source.first.content.sha256}`;
  expect(await readFile(join(prepared.directory, relative))).toEqual(await readFile(join(previous, relative)));
  const historical = new Database(join(previous, "identities/alice/artifacts/default.db"), { readonly: true });
  try { expect(historical.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 2 }); } finally { historical.close(); }
});
it("prepares a complete backup generation and resets an untouched identity artifact store without changing history", async () => {
  const source = await fixture(), snapshot = await capture(source), backupRoot = join(source.directory, "backups");
  const backup = await createBackup([snapshot], { root: backupRoot });
  const live = await openLocalArtifactStore({ node: "desktop", identity: "alice", bag: "artifacts", store: "default", engine: "sqlite", owned_by: "identity", filepath: source.filepath });
  try { await creator(live, restoredAt).create({ ...request, idempotencyKey: "later" }, bytes()); } finally { live.close(); }
  const bobPath = join(source.directory, "identities/bob/artifacts/default.db"), bob = await openLocalArtifactStore({ node: "desktop", identity: "bob", bag: "artifacts", store: "default", engine: "sqlite", owned_by: "identity", filepath: bobPath });
  try {
    const created = await createArtifactCreator({ repository: bob.repository, blobs: bob.blobs, access: { authorize: async () => ({ identityId: "bob", actorId: 2, credentialId: "bob" }) }, now: () => capturedAt, newId: randomUUID, hashText: async text => createHash("sha256").update(text).digest("hex") }).create(request, bytes());
    bob.repository.beginIntent({ id: "bob-unfinished", createdAt: capturedAt, expiresAt: "2026-10-03T20:02:00.000Z" });
    bob.maintenance.pin("bob-old-pin", [created.content.sha256]);
  } finally { bob.close(); }
  await writeFile(join(source.directory, "identities/alice/unrelated.bin"), Buffer.from([0, 255, 128]));
  const globalRoot = join(source.directory, "stores"), previous = join(globalRoot, "generations/previous");
  await mkdir(previous, { recursive: true }); await rename(join(source.directory, "identities"), join(previous, "identities"));
  await writeFile(join(globalRoot, "active.json"), JSON.stringify({ id: "previous" }));
  const prepared = await prepareBackupGeneration(join(backupRoot, backup.id), { root: globalRoot, previousId: "previous", servicesStopped: true, registry: source.registry });
  for (const [identity, count, intent] of [["alice", 2, "unfinished"], ["bob", 1, "bob-unfinished"]] as const) {
    const old = new Database(join(previous, `identities/${identity}/artifacts/default.db`), { readonly: true });
    const restored = new Database(join(prepared.directory, `identities/${identity}/artifacts/default.db`), { readonly: true });
    try {
      expect(restored.prepare("SELECT token FROM artifact_storage_generation").get()).not.toEqual(old.prepare("SELECT token FROM artifact_storage_generation").get());
      expect(restored.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count });
      expect(restored.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 0 });
      expect(restored.prepare("SELECT status FROM blob_intents WHERE id=?").get(intent)).toEqual({ status: "failed" });
      expect(old.prepare("SELECT status FROM blob_intents WHERE id=?").get(intent)).toEqual({ status: "uploading" });
      expect(old.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: identity === "alice" ? 3 : 1 });
      expect(old.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 1 });
    } finally { old.close(); restored.close(); }
  }
  expect(await readFile(join(prepared.directory, "identities/alice/unrelated.bin"))).toEqual(Buffer.from([0, 255, 128]));
  expect(await validatePreparedStoreGeneration(globalRoot, prepared.id)).toEqual(prepared);
  expect(JSON.parse(await readFile(join(globalRoot, "active.json"), "utf8"))).toEqual({ id: "previous" });
});
it("the declared restore adapter prepares a fresh catalog through the installed registry", async () => {
  const source = await fixture(), snapshot = await capture(source), candidateRoot = await root();
  const registry = new StoreRegistry("replacement", candidateRoot), bagRoot = fileURLToPath(new URL("../../", import.meta.url));
  await loadDeclaredStores(registry, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest: parseManifest(bagRoot) }]);
  await loadDeclaredStores(registry, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest: parseManifest(bagRoot) }]);
  expect(registry.hasRestoreAdapter("artifacts", "default")).toBe(true);
  const destination = join(candidateRoot, "identities/alice/artifacts/default.db");
  await registry.prepareRestore(snapshot, destination);
  const restored = new Database(destination, { readonly: true }), original = new Database(source.filepath, { readonly: true });
  try {
    expect(restored.prepare("SELECT token FROM artifact_storage_generation").get()).not.toEqual(original.prepare("SELECT token FROM artifact_storage_generation").get());
    expect(restored.prepare("SELECT title,revision FROM artifact_metadata WHERE artifact_id=?").get(source.first.id)).toEqual({ title: "edited", revision: 2 });
    expect(restored.prepare("SELECT status FROM blob_intents WHERE id='unfinished'").get()).toEqual({ status: "failed" });
    expect(restored.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 0 });
    expect(original.prepare("SELECT status FROM blob_intents WHERE id='unfinished'").get()).toEqual({ status: "uploading" });
    expect(original.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 1 });
  } finally { restored.close(); original.close(); }
  const blob = `sha256/${source.first.content.sha256.slice(0, 2)}/${source.first.content.sha256}`;
  expect(await readFile(`${destination}.blobs/${blob}`)).toEqual(await readFile(`${source.filepath}.blobs/${blob}`));
  await expect(registry.prepareRestore(snapshot, destination)).rejects.toThrow(/already exists/);
  const unsupported = new StoreRegistry("replacement", await root()), manifest = parseManifest(bagRoot)!;
  await loadDeclaredStores(unsupported, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest: { ...manifest, storeRestores: undefined } }]);
  await expect(unsupported.prepareRestore(snapshot, join(unsupported.root, "rejected.db"))).rejects.toThrow(/local restore adapter/);
});
it("restores immutable records, metadata, lineage and retry results into a fresh generation", async () => {
  const source = await fixture(), snapshot = await capture(source), originalBytes = await readFile(snapshot.path);
  const prepared = await prepareLocalArtifactRestore(snapshot, { node: "replacement", identity: "alice", directory: await root(), now: () => restoredAt });
  expect(prepared.generation).not.toBe(prepared.sourceGeneration); expect(prepared.records).toBe(2); expect(prepared.blobs).toBe(1);
  expect(JSON.parse(await readFile(join(prepared.directory, "restore.json"), "utf8"))).toMatchObject({ format: 1, state: "prepared", generation: prepared.generation, sourceChecksum: snapshot.manifest.checksum });
  expect(prepared.binding.filepath).not.toBe(source.filepath); expect(await readFile(snapshot.path)).toEqual(originalBytes);
  const store = await openLocalArtifactStore(prepared.binding);
  try {
    expect(await store.repository.get(source.first.id)).toEqual(source.first);
    expect(await store.repository.get(source.child.id)).toEqual(source.child);
    await store.blobs.verify(source.first.content);
    const database = new Database(prepared.binding.filepath);
    try {
      expect(database.prepare("SELECT status,expires_at FROM blob_intents WHERE id='unfinished'").get()).toEqual({ status: "failed", expires_at: restoredAt });
      expect(database.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT count(*) AS count FROM intent_cleanup").get()).toEqual({ count: 3 });
      expect(() => database.prepare("UPDATE artifact_storage_generation SET token=?").run(prepared.sourceGeneration)).toThrow(/immutable/);
    } finally { database.close(); }
    expect(await creator(store, restoredAt).create(request, bytes())).toEqual(source.first);
    await store.blobs.verify(source.first.content);
  } finally { store.close(); }
  await validateSnapshot(snapshot);
  const original = new Database(source.filepath);
  try { expect(original.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 1 }); } finally { original.close(); }
});
function sourceBinding(source: Awaited<ReturnType<typeof fixture>>) {
  return { node: "desktop", identity: "alice", bag: "artifacts", store: "default", engine: "sqlite" as const, owned_by: "identity" as const, filepath: source.filepath };
}
it("activates the exact filepath while preserving the outgoing catalog, blobs and later records", async () => {
  const source = await fixture(), snapshot = await capture(source), binding = sourceBinding(source);
  const prepared = await prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory: dirname(source.filepath) });
  const old = await openLocalArtifactStore(binding);
  let late: typeof source.first;
  try { late = await creator(old, restoredAt).create({ ...request, idempotencyKey: "later" }, bytes()); } finally { old.close(); }
  const activation = await activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration });
  expect(activation).toMatchObject({ state: "active", filepath: source.filepath, generation: prepared.generation });
  expect(await activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).toEqual(activation);
  const store = await openLocalArtifactStore(binding);
  try {
    expect(await store.repository.get(source.first.id)).toEqual(source.first);
    expect(await store.repository.get(late!.id)).toBeUndefined();
    await store.blobs.verify(source.first.content);
    await creator(store, restoredAt).create({ ...request, idempotencyKey: "new-generation" }, bytes());
  } finally { store.close(); }
  const historical = new Database(join(activation.previous, "catalog.db"), { readonly: true, fileMustExist: true });
  try {
    expect(historical.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 3 });
    expect(historical.prepare("SELECT state FROM artifact_generation_status").get()).toEqual({ state: "sealed" });
    expect(historical.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 1 });
    expect(await readFile(join(`${activation.previous}/catalog.db.blobs/sha256`, source.first.content.sha256.slice(0, 2), source.first.content.sha256))).toEqual(Buffer.from("immutable report"));
  } finally { historical.close(); }
  expect(JSON.parse(await readFile(join(activation.previous, "activation.json"), "utf8"))).toEqual(activation);
  const second = await prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory: dirname(source.filepath) });
  const subsequent = await activateLocalArtifactRestore(second, binding, { servicesStopped: true, expectedGeneration: prepared.generation });
  expect(subsequent.previous).not.toBe(activation.previous);
  expect(JSON.parse(await readFile(join(activation.previous, "activation.json"), "utf8"))).toEqual(activation);
  await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
  await validateSnapshot(snapshot);
});
it("refuses unsafe cutovers before sealing and recovers when a live reader prevents draining", async () => {
  const source = await fixture(), snapshot = await capture(source), binding = sourceBinding(source);
  const prepared = await prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory: dirname(source.filepath) });
  await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: false, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
  await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: "0".repeat(32) })).rejects.toMatchObject({ code: "unavailable" });
  await expect(activateLocalArtifactRestore(prepared, { ...binding, identity: "bob" }, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
  const reader = new Database(source.filepath);
  try {
    expect(reader.prepare("SELECT state FROM artifact_generation_status").get()).toEqual({ state: "active" });
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM artifacts").get();
    await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
    await expect(openLocalArtifactStore(binding)).rejects.toMatchObject({ code: "unavailable" });
    reader.exec("ROLLBACK");
  } finally { reader.close(); }
  expect((await activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).state).toBe("active");
});
it("refuses corrupted candidate content before changing the live generation", async () => {
  const source = await fixture(), snapshot = await capture(source), binding = sourceBinding(source);
  const prepared = await prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory: dirname(source.filepath) });
  const path = join(`${prepared.binding.filepath}.blobs/sha256`, source.first.content.sha256.slice(0, 2), source.first.content.sha256);
  await chmod(path, 0o600); await writeFile(path, "corrupted bytes");
  await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
  await expect(readFile(`${source.filepath}.activation.json`)).rejects.toMatchObject({ code: "ENOENT" });
  const store = await openLocalArtifactStore(binding);
  try { expect(await store.repository.get(source.first.id)).toEqual(source.first); await store.blobs.verify(source.first.content); } finally { store.close(); }
});
it.each(["prepared", "sealed-sql", "old-catalog", "old-blobs", "new-catalog", "new-blobs", "installed", "history", "active"])("recovers an actual SIGKILL at activation boundary %s", async boundary => {
  const source = await fixture(), snapshot = await capture(source), binding = sourceBinding(source);
  const prepared = await prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory: dirname(source.filepath) });
  const module = new URL("../../dist/local/restore.js", import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import Database from 'better-sqlite3';
    import {activateLocalArtifactRestore} from ${JSON.stringify(module)};
    const prepared=JSON.parse(process.argv[1]),binding=JSON.parse(process.argv[2]),boundary=process.argv[3];
    const rename=fs.renameSync;
    fs.renameSync=function(from,to) {
      rename(from,to);
      const journal=to===binding.filepath+'.activation.json' ? JSON.parse(fs.readFileSync(to,'utf8')) : undefined;
      if(journal?.state===boundary || boundary==='old-catalog' && from===binding.filepath
        || boundary==='old-blobs' && from===binding.filepath+'.blobs'
        || boundary==='new-catalog' && from===prepared.binding.filepath
        || boundary==='history' && to.endsWith('/activation.json')
        || boundary==='new-blobs' && from===prepared.binding.filepath+'.blobs') process.kill(process.pid,'SIGKILL');
    }; syncBuiltinESMExports();
    const pragma=Database.prototype.pragma;
    Database.prototype.pragma=function(sql,...args) {
      const value=pragma.call(this,sql,...args);
      if(boundary==='sealed-sql' && this.name===binding.filepath && sql==='journal_mode = DELETE') process.kill(process.pid,'SIGKILL');
      return value;
    };
    await activateLocalArtifactRestore(prepared,binding,{servicesStopped:true,expectedGeneration:prepared.sourceGeneration});
    throw new Error('crash point not reached');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(prepared), JSON.stringify(binding), boundary], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 10000 });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  const pending = JSON.parse(await readFile(`${source.filepath}.activation.json`, "utf8"));
  if (pending.state !== "active") await expect(openLocalArtifactStore(binding)).rejects.toMatchObject({ code: "unavailable" });
  if (boundary === "old-blobs") {
    await symlink(join(source.directory, "missing-user-target"), source.filepath);
    await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
    await unlink(source.filepath);
  }
  if (boundary === "installed") {
    const path = join(`${source.filepath}.blobs/sha256`, source.first.content.sha256.slice(0, 2), source.first.content.sha256);
    await chmod(path, 0o600); await writeFile(path, "corrupted bytes");
    await expect(activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration })).rejects.toMatchObject({ code: "unavailable" });
    await expect(openLocalArtifactStore(binding)).rejects.toMatchObject({ code: "unavailable" });
    await writeFile(path, Buffer.from("immutable report")); await chmod(path, 0o400);
  }
  const activation = await activateLocalArtifactRestore(prepared, binding, { servicesStopped: true, expectedGeneration: prepared.sourceGeneration });
  expect(activation.state).toBe("active");
  const store = await openLocalArtifactStore(binding);
  try { expect(await store.repository.get(source.first.id)).toEqual(source.first); await store.blobs.verify(source.first.content); } finally { store.close(); }
  const historical = new Database(join(activation.previous, "catalog.db"), { readonly: true, fileMustExist: true });
  try { expect(historical.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 2 }); } finally { historical.close(); }
  await validateSnapshot(snapshot);
});
it("refuses foreign owners, unsupported schema and incomplete content without touching an existing generation", async () => {
  const source = await fixture(), snapshot = await capture(source), directory = await root();
  await expect(prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "bob", directory })).rejects.toMatchObject({ code: "forbidden" });
  await expect(prepareLocalArtifactRestore({ ...snapshot, manifest: { ...snapshot.manifest, identity: "bob" } }, { node: "desktop", identity: "bob", directory })).rejects.toMatchObject({ code: "forbidden" });
  await expect(prepareLocalArtifactRestore({ ...snapshot, manifest: { ...snapshot.manifest, schemaVersion: 999 } }, { node: "desktop", identity: "alice", directory })).rejects.toMatchObject({ code: "unavailable" });
  expect(await readdir(directory)).toEqual([]);
  const file = join(`${snapshot.path}.resources/blobs`, snapshot.manifest.resources![0].files[0].path);
  await chmod(file, 0o600); await writeFile(file, "corrupt");
  await expect(prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory })).rejects.toThrow(/integrity/);
  expect(await readdir(directory)).toEqual([]);
  const store = await openLocalArtifactStore({ node: "desktop", identity: "alice", bag: "artifacts", store: "default", engine: "sqlite", owned_by: "identity", filepath: source.filepath });
  try { expect(await store.repository.get(source.first.id)).toEqual(source.first); await store.blobs.verify(source.first.content); } finally { store.close(); }
});
it("refuses unclassified catalog data instead of silently dropping it", async () => {
  const source = await fixture(), database = new Database(source.filepath);
  database.exec("CREATE TABLE important_data(value TEXT); INSERT INTO important_data VALUES('preserved')"); database.close();
  const snapshot = await capture(source), directory = await root();
  await expect(prepareLocalArtifactRestore(snapshot, { node: "desktop", identity: "alice", directory })).rejects.toMatchObject({ code: "unavailable" });
  expect(await readdir(directory)).toEqual([]);
  const catalog = new Database(snapshot.path, { readonly: true, fileMustExist: true });
  try { expect(catalog.prepare("SELECT value FROM important_data").get()).toEqual({ value: "preserved" }); } finally { catalog.close(); }
});
it("restores a sealed historical snapshot into a fresh writable generation", async () => {
  const source = await fixture(), snapshot = await capture(source);
  await chmod(snapshot.path, 0o600);
  const database = new Database(snapshot.path);
  try {
    const generation = (database.prepare("SELECT token FROM artifact_storage_generation").get() as { token: string }).token;
    sealArtifactGeneration(database, "alice", generation, restoredAt);
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally { database.close(); }
  const catalog = await readFile(snapshot.path), checksum = createHash("sha256").update(catalog).digest("hex");
  const resources = snapshot.manifest.resources!.map(resource => ({ name: resource.name, files: [...resource.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const historical = { ...snapshot, manifest: { ...snapshot.manifest, bytes: catalog.length, checksum, revision: createHash("sha256").update(JSON.stringify({ checksum, resources })).digest("hex") } };
  await validateSnapshot(historical);
  const prepared = await prepareLocalArtifactRestore(historical, { node: "desktop", identity: "alice", directory: await root(), now: () => restoredAt });
  const store = await openLocalArtifactStore(prepared.binding);
  try {
    expect(await store.repository.get(source.first.id)).toEqual(source.first);
    const next = await creator(store, restoredAt).create({ ...request, idempotencyKey: "after-restore" }, bytes());
    await store.blobs.verify(next.content);
  } finally { store.close(); }
  expect(await readFile(snapshot.path)).toEqual(catalog);
});

it("a killed native import leaves no prepared candidate and preserves the source", async () => {
  const source = await fixture(), snapshot = await capture(source), directory = await root();
  const before = await readFile(snapshot.path);
  const module = new URL("../../dist/local/restore.js", import.meta.url).href;
  const script = `
    import Database from 'better-sqlite3';
    import { prepareLocalArtifactRestore } from ${JSON.stringify(module)};
    const original = Database.prototype.exec;
    Database.prototype.exec = function(sql) {
      const result = original.call(this,sql);
      if(sql.startsWith('INSERT INTO artifact_metadata SELECT')) process.kill(process.pid,'SIGKILL');
      return result;
    };
    await prepareLocalArtifactRestore(JSON.parse(process.argv[1]),{node:'desktop',identity:'alice',directory:process.argv[2]});
    throw new Error('crash point not reached');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, JSON.stringify(snapshot), directory], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 10000 });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  const entries = await readdir(directory); expect(entries).toHaveLength(1);
  const candidate = join(directory, entries[0]);
  expect(await readdir(candidate)).not.toContain("restore.json");
  const catalog = new Database(join(candidate, "catalog.db"));
  try { expect(catalog.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 0 }); } finally { catalog.close(); }
  expect(await readFile(snapshot.path)).toEqual(before); await validateSnapshot(snapshot);
  const original = new Database(source.filepath);
  try { expect(original.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 2 }); } finally { original.close(); }
});
