import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { StoreBinding } from "@barry-rocks/sdk/stores";
import { ArtifactError, ArtifactContentSchema, IdentityIdSchema, TimestampSchema } from "../types.js";
import { sealArtifactGeneration } from "./catalog.js";
import { readArtifactActivation, type ArtifactActivationJournal } from "./activation-journal.js";
import { openLocalArtifactStore } from "./store.js";
import type { prepareLocalArtifactRestore } from "./restore.js";
import migrations from "../generated/artifacts-migrations.js";
import { verifyArtifactBlobDescriptor } from "./blob-file.js";

type PreparedRestore = Awaited<ReturnType<typeof prepareLocalArtifactRestore>>;
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function syncDirectory(path: string): void {
  const handle = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
function requireFile(path: string): void {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new ArtifactError("unavailable");
}
function saveJournal(journal: ArtifactActivationJournal): void {
  const temporary = `${journal.filepath}.activation-${randomUUID()}`;
  const handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(handle, JSON.stringify(journal)); fsyncSync(handle); }
  finally { closeSync(handle); }
  renameSync(temporary, `${journal.filepath}.activation.json`);
  syncDirectory(dirname(journal.filepath));
}
function movePreserved(source: string, destination: string, optional = false): void {
  if (pathExists(destination)) {
    if (pathExists(source)) throw new ArtifactError("unavailable");
    return;
  }
  if (!pathExists(source)) { if (optional) return; throw new ArtifactError("unavailable"); }
  const file = lstatSync(source);
  if (file.isSymbolicLink() || (!file.isFile() && !file.isDirectory())) throw new ArtifactError("unavailable");
  renameSync(source, destination);
  syncDirectory(dirname(source)); syncDirectory(dirname(destination));
}
function checkCatalog(filepath: string, identity: string, generation: string, state: "active" | "sealed"): void {
  requireFile(filepath);
  const database = new Database(filepath, { readonly: true, fileMustExist: true, timeout: 100 });
  try {
    const owner = database.prepare("SELECT identity_id FROM artifact_catalog WHERE singleton=1").get() as { identity_id: string } | undefined;
    if (owner?.identity_id !== identity) throw new ArtifactError("forbidden");
    const current = database.prepare("SELECT token FROM artifact_storage_generation WHERE singleton=1").get() as { token: string } | undefined;
    const status = database.prepare("SELECT state FROM artifact_generation_status WHERE singleton=1").get() as { state: string } | undefined;
    if (current?.token !== generation || status?.state !== state) throw new ArtifactError("unavailable");
    const history = database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all() as { version: number; name: string; checksum: string }[];
    if (database.pragma("user_version", { simple: true }) !== migrations.length || history.length !== migrations.length
      || history.some((entry, index) => entry.version !== index + 1 || entry.name !== migrations[index].name
        || entry.checksum !== createHash("sha256").update(migrations[index].sql).digest("hex"))) throw new ArtifactError("unavailable");
    if (database.pragma("integrity_check", { simple: true }) !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new ArtifactError("unavailable");
  } finally { database.close(); }
}
function verifyInstalledContent(filepath: string): void {
  const database = new Database(filepath, { readonly: true, fileMustExist: true });
  try {
    for (const blob of database.prepare("SELECT sha256,size FROM artifacts GROUP BY sha256,size").iterate() as Iterable<{ sha256: string; size: number }>) {
      ArtifactContentSchema.unwrap().shape.sha256.parse(blob.sha256);
      const root = `${filepath}.blobs`, hashes = join(root, "sha256"), bucket = join(hashes, blob.sha256.slice(0, 2));
      for (const path of [root, hashes, bucket]) {
        const directory = lstatSync(path);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ArtifactError("unavailable");
      }
      const path = join(bucket, blob.sha256), handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { verifyArtifactBlobDescriptor(handle, blob, path); } finally { closeSync(handle); }
    }
  } finally { database.close(); }
}
export async function activateLocalArtifactRestore(prepared: PreparedRestore, binding: StoreBinding, options: {
  servicesStopped: boolean; expectedGeneration: string; now?: () => string;
}): Promise<ArtifactActivationJournal> {
  if (!options.servicesStopped) throw new ArtifactError("unavailable");
  const identity = IdentityIdSchema.parse(binding.identity), filepath = binding.filepath;
  if (binding.bag !== "artifacts" || binding.store !== "default" || binding.engine !== "sqlite" || binding.owned_by !== "identity"
    || !filepath || !isAbsolute(filepath) || prepared.binding.identity !== identity || prepared.binding.node !== binding.node
    || !prepared.binding.filepath || !isAbsolute(prepared.directory) || prepared.binding.filepath !== join(prepared.directory, "catalog.db")
    || filepath === prepared.binding.filepath || !/^[a-f0-9]{32}$/.test(options.expectedGeneration)
    || prepared.generation === options.expectedGeneration) throw new ArtifactError("unavailable");
  const parent = dirname(filepath), candidate = prepared.binding.filepath, lockPath = `${filepath}.activation.db`;
  const reportPath = join(prepared.directory, "restore.json"); requireFile(reportPath);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as PreparedRestore & { format: number; state: string };
  if (report.format !== 1 || report.state !== "prepared" || report.directory !== prepared.directory || report.generation !== prepared.generation
    || report.binding.filepath !== candidate || report.binding.identity !== identity || report.binding.node !== binding.node) throw new ArtifactError("unavailable");
  const candidateDirectory = lstatSync(prepared.directory);
  if (!candidateDirectory.isDirectory() || candidateDirectory.isSymbolicLink() || candidateDirectory.dev !== lstatSync(parent).dev) throw new ArtifactError("unavailable");
  if (!pathExists(lockPath)) {
    try { const handle = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(handle); syncDirectory(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  requireFile(lockPath);
  const lock = new Database(lockPath, { timeout: 100 });
  let locked = false;
  try {
    // SQLite releases this operator lock on process death; the synced journal survives it.
    lock.exec("BEGIN IMMEDIATE"); locked = true;
    let journal = readArtifactActivation(filepath);
    if (journal && journal.state !== "active") {
      if (journal.identity !== identity || journal.candidate !== candidate || journal.generation !== prepared.generation
        || journal.previousGeneration !== options.expectedGeneration || journal.previous !== `${filepath}.previous-${journal.id}`) throw new ArtifactError("unavailable");
    } else if (journal?.candidate === candidate && journal.generation === prepared.generation) {
      if (journal.identity !== identity || journal.previousGeneration !== options.expectedGeneration) throw new ArtifactError("unavailable");
      checkCatalog(filepath, identity, prepared.generation, "active");
      verifyInstalledContent(filepath);
      checkCatalog(join(journal.previous, "catalog.db"), identity, options.expectedGeneration, "sealed");
      return Object.freeze(journal);
    } else {
      checkCatalog(filepath, identity, options.expectedGeneration, "active");
      checkCatalog(candidate, identity, prepared.generation, "active");
      const store = await openLocalArtifactStore(prepared.binding);
      try {
        let cursor: { id: string; createdAt: string } | undefined;
        for (;;) {
          const page = await store.repository.list({ limit: 100, ...(cursor ? { cursor } : {}) });
          for (const record of page) await store.blobs.verify(record.content);
          if (!page.length) break;
          const last = page.at(-1)!; cursor = { id: last.id, createdAt: last.content.createdAt };
        }
      } finally { store.close(); }
      const id = randomUUID(), previous = `${filepath}.previous-${id}`;
      mkdirSync(previous, { mode: 0o700 }); syncDirectory(parent);
      journal = { format: 1, id, state: "prepared", filepath, identity, candidate, previous, generation: prepared.generation, previousGeneration: options.expectedGeneration };
      saveJournal(journal);
    }
    const save = (state: ArtifactActivationJournal["state"]) => { journal = { ...journal!, state }; saveJournal(journal); };
    if (journal.state === "prepared") {
      requireFile(filepath);
      const database = new Database(filepath, { fileMustExist: true, timeout: 100 });
      try {
        sealArtifactGeneration(database, identity, options.expectedGeneration, TimestampSchema.parse((options.now ?? (() => new Date().toISOString()))()));
        const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
        if (checkpoint.some(row => row.busy)) throw new ArtifactError("unavailable");
        if (database.pragma("journal_mode = DELETE", { simple: true }) !== "delete") throw new ArtifactError("unavailable");
      } finally { database.close(); }
      save("sealed");
    }
    if (journal.state === "sealed") {
      const historical = join(journal.previous, "catalog.db");
      checkCatalog(pathExists(historical) ? historical : filepath, identity, options.expectedGeneration, "sealed");
      for (const suffix of ["", "-wal", "-shm", ".blobs"]) movePreserved(`${filepath}${suffix}`, `${historical}${suffix}`, suffix === "-wal" || suffix === "-shm");
      save("preserved");
    }
    if (journal.state === "preserved") {
      checkCatalog(pathExists(candidate) ? candidate : filepath, identity, prepared.generation, "active");
      if (pathExists(candidate)) {
        const database = new Database(candidate, { fileMustExist: true, timeout: 100 });
        try {
          if (database.pragma("journal_mode = DELETE", { simple: true }) !== "delete") throw new ArtifactError("unavailable");
        } finally { database.close(); }
      }
      movePreserved(candidate, filepath);
      movePreserved(`${candidate}.blobs`, `${filepath}.blobs`);
      save("installed");
    }
    if (journal.state === "installed") {
      checkCatalog(filepath, identity, prepared.generation, "active");
      verifyInstalledContent(filepath);
      const sidecar = lstatSync(`${filepath}.blobs`);
      if (!sidecar.isDirectory() || sidecar.isSymbolicLink()) throw new ArtifactError("unavailable");
      checkCatalog(join(journal.previous, "catalog.db"), identity, options.expectedGeneration, "sealed");
      const evidence = join(journal.previous, "activation.json");
      if (!pathExists(evidence)) {
        const temporary = join(journal.previous, `.activation-${randomUUID()}`);
        const handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(handle, JSON.stringify({ ...journal, state: "active" })); fsyncSync(handle); } finally { closeSync(handle); }
        renameSync(temporary, evidence);
        syncDirectory(journal.previous);
      } else {
        requireFile(evidence);
        if (JSON.stringify(JSON.parse(readFileSync(evidence, "utf8"))) !== JSON.stringify({ ...journal, state: "active" })) throw new ArtifactError("unavailable");
      }
      save("active");
    }
    return Object.freeze(journal);
  } finally {
    if (locked) lock.exec("ROLLBACK");
    lock.close();
  }
}
