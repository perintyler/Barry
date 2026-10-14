import Database from "better-sqlite3";
import { chmod, mkdtemp, rm, stat, symlink, readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeAll, expect, it } from "vitest";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { StoreRegistry, loadDeclaredStores, storePath, loadSqlMigrations, validateSnapshot, createBackup, installSnapshot } from "@barry-rocks/sdk/internal/stores";
import { withArtifactStore, openLocalArtifactStore } from "../index.js";
import { createArtifactCreator } from "../create.js";
import { createSqliteArtifactRepository, sealArtifactGeneration } from "./catalog.js";
import { createLocalArtifactBlobs } from "./blobs.js";

const directories: string[] = [];
beforeAll(() => { execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "--build"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "pipe" }); });
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const bagRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = parseManifest(bagRoot)!;
const bags = { artifacts: { stores: manifest.stores! } };
it("serializes sealing against a native writer in another process", async () => {
  const directory = await root(), filepath = join(directory, "catalog.db"), database = new Database(filepath);
  try {
    createSqliteArtifactRepository(database, "alice");
    const generation = (database.prepare("SELECT token FROM artifact_storage_generation").get() as { token: string }).token;
    const module = new URL("../../dist/local/catalog.js", import.meta.url).href;
    const script = `import Database from 'better-sqlite3'; import {sealArtifactGeneration} from ${JSON.stringify(module)};
      const db = new Database(process.argv[1],{timeout:100});
      try { sealArtifactGeneration(db,'alice',process.argv[2],'2026-10-03T20:00:00.000Z'); }
      catch(error) { if(error.code==='SQLITE_BUSY') process.exitCode=2; else throw error; }
      finally { db.close(); }`;
    const run = () => spawnSync(process.execPath, ["--input-type=module", "--eval", script, filepath, generation], { cwd: bagRoot, encoding: "utf8", timeout: 10000 });
    database.exec("BEGIN IMMEDIATE");
    expect(run().status).toBe(2);
    database.exec("ROLLBACK");
    expect(database.prepare("SELECT state FROM artifact_generation_status").get()).toEqual({ state: "active" });
    const sealed = run(); expect(sealed.status, sealed.stderr).toBe(0);
    expect(database.prepare("SELECT state FROM artifact_generation_status").get()).toEqual({ state: "sealed" });
    expect(() => database.prepare("INSERT INTO artifact_maintenance_progress VALUES ('late','late')").run()).toThrow(/sealed/);
  } finally { database.close(); }
});
it("seals a generation permanently and fences retained catalog, blob and maintenance handles", async () => {
  const directory = await root(), filepath = join(directory, "catalog.db");
  const binding = { node: "desktop", identity: "alice", bag: "artifacts", store: "default", owned_by: "identity" as const, engine: "sqlite" as const, filepath };
  const store = await openLocalArtifactStore(binding), database = new Database(filepath), retained = new Database(filepath);
  const sealedAt = "2026-10-03T20:00:00.000Z";
  try {
    const generation = (database.prepare("SELECT token FROM artifact_storage_generation").get() as { token: string }).token;
    store.repository.beginIntent({ id: "retained", createdAt: sealedAt, expiresAt: "2026-10-03T20:02:00.000Z" });
    expect(() => sealArtifactGeneration(database, "bob", generation, sealedAt)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => sealArtifactGeneration(database, "alice", "0".repeat(32), sealedAt)).toThrow(expect.objectContaining({ code: "unavailable" }));
    database.exec("BEGIN IMMEDIATE");
    expect(() => sealArtifactGeneration(database, "alice", generation, sealedAt)).toThrow(expect.objectContaining({ code: "unavailable" }));
    database.exec("ROLLBACK");
    expect(database.prepare("SELECT state FROM artifact_generation_status").get()).toEqual({ state: "active" });
    sealArtifactGeneration(database, "alice", generation, sealedAt);
    sealArtifactGeneration(database, "alice", generation, "2026-10-03T20:01:00.000Z");
    expect(database.prepare("SELECT state,sealed_at FROM artifact_generation_status").get()).toEqual({ state: "sealed", sealed_at: sealedAt });
    expect(database.prepare("SELECT token FROM artifact_storage_generation").get()).toEqual({ token: generation });
    expect(() => store.repository.failIntent("retained")).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(() => store.repository.transaction(() => undefined)).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(() => store.maintenance.run()).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(() => store.maintenance.pin("late", ["a".repeat(64)])).toThrow(expect.objectContaining({ code: "unavailable" }));
    await expect(store.blobs.stage("late", bytes("late"))).rejects.toMatchObject({ code: "unavailable" });
    await chmod(store.blobs.directory, 0o750);
    await expect(createLocalArtifactBlobs(filepath)).rejects.toMatchObject({ code: "unavailable" });
    expect((await stat(store.blobs.directory)).mode & 0o777).toBe(0o750);
    await expect(openLocalArtifactStore(binding)).rejects.toMatchObject({ code: "unavailable" });
    const statements = [
      "UPDATE blob_intents SET status='failed' WHERE id='retained'",
      "DELETE FROM blob_intents WHERE id='retained'",
      "INSERT INTO artifact_maintenance_progress VALUES ('late','late')",
      "INSERT INTO artifact_blob_pins VALUES ('late','" + "a".repeat(64) + "')",
      "UPDATE schema_migrations SET checksum='changed' WHERE version=1",
      "UPDATE artifact_generation_status SET state='active',sealed_at=NULL",
      "DELETE FROM artifact_generation_status",
      "INSERT OR REPLACE INTO artifact_generation_status VALUES (1,'active',NULL)",
    ];
    for (const sql of statements) expect(() => retained.exec(sql), sql).toThrow(/sealed|unsealed|retained|replaced/);
    expect(database.prepare("SELECT status FROM blob_intents WHERE id='retained'").get()).toEqual({ status: "uploading" });
    expect(await createSqliteArtifactRepository(retained, "alice").list({ limit: 1 })).toEqual([]);
  } finally { retained.close(); database.close(); store.close(); }
});
async function root() { const path = await mkdtemp(join(tmpdir(), "barry-artifact-registry-")); directories.push(path); return path; }
async function* bytes(text: string) { yield Buffer.from(text); }
it("declares one identity-owned store normalized to default", () => {
  expect(manifest.stores).toEqual({ default: { owned_by: "identity", engine: "sqlite", migrations: "./migrations/artifacts" } });
});
it("concurrent identity contexts resolve isolated physical catalogs and bytes", async () => {
  const directory = await root();
  const capture = (identity: string) => withStoreContext({ node: "desktop", root: directory, identity, bags }, () => withArtifactStore(async store => {
    const creator = createArtifactCreator({ repository: store.repository, blobs: store.blobs, now: () => new Date().toISOString(), newId: randomUUID, hashText: async text => createHash("sha256").update(text).digest("hex"), access: { async authorize() { return { actorId: 1, identityId: identity, credentialId: "fixture" }; } } });
    const artifact = await creator.create({ filename: "report.txt", mimeType: "text/plain", kind: "text", idempotencyKey: "same-event" }, bytes(identity));
    await store.blobs.verify(artifact.content);
    return { artifact, filepath: store.binding.filepath, blobs: store.blobs.directory };
  }));
  const [alice, bob] = await Promise.all([capture("alice"), capture("bob")]);
  expect(alice.filepath).toBe(storePath({ node: "desktop", identity: "alice", bag: "artifacts", store: "default" }, "identity", directory));
  expect(bob.filepath).not.toBe(alice.filepath); expect(bob.artifact.content.sha256).not.toBe(alice.artifact.content.sha256);
  expect(alice.blobs).toBe(`${alice.filepath}.blobs`); expect((await stat(alice.filepath)).mode & 0o777).toBe(0o600);
});
it("uses the exact configured filepath and refuses another identity claiming it", async () => {
  const directory = await root(), filepath = join(directory, "nested", "exact.sqlite");
  const configured = { artifacts: { ...bags.artifacts, overrides: { default: { filepath } } } };
  await withStoreContext({ identity: "alice", bags: configured, root: directory }, () => withArtifactStore(async store => {
    expect(store.binding.filepath).toBe(filepath); expect(store.blobs.directory).toBe(`${filepath}.blobs`);
  }));
  await expect(withStoreContext({ identity: "bob", bags: configured, root: directory }, () => withArtifactStore(async () => undefined))).rejects.toMatchObject({ code: "forbidden" });
});
it("requires a bound identity and refuses remote bindings before opening any local files", async () => {
  const directory = await root();
  await expect(withArtifactStore(async () => undefined)).rejects.toThrow(/execution context/);
  await expect(withStoreContext({ root: directory, bags }, () => withArtifactStore(async () => undefined))).rejects.toThrow(/execution identity/);
  await expect(withStoreContext({ root: directory, identity: "alice", bags: { artifacts: { ...bags.artifacts, overrides: { default: { url: "https://example.invalid" } }, remoteProtocols: ["https:"] } } }, () => withArtifactStore(async () => undefined))).rejects.toMatchObject({ code: "unavailable" });
});
it("closes the owned connection even when the operation throws", async () => {
  const directory = await root(); let retained: Awaited<ReturnType<typeof openLocalArtifactStore>> | undefined;
  await expect(withStoreContext({ root: directory, identity: "alice", bags }, () => withArtifactStore(async store => { retained = store; throw new Error("operation failed"); }))).rejects.toThrow("operation failed");
  await expect(retained!.repository.get("missing")).rejects.toThrow(/not open|closed/i); retained!.close();
});
it("registry snapshots refuse a database-only artifact backup", async () => {
  const directory = await root(), registry = new StoreRegistry("desktop", directory);
  await loadDeclaredStores(registry, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest: { ...manifest, storeSnapshots: undefined } }]);
  await withStoreContext({ node: "desktop", root: directory, identity: "alice", bags }, () => withArtifactStore(async () => undefined));
  await expect(registry.snapshot({ node: "desktop", identity: "alice", bag: "artifacts", store: "default" }, join(directory, "snapshots"))).rejects.toThrow(/resource snapshot provider/);
});
it("registry-created schemas and local catalogs share one checksummed migration history", async () => {
  const directory = await root(), registry = new StoreRegistry("desktop", directory), ref = { node: "desktop", identity: "alice", bag: "artifacts", store: "default" };
  await loadDeclaredStores(registry, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest }]);
  const handle = await registry.open(ref); expect(handle.schemaVersion()).toBe(6); handle.close();
  const database = new Database(storePath(ref, "identity", directory));
  try {
    createSqliteArtifactRepository(database, "alice");
    const history = database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as { version: number; name: string; checksum: string }[];
    expect(history.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const authored = loadSqlMigrations(bagRoot, "./migrations/artifacts");
    expect(history.map(row => row.checksum)).toEqual(authored.map(migration => createHash("sha256").update(migration.sql).digest("hex")));
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_schema_migrations'").get()).toBeUndefined();
  } finally { database.close(); }
});
it("refuses a symlinked explicit database without touching its target", async () => {
  const directory = await root(), target = join(directory, "target.txt"), filepath = join(directory, "alias.db");
  const { writeFile } = await import("node:fs/promises"); await writeFile(target, "preserve"); await symlink(target, filepath);
  await expect(openLocalArtifactStore({ node: "desktop", identity: "alice", bag: "artifacts", store: "default", owned_by: "identity", engine: "sqlite", filepath })).rejects.toMatchObject({ code: "unavailable" });
  expect(await readFile(target, "utf8")).toBe("preserve");
});

it("adopts the initial artifact catalog format without losing records or its generation", async () => {
  const directory = await root(), database = new Database(join(directory, "legacy.db"));
  try {
    const authored = loadSqlMigrations(bagRoot, "./migrations/artifacts");
    for (const migration of authored.slice(0, 3)) database.exec(migration.sql);
    database.prepare("INSERT INTO artifact_catalog VALUES (1, 'alice', 1)").run();
    database.prepare("INSERT INTO artifacts VALUES ('saved', 'alice', 'report.txt', 'text/plain', 1, ?, 'text', '2026-10-03T00:00:00.000Z', 7, 'alice', NULL, NULL)").run("a".repeat(64));
    database.prepare("INSERT INTO artifact_metadata VALUES ('saved', 'Original title', ?, 1, '2026-10-03T00:00:00.000Z')").run(JSON.stringify(["tag"]));
    const generation = database.prepare("SELECT token FROM artifact_storage_generation").get();
    const repository = createSqliteArtifactRepository(database, "alice");
    expect((await repository.get("saved"))?.metadata).toMatchObject({ title: "Original title", tags: ["tag"], revision: 1 });
    expect(database.prepare("SELECT token FROM artifact_storage_generation").get()).toEqual(generation);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
  } finally { database.close(); }
});
it("refuses an unsupported initial-format schema before replacing its migration evidence", async () => {
  const directory = await root(), database = new Database(join(directory, "future.db"));
  try {
    database.exec("CREATE TABLE artifact_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT); INSERT INTO artifact_schema_migrations VALUES (99, 'future');");
    expect(() => createSqliteArtifactRepository(database, "alice")).toThrow(/unavailable/);
    expect(database.prepare("SELECT version FROM artifact_schema_migrations").get()).toEqual({ version: 99 });
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").get()).toBeUndefined();
  } finally { database.close(); }
});

it("backs up a consistent artifact catalog together with independent deduplicated bytes", async () => {
  const directory = await root(), registry = new StoreRegistry("desktop", directory);
  await loadDeclaredStores(registry, [{ name: "artifacts", source: { type: "local", path: bagRoot }, manifest }]);
  const ref = { node: "desktop", identity: "alice", bag: "artifacts", store: "default" };
  await withStoreContext({ node: "desktop", root: directory, identity: "alice", bags }, () => withArtifactStore(async store => {
    const creator = createArtifactCreator({ repository: store.repository, blobs: store.blobs, now: () => new Date().toISOString(), newId: randomUUID, hashText: async text => createHash("sha256").update(text).digest("hex"), access: { async authorize() { return { actorId: 1, identityId: "alice", credentialId: "fixture" }; } } });
    for (const [key, content] of [["first", "report"], ["second", "report"], ["empty", ""]]) await creator.create({ filename: "report.txt", mimeType: "text/plain", kind: "text", idempotencyKey: key }, bytes(content));
  }));
  const snapshot = await registry.snapshot(ref, join(directory, "snapshots"));
  expect(snapshot.manifest.resources![0].files).toHaveLength(2);
  await validateSnapshot(snapshot);
  const catalog = new Database(snapshot.path, { readonly: true, fileMustExist: true });
  try {
    expect(catalog.prepare("SELECT count(*) AS count FROM artifacts").get()).toEqual({ count: 3 });
    expect(catalog.prepare("SELECT count(*) AS count FROM store_snapshot_files").get()).toEqual({ count: 2 });
  } finally { catalog.close(); }
  const source = new Database(storePath(ref, "identity", directory));
  try { expect(source.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 0 }); } finally { source.close(); }
  const installed = await installSnapshot(snapshot, join(directory, "family"));
  const backupRoot = join(directory, "backups"), backup = await createBackup([snapshot], { root: backupRoot });
  for (const file of snapshot.manifest.resources![0].files) {
    await unlink(join(`${storePath(ref, "identity", directory)}.blobs`, file.path));
    await unlink(join(`${snapshot.path}.resources`, "blobs", file.path));
  }
  await validateSnapshot(installed);
  const backupSnapshot = { path: join(backupRoot, backup.id, "0.db"), manifest: snapshot.manifest };
  await validateSnapshot(backupSnapshot);
  const resources = [{ name: "blobs", files: [snapshot.manifest.resources![0].files[0]] }];
  await expect(validateSnapshot({ ...backupSnapshot, manifest: { ...snapshot.manifest, resources } })).rejects.toThrow(/catalog index/);
});
it("preserves preexisting snapshot destinations and clears pins after missing-content failure", async () => {
  const directory = await root(), filepath = join(directory, "catalog.db"), store = await openLocalArtifactStore({ node: "desktop", identity: "alice", bag: "artifacts", store: "default", engine: "sqlite", owned_by: "identity", filepath });
  try {
    const destination = join(directory, "snapshot.db");
    await writeFile(destination, "existing");
    await expect(store.snapshot(destination)).rejects.toMatchObject({ code: "unavailable" });
    expect(await readFile(destination, "utf8")).toBe("existing"); await unlink(destination);
    await mkdir(`${destination}.resources`); await writeFile(`${destination}.resources/user-file`, "preserved");
    await expect(store.snapshot(destination)).rejects.toMatchObject({ code: "unavailable" });
    expect(await readFile(`${destination}.resources/user-file`, "utf8")).toBe("preserved");
    const creator = createArtifactCreator({ repository: store.repository, blobs: store.blobs, now: () => new Date().toISOString(), newId: randomUUID, hashText: async text => createHash("sha256").update(text).digest("hex"), access: { async authorize() { return { actorId: 1, identityId: "alice", credentialId: "fixture" }; } } });
    const artifact = await creator.create({ filename: "lost.txt", mimeType: "text/plain", kind: "text", idempotencyKey: "lost" }, bytes("lost"));
    await unlink(join(store.blobs.directory, "sha256", artifact.content.sha256.slice(0, 2), artifact.content.sha256));
    const failed = join(directory, "failed.db");
    await expect(store.snapshot(failed)).rejects.toThrow();
    await expect(stat(failed)).rejects.toMatchObject({ code: "ENOENT" });
    const db = new Database(filepath);
    try { expect(db.prepare("SELECT count(*) AS count FROM artifact_blob_pins").get()).toEqual({ count: 0 }); } finally { db.close(); }
  } finally { store.close(); }
});
