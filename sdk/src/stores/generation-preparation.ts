import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "./sqlite-connection.js";
import { z } from "zod";
import { acquireStoreGenerationLock, requireStoreGenerationActive } from "./generation-activation.js";
import { digestSnapshotFile } from "./snapshot-resources.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).refine(id => !id.includes(".."));
const relativePath = z.string().min(1).refine(path => !isAbsolute(path) && path.split("/").every(part => part && part !== "." && part !== ".."));
const fileSchema = z.strictObject({ path: relativePath, bytes: z.number().int().nonnegative().safe(), checksum: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number().int().min(0).max(0o777) });
const directorySchema = z.strictObject({ path: relativePath, mode: z.number().int().min(0).max(0o777) });
const preparedSchema = z.strictObject({
  format: z.literal(1), state: z.literal("prepared"), root: z.string(), id: identifier, previousId: identifier,
  source: identifier.optional(), directory: z.string(), selectorChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(fileSchema).max(1_000_000), directories: z.array(directorySchema).max(1_000_000),
});
export type PreparedStoreGeneration = z.infer<typeof preparedSchema>;
interface TreeEntry { path: string; directory: boolean; mode: number; empty: boolean; version: string }
const RECEIPT_LIMIT = 64 * 1024 * 1024;
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function requireDirectory(path: string): Promise<void> {
  const file = await lstat(path);
  if (!file.isDirectory() || file.isSymbolicLink()) throw new Error("invalid store generation directory");
}
async function readRecord(path: string, limit = RECEIPT_LIMIT): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size > limit) throw new Error("invalid store preparation record");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function saveRecord(root: string, id: string, record: unknown): Promise<void> {
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > RECEIPT_LIMIT) throw new Error("store preparation receipt exceeds its limit");
  const directory = join(root, "preparations");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await requireDirectory(directory);
  const temporary = join(directory, `.preparation-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, join(directory, `${id}.json`));
  await syncDirectory(directory); await syncDirectory(root);
}
async function readTree(root: string, maximum: number): Promise<TreeEntry[]> {
  await requireDirectory(root);
  const entries: TreeEntry[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(join(root, directory))).sort()) {
      if (entries.length >= maximum) throw new Error("store generation entry limit exceeded");
      const path = directory ? `${directory}/${name}` : name, file = await lstat(join(root, path), { bigint: true });
      if (file.isSymbolicLink() || (!file.isFile() && !file.isDirectory())) throw new Error(`unsupported store generation entry ${path}`);
      const isDirectory = file.isDirectory();
      entries.push({ path, directory: isDirectory, mode: Number(file.mode & 0o777n), empty: file.size === 0n, version: isDirectory ? `${file.dev}:${file.ino}` : `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` });
      if (isDirectory) await visit(path);
    }
  }
  await visit(""); return entries;
}
function isStoreDatabase(path: string): boolean {
  const parts = path.split("/");
  return (parts[0] === "node" && parts.length === 3 || parts[0] === "identities" && parts.length === 4) && path.endsWith(".db");
}
async function isSqlite(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 16 && header.toString("binary") === "SQLite format 3\0";
  } finally { await handle.close(); }
}
async function copyDatabase(source: string, destination: string): Promise<void> {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=1000");
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("invalid source store database");
    const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await output.close();
    await database.backup(destination);
  } finally { database.close(); }
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function normalizeStoreDatabases(directory: string, maximum: number): Promise<void> {
  for (const entry of await readTree(directory, maximum)) {
    if (entry.directory || !isStoreDatabase(entry.path) || !await isSqlite(join(directory, entry.path))) continue;
    const filepath = join(directory, entry.path), parent = dirname(filepath), parentMode = (await lstat(parent)).mode & 0o777;
    await chmod(parent, parentMode | 0o700);
    await chmod(filepath, entry.mode | 0o600);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(filepath);
      database.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
      if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || database.prepare("PRAGMA foreign_key_check").get()) throw new Error("invalid private store database");
      if (database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 0) throw new Error("drain private store handles before preparation");
      // Read-only validators must not create WAL bookkeeping after the receipt is sealed.
      if (database.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new Error("drain private store handles before preparation");
    } finally {
      try { database?.close(); } finally { await chmod(filepath, entry.mode); await chmod(parent, parentMode); }
    }
    const handle = await open(filepath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
async function describeFiles(directory: string, tree: TreeEntry[]): Promise<PreparedStoreGeneration["files"]> {
  const files: PreparedStoreGeneration["files"] = [];
  for (const entry of tree) if (!entry.directory) files.push({ path: entry.path, ...await digestSnapshotFile(join(directory, entry.path)), mode: entry.mode });
  return files;
}
export async function prepareStoreGeneration(options: {
  root: string; previousId: string; source?: string; servicesStopped: boolean; maximumEntries?: number; id?: string;
  build?(directory: string, source: string): Promise<void>;
}): Promise<PreparedStoreGeneration> {
  const { root, previousId } = options, maximum = options.maximumEntries ?? 200_000;
  identifier.parse(previousId);
  if (!options.servicesStopped) throw new Error("stop and drain affected services before preparing stores");
  if (!isAbsolute(root) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000) throw new Error("invalid store generation preparation");
  await requireDirectory(root); await requireDirectory(join(root, "generations"));
  const id = identifier.parse(options.id ?? randomUUID()), sourceId = identifier.parse(options.source ?? previousId);
  if (id === previousId) throw new Error("candidate is the outgoing generation");
  if (id === sourceId) throw new Error("candidate is the source generation");
  const release = acquireStoreGenerationLock(root), directory = join(root, "generations", id);
  let recorded = false;
  const record = { format: 1, root, id, previousId, directory, ...(sourceId !== previousId ? { source: sourceId } : {}) };
  try {
    requireStoreGenerationActive(root);
    const selector = await readRecord(join(root, "active.json"), 16_384);
    if (z.object({ id: identifier }).parse(JSON.parse(selector)).id !== previousId) throw new Error("outgoing generation no longer selected");
    const selectorChecksum = createHash("sha256").update(selector).digest("hex"), sourceDirectory = join(root, "generations", sourceId);
    await requireDirectory(sourceDirectory);
    await saveRecord(root, id, { ...record, state: "preparing", selectorChecksum }); recorded = true;
    await mkdir(directory, { mode: 0o700 }); await syncDirectory(join(root, "generations"));
    const source = await readTree(sourceDirectory, maximum), databases = new Set<string>();
    for (const entry of source) if (!entry.directory && isStoreDatabase(entry.path) && await isSqlite(join(sourceDirectory, entry.path))) databases.add(entry.path);
    const companions = new Set([...databases].flatMap(path => [`${path}-wal`, `${path}-shm`]));
    for (const entry of source) {
      const destination = join(directory, entry.path);
      if (entry.directory) await mkdir(destination, { mode: 0o700 });
      else if (!companions.has(entry.path)) {
        if (databases.has(entry.path)) await copyDatabase(join(sourceDirectory, entry.path), destination);
        else await digestSnapshotFile(join(sourceDirectory, entry.path), destination);
        await chmod(destination, entry.mode);
      }
    }
    for (const entry of [...source].reverse()) if (entry.directory) await chmod(join(directory, entry.path), entry.mode);
    await options.build?.(directory, sourceDirectory);
    await normalizeStoreDatabases(directory, maximum);
    const current = await readTree(sourceDirectory, maximum);
    // SQLite readers can update shared-memory bookkeeping without changing committed data.
    const stable = (tree: TreeEntry[]) => tree.filter(entry => !(entry.path.endsWith("-shm") && databases.has(entry.path.slice(0, -4)))
      && !(entry.empty && entry.path.endsWith("-wal") && databases.has(entry.path.slice(0, -4))));
    if (JSON.stringify(stable(source)) !== JSON.stringify(stable(current))) throw new Error("source generation changed during preparation");
    if (await readRecord(join(root, "active.json"), 16_384) !== selector) throw new Error("generation selector changed during preparation");
    const tree = await readTree(directory, maximum), files = await describeFiles(directory, tree);
    for (const entry of [...tree].reverse()) if (entry.directory) await syncDirectory(join(directory, entry.path));
    await syncDirectory(directory);
    const prepared = preparedSchema.parse({ ...record, state: "prepared", selectorChecksum, files, directories: tree.filter(entry => entry.directory).map(({ path, mode }) => ({ path, mode })) });
    await saveRecord(root, id, prepared);
    return Object.freeze(prepared);
  } catch (error) {
    if (recorded) await saveRecord(root, id, { ...record, state: "failed" }).catch(() => {});
    throw error;
  } finally { release(); }
}
export async function validatePreparedStoreGeneration(root: string, id: string): Promise<PreparedStoreGeneration> {
  identifier.parse(id);
  if (!isAbsolute(root)) throw new Error("invalid store generation root");
  await requireDirectory(root); await requireDirectory(join(root, "preparations")); await requireDirectory(join(root, "generations"));
  const prepared = preparedSchema.parse(JSON.parse(await readRecord(join(root, "preparations", `${id}.json`))));
  if (prepared.root !== root || prepared.id !== id || prepared.directory !== join(root, "generations", id)) throw new Error("store preparation belongs to another generation");
  const tree = await readTree(prepared.directory, 1_000_000), files = await describeFiles(prepared.directory, tree), directories = tree.filter(entry => entry.directory).map(({ path, mode }) => ({ path, mode }));
  if (JSON.stringify(files) !== JSON.stringify(prepared.files) || JSON.stringify(directories) !== JSON.stringify(prepared.directories)) throw new Error("prepared store generation changed");
  return Object.freeze(prepared);
}
