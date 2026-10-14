import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SqliteDatabase as DatabaseSync } from "@barry-rocks/sdk/internal/stores";
import { coreProvider } from "../services/configuration/index.js";
import { createBackup, listStores, loadDeclaredStores, StoreRegistry, type StoreInfo, type StoreSnapshot, activeStoreRoot } from "@barry-rocks/sdk/internal/stores";

import { readInstallationId } from "@barry-rocks/sdk/internal/nodes";

/** Where a backup keeps the registry-managed stores and the raw copies of the rest. */
export const MANAGED_STORES_DIR = "stores";
export const UNMANAGED_STORES_DIR = "stores-unmanaged";
export const UNMANAGED_DATA_DIR = "unmanaged/data";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const BAG_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/i;

function isSqliteDatabase(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(16);
      const bytesRead = readSync(fd, buffer, 0, 16, 0);
      return bytesRead === 16 && buffer.equals(SQLITE_HEADER);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function generationHoldsStore(generationRoot: string, bag: string, file: string): boolean {
  if (existsSync(join(generationRoot, "node", bag, file))) return true;
  const identitiesDir = join(generationRoot, "identities");
  if (existsSync(identitiesDir)) {
    for (const entry of readdirSync(identitiesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(identitiesDir, entry.name, bag, file))) {
        return true;
      }
    }
  }
  return false;
}

interface DataStoreFile {
  bag: string;
  file: string;
  path: string;
  bytes: number;
  walBytes: number;
}

function discoverDataStores(backupRoot: string, generationRoot: string): DataStoreFile[] {
  const dataRoot = join(barryAppSupportDir(), "data");
  if (!existsSync(dataRoot)) return [];
  const resolvedBackup = resolve(backupRoot);
  const found: DataStoreFile[] = [];

  for (const bagEntry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (bagEntry.isSymbolicLink() || !bagEntry.isDirectory()) continue;
    if (!BAG_NAME_REGEX.test(bagEntry.name)) continue;
    const bagPath = join(dataRoot, bagEntry.name);
    if (existsSync(join(bagPath, "RESTORE.md"))) continue;

    for (const fileEntry of readdirSync(bagPath, { withFileTypes: true })) {
      if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) continue;
      const fileName = fileEntry.name;
      if (fileName.endsWith("-wal") || fileName.endsWith("-shm") || fileName.endsWith("-journal")) continue;

      const fullPath = resolve(join(bagPath, fileName));
      if (fullPath === resolvedBackup || fullPath.startsWith(resolvedBackup + "/")) continue;

      if (!isSqliteDatabase(fullPath)) continue;
      if (generationHoldsStore(generationRoot, bagEntry.name, fileName)) continue;

      let bytes = 0;
      let walBytes = 0;
      try {
        bytes = statSync(fullPath).size;
        const walPath = `${fullPath}-wal`;
        if (existsSync(walPath)) {
          walBytes = statSync(walPath).size;
        }
      } catch {
        continue;
      }

      found.push({
        bag: bagEntry.name,
        file: fileName,
        path: fullPath,
        bytes,
        walBytes,
      });
    }
  }

  return found.sort((a, b) => `${a.bag}/${a.file}`.localeCompare(`${b.bag}/${b.file}`));
}

/**
 * Return <bag>/<file> names found exactly two levels below <directory>/unmanaged/data/, sorted.
 * Returns [] when the section is absent. Real directories and regular files only.
 */
export function backedUpDataStores(directory: string): string[] {
  const root = join(directory, UNMANAGED_DATA_DIR);
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const bagEntry of readdirSync(root, { withFileTypes: true })) {
    if (bagEntry.isSymbolicLink() || !bagEntry.isDirectory()) continue;
    const bagDir = join(root, bagEntry.name);
    for (const fileEntry of readdirSync(bagDir, { withFileTypes: true })) {
      if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) continue;
      found.push(`${bagEntry.name}/${fileEntry.name}`);
    }
  }
  return found.sort();
}

/** Refuse while any of this instance's services is running. */
export async function assertServicesStopped(): Promise<void> {
  const { serviceRequest } = await import("@barry-rocks/mcp-bag");
  const reply = await serviceRequest({ op: "status" });
  if (!reply.services.some(service => service.pid)) return;
  throw new Error("stop Barry before changing stores");
}

export interface ManagedStoreRegistryResult {
  registry: StoreRegistry;
  warning?: string;
  refused: { bag: string; reason: string }[];
}

/**
 * A store registry holding every store this installation's bags declare.
 *
 * A missing or unreadable bag registry leaves only core config declared, so a
 * backup still copies every other store (raw, as unmanaged) rather than
 * failing over an inventory problem.
 */
export async function managedStoreRegistry(nodeId: string, root: string): Promise<ManagedStoreRegistryResult> {
  const registry = new StoreRegistry(nodeId, root);
  registry.register("core", "config", { owned_by: "node", engine: "sqlite", migrations: "core" }, coreProvider);
  const refused: { bag: string; reason: string }[] = [];
  try {
    const { getRegistrySnapshotPath } = await import("@barry-rocks/sdk/internal/bags");
    if (existsSync(getRegistrySnapshotPath())) {
      const { loadBagRegistrySnapshot } = await import("@barry-rocks/sdk/internal/bags");
      const snapshot = await loadBagRegistrySnapshot();
      for (const bag of snapshot.bags) {
        try {
          await loadDeclaredStores(registry, [bag]);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          refused.push({ bag: bag.name, reason });
        }
      }
    } else {
      // A home that has never run `barry up` (a fresh machine being restored)
      // has no registry snapshot yet; the bags that ship with Barry declare
      // every store such a home can hold.
      const { loadBuiltinRegistry } = await import("@barry-rocks/sdk/internal/bags");
      const { parseManifest } = await import("@barry-rocks/sdk/bags");
      const entries = Object.entries(loadBuiltinRegistry());
      for (const [name, source] of entries) {
        if (source.type !== "local") continue;
        try {
          const manifest = parseManifest(source.path);
          await loadDeclaredStores(registry, [{ name, source, manifest }]);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          refused.push({ bag: name, reason });
        }
      }
    }
    if (refused.length > 0) {
      const warning = refused.map(r => `${r.bag}: ${r.reason}`).join("; ");
      return { registry, warning, refused };
    }
    return { registry, refused: [] };
  } catch (error) {
    return { registry, warning: error instanceof Error ? error.message : String(error), refused: [] };
  }
}

/** The same check `barry db backup` applies to every SQLite file it writes. */
export function sqliteIntegrity(path: string, sealedCopy = false): string {
  // A sealed single-file backup may retain a WAL header. SQLite can create
  // sidecars even during read-only inspection; inspect a disposable owned copy.
  const scratch = sealedCopy ? mkdtempSync(join(tmpdir(), "barry-integrity-")) : undefined;
  try {
    const target = scratch ? join(scratch, "snapshot.db") : path;
    if (scratch) copyFileSync(path, target);
    const probe = spawnSync("sqlite3", [target, "pragma integrity_check;"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (probe.error || probe.status !== 0) {
      throw new Error(`${path} could not be verified (sqlite3 exited ${probe.status ?? "abnormally"}): ${(probe.stderr || probe.error?.message || "").trim()}`);
    }
    // Live sources retain SQLite-owned WAL/SHM. Only our closed scratch copy
    // is removed, as a whole directory, after the probe process exits.
    return probe.stdout.trim();
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

/** Only newly owned backup copies may change journal mode; live source files remain untouched. */
function normalizePrivateBackup(path: string): void {
  const database = new DatabaseSync(path);
  try {
    if (database.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new Error(`${path} backup journal could not be normalized`);
  } finally { database.close(); }
}

function declared(registry: StoreRegistry, store: StoreInfo): boolean {
  return registry.declarationsFor(store.scope).some(entry => entry.bag === store.bag && entry.store === store.store);
}

/**
 * Back up every store in the active generation.
 *
 * Declared stores go through the store registry — a consistent snapshot, its
 * bag's snapshot adapter (artifacts' blobs travel this way), and a manifest
 * `barry db restore` can verify. A store no bag declares is copied with
 * SQLite's online backup and reported, so nothing on disk is left out.
 * Returns the lines to print.
 */
/** Headroom a backup leaves on the disk it writes to, so it never fills it. */
const BACKUP_HEADROOM_BYTES = 1024 ** 3;

/**
 * Refuse a backup the destination disk cannot hold with headroom to spare.
 *
 * A full backup is about the size of every store. Running the disk out of
 * space mid-backup fails every other SQLite writer on the machine at the same
 * moment, which is worse than not backing up; so this fails first, loudly,
 * before writing anything.
 */
export function assertBackupFits(stores: readonly { bytes: number; walBytes: number }[], destination: string, free = (path: string) => { const disk = statfsSync(path); return disk.bavail * disk.bsize; }): void {
  const needed = stores.reduce((total, store) => total + store.bytes + store.walBytes, 0);
  assertStoreSpace(needed, destination, "a full backup", free);
}

export function assertStoreSpace(needed: number, destination: string, purpose: string, free = (path: string) => { const disk = statfsSync(path); return disk.bavail * disk.bsize; }): void {
  const available = free(destination);
  if (available < needed + BACKUP_HEADROOM_BYTES) {
    const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    const headroom = purpose === "a full backup" ? `a backup leaves ${gb(BACKUP_HEADROOM_BYTES)} spare` : `keeping ${gb(BACKUP_HEADROOM_BYTES)} spare`;
    const advice = purpose === "a full backup" ? "Free space, or back up to another disk with `barry db backup <destination>`." : "Free space on the stores' disk, then run the command again.";
    throw new Error(`not enough free disk for ${purpose} at ${destination}: the stores are ${gb(needed)} and ${gb(available)} is free (${headroom}). ${advice}`);
  }
}

export async function backupManagedStores(
  backupRoot: string,
  options: { availableSpace?: (path: string) => number } = {},
): Promise<string[]> {
  const root = activeStoreRoot();
  const installationId = readInstallationId(root);
  if (!installationId) return [`  ${MANAGED_STORES_DIR}/ SKIPPED — no installation id (peers.db is missing under ${root})`];
  const stores = await listStores();
  const dataStores = discoverDataStores(backupRoot, root);
  assertBackupFits([...stores, ...dataStores], backupRoot, options.availableSpace);
  const { registry, warning, refused } = await managedStoreRegistry(installationId, root);
  const refusedBags = new Set(refused.map(r => r.bag));
  const lines: string[] = [];
  if (refused.length > 0) {
    for (const r of refused) {
      lines.push(`  ${r.bag}: its store declarations could not be loaded, so its stores were copied to stores-unmanaged/ — ${r.reason}`);
    }
  } else if (warning) {
    lines.push(`  bag inventory unavailable, stores copied unmanaged — ${warning}`);
  }
  const scratch = join(backupRoot, ".snapshots");
  const snapshots: StoreSnapshot[] = [];
  const unmanaged: string[] = [];
  const backedUpData: string[] = [];
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  try {
    for (const store of stores) {
      if (declared(registry, store) && !refusedBags.has(store.bag)) {
        const ref = { node: installationId, ...(store.scope === "identity" ? { identity: store.partitionKey } : {}), bag: store.bag, store: store.store };
        const snapshot = await registry.snapshot(ref, scratch);
        const integrity = sqliteIntegrity(snapshot.path, true);
        if (integrity !== "ok") throw new Error(`${relative(root, store.path)} failed integrity_check: ${integrity.split("\n")[0]}`);
        snapshots.push(snapshot);
        continue;
      }
      const name = relative(root, store.path);
      const destination = join(backupRoot, UNMANAGED_STORES_DIR, name);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const source = new BetterSqlite3(store.path, { readonly: true });
      try { await source.backup(destination); } finally { source.close(); }
      normalizePrivateBackup(destination);
      const integrity = sqliteIntegrity(destination, true);
      if (integrity !== "ok") throw new Error(`${name} failed integrity_check: ${integrity.split("\n")[0]}`);
      unmanaged.push(name);
    }
    for (const dataStore of dataStores) {
      const destination = join(backupRoot, UNMANAGED_DATA_DIR, dataStore.bag, dataStore.file);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(dataStore.path, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare("VACUUM INTO ?").run(destination);
      } finally {
        db.close();
      }
      normalizePrivateBackup(destination);
      const integrity = sqliteIntegrity(destination, true);
      if (integrity !== "ok") throw new Error(`unmanaged/data/${dataStore.bag}/${dataStore.file} failed integrity_check: ${integrity.split("\n")[0]}`);
      backedUpData.push(`${dataStore.bag}/${dataStore.file}`);
    }
    const backup = await createBackup(snapshots, { root: join(backupRoot, MANAGED_STORES_DIR), retainDays: 36_500, move: true });
    const identities = new Set(backup.stores.flatMap(entry => entry.manifest.identity ? [entry.manifest.identity] : []));
    const nodeStores = backup.stores.filter(entry => !entry.manifest.identity).length;
    lines.push(`  ${MANAGED_STORES_DIR}/${backup.id} (${backup.stores.length} stores: ${nodeStores} node, ${backup.stores.length - nodeStores} across ${identities.size} identities; installation ${installationId})`);
    for (const name of unmanaged) lines.push(`  ${UNMANAGED_STORES_DIR}/${name} (no bag declares it; copied with SQLite's online backup)`);
    for (const name of backedUpData) lines.push(`  ${UNMANAGED_DATA_DIR}/${name} (kept outside the store generation; see RESTORE.md)`);
    return lines;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function snapshotStores(): Promise<{ directory: string; lines: string[] }> {
  const directory = join(barryAppSupportDir(), "backups", `database-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { directory, lines: await backupManagedStores(directory) };
}
