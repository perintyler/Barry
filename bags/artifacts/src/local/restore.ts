import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { copySnapshot, storeKey, validateSnapshot, type StoreSnapshot } from "@barry-rocks/sdk/stores";
import type { StoreBinding } from "@barry-rocks/sdk/stores";
import { ArtifactError, IdentityIdSchema, TimestampSchema } from "../types.js";
import { createSqliteArtifactRepository } from "./catalog.js";
import { openLocalArtifactStore } from "./store.js";
import migrations from "../generated/artifacts-migrations.js";
export { activateLocalArtifactRestore } from "./activation.js";

const catalogTables = new Set(["artifact_catalog", "artifacts", "artifact_metadata", "creation_requests", "share_grants", "artifact_storage_generation", "artifact_generation_status", "schema_migrations", "store_resource_requirements", "store_snapshot_files", "blob_intents", "blob_deletions", "blob_gc_completed", "intent_cleanup", "artifact_blob_pins", "artifact_maintenance_progress"]);
const preservedTables = ["artifacts", "artifact_metadata", "creation_requests", "share_grants"];

export async function prepareLocalArtifactRestore(snapshot: StoreSnapshot, options: { node: string; identity: string; directory: string; now?: () => string }) {
  const identity = IdentityIdSchema.parse(options.identity), restoredAt = TimestampSchema.parse((options.now ?? (() => new Date().toISOString()))());
  if (snapshot.manifest.bag !== "artifacts" || snapshot.manifest.store !== "default" || snapshot.manifest.identity !== identity) throw new ArtifactError("forbidden");
  if (!isAbsolute(options.directory)) throw new ArtifactError("unavailable");
  storeKey({ node: options.node, identity, bag: "artifacts", store: "default" });
  await validateSnapshot(snapshot);
  if (snapshot.manifest.schemaVersion !== migrations.length || snapshot.manifest.resources?.length !== 1 || snapshot.manifest.resources[0].name !== "blobs") throw new ArtifactError("unavailable");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(options.directory, ".artifact-restore-")), sourcePath = join(directory, "source.db"), filepath = join(directory, "catalog.db");
  let source: Database.Database | undefined, destination: Database.Database | undefined;
  try {
    await copySnapshot(snapshot, sourcePath);
    await chmod(sourcePath, 0o600);
    source = new Database(sourcePath, { fileMustExist: true });
    if (source.pragma("user_version", { simple: true }) !== migrations.length || source.pragma("integrity_check", { simple: true }) !== "ok" || source.prepare("PRAGMA foreign_key_check").all().length) throw new ArtifactError("unavailable");
    const history = source.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all() as { version: number; name: string; checksum: string }[];
    if (history.length !== migrations.length || history.some((row, index) => row.version !== index + 1 || row.name.replace(/\.sql$/, "") !== migrations[index].name.replace(/\.sql$/, "") || row.checksum !== createHash("sha256").update(migrations[index].sql).digest("hex"))) throw new ArtifactError("unavailable");
    for (const row of source.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").iterate() as Iterable<{ name: string }>) {
      if (!catalogTables.has(row.name)) throw new ArtifactError("unavailable");
    }
    const owner = source.prepare("SELECT identity_id,schema_version FROM artifact_catalog WHERE singleton=1").get() as { identity_id: string; schema_version: number } | undefined;
    if (owner?.identity_id !== identity || owner.schema_version !== 1 || source.prepare("SELECT 1 FROM artifacts WHERE identity_id != ? OR creator_identity_id != ? LIMIT 1").get(identity, identity)) throw new ArtifactError("forbidden");
    const sourceGeneration = (source.prepare("SELECT token FROM artifact_storage_generation WHERE singleton=1").get() as { token: string }).token;
    const files = new Map(snapshot.manifest.resources[0].files.map(file => [file.path, file]));
    for (const row of source.prepare("SELECT sha256,min(size) AS smallest,max(size) AS size FROM artifacts GROUP BY sha256").iterate() as Iterable<{ sha256: string; smallest: number; size: number }>) {
      const path = `sha256/${row.sha256.slice(0, 2)}/${row.sha256}`, file = files.get(path);
      if (!file || row.smallest !== row.size || file.bytes !== row.size || file.checksum !== row.sha256) throw new ArtifactError("unavailable");
      files.delete(path);
    }
    if (files.size) throw new ArtifactError("unavailable");
    const repository = createSqliteArtifactRepository(source, identity);
    let records = 0, cursor: { id: string; createdAt: string } | undefined;
    for (;;) {
      const page = await repository.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      records += page.length;
      if (!page.length) break;
      const last = page.at(-1)!; cursor = { id: last.id, createdAt: last.content.createdAt };
    }
    if (records !== (source.prepare("SELECT count(*) AS count FROM artifacts").get() as { count: number }).count || records !== (source.prepare("SELECT count(*) AS count FROM artifact_metadata").get() as { count: number }).count) throw new ArtifactError("unavailable");
    destination = new Database(filepath);
    createSqliteArtifactRepository(destination, identity);
    for (const table of [...catalogTables].filter(table => table !== "store_snapshot_files")) {
      const before = source.prepare(`PRAGMA table_xinfo(${table})`).all(), after = destination.prepare(`PRAGMA table_xinfo(${table})`).all();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new ArtifactError("unavailable");
    }
    source.close(); source = undefined;
    destination.prepare("ATTACH DATABASE ? AS restore_source").run(sourcePath);
    destination.transaction(() => {
      destination!.pragma("defer_foreign_keys = ON");
      for (const table of preservedTables) destination!.exec(`INSERT INTO ${table} SELECT * FROM restore_source.${table}`);
      // Keep diagnostic rows, but old upload leases cannot protect a new generation.
      destination!.prepare("INSERT INTO blob_intents SELECT id,created_at,min(expires_at,?),CASE WHEN status IN ('uploading','staged','published') THEN 'failed' ELSE status END,sha256,size FROM restore_source.blob_intents").run(restoredAt);
      destination!.prepare("INSERT INTO intent_cleanup SELECT i.id,coalesce(c.cleaned_at,?) FROM restore_source.blob_intents i LEFT JOIN restore_source.intent_cleanup c ON c.intent_id=i.id").run(restoredAt);
    })();
    destination.exec("DETACH DATABASE restore_source");
    const generation = (destination.prepare("SELECT token FROM artifact_storage_generation WHERE singleton=1").get() as { token: string }).token;
    if (generation === sourceGeneration || destination.pragma("integrity_check", { simple: true }) !== "ok" || destination.prepare("PRAGMA foreign_key_check").all().length) throw new ArtifactError("unavailable");
    destination.close(); destination = undefined;
    await rename(`${sourcePath}.resources/blobs`, `${filepath}.blobs`);
    const binding: StoreBinding = Object.freeze({ node: options.node, identity, bag: "artifacts", store: "default", owned_by: "identity", engine: "sqlite", filepath });
    const store = await openLocalArtifactStore(binding);
    try {
      const page = await store.repository.list({ limit: 1 });
      if (records && !page.length) throw new ArtifactError("unavailable");
      for (const file of snapshot.manifest.resources[0].files) await store.blobs.verify({ sha256: file.checksum, size: file.bytes });
    } finally { store.close(); }
    await rm(sourcePath, { force: true }); await rm(`${sourcePath}.resources`, { recursive: true, force: true });
    const handle = await open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    const prepared = Object.freeze({ binding, directory, generation, sourceGeneration, restoredAt, records, blobs: snapshot.manifest.resources[0].files.length });
    const report = await open(join(directory, "restore.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await report.writeFile(JSON.stringify({ format: 1, state: "prepared", ...prepared, sourceChecksum: snapshot.manifest.checksum, sourceRevision: snapshot.manifest.revision })); await report.sync(); }
    finally { await report.close(); }
    for (const path of [directory, options.directory]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    return prepared;
  } catch (error) {
    destination?.close(); source?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
