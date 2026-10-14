import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { BackupManifestSchema } from "./backups.js";
import { prepareStoreGeneration, type PreparedStoreGeneration } from "./generation-preparation.js";
import { storeKey, storePath, validateSnapshot, type StoreRef, type StoreRegistry, type StoreSnapshot } from "./registry.js";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function readBackup(directory: string) {
  if (!isAbsolute(directory)) throw new Error("backup directory must be absolute");
  const folder = await lstat(directory);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("invalid backup directory");
  const handle = await open(join(directory, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size > 64 * 1024 * 1024) throw new Error("invalid backup manifest file");
    return BackupManifestSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
}
async function overlayStore(registry: StoreRegistry, snapshot: StoreSnapshot, destination: string): Promise<void> {
  const parent = dirname(destination), catalog = basename(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("invalid private restore parent");
  const parentMode = parentInfo.mode & 0o777;
  await chmod(parent, parentMode | 0o700);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(parent, ".restore-"));
    await registry.prepareRestore(snapshot, join(staging, catalog));
    const entries = await readdir(staging);
    for (const name of entries) {
      if (name !== catalog && !name.startsWith(`${catalog}.`) && name !== `${catalog}-wal` && name !== `${catalog}-shm`) throw new Error("restore adapter wrote outside its store bundle");
      const entry = await lstat(join(staging, name));
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("invalid restore bundle entry");
    }
    // These are private copied files; old-generation catalogs and companions stay intact.
    for (const name of new Set([...entries, `${catalog}-wal`, `${catalog}-shm`])) await rm(join(parent, name), { recursive: true, force: true });
    for (const name of entries) await rename(join(staging, name), join(parent, name));
  } finally {
    try { if (staging) await rm(staging, { recursive: true, force: true }); }
    finally { await chmod(parent, parentMode); }
  }
}
/** Every snapshot of a backup, verified against its manifest and the registry's declarations; reads only, so services may run. */
export async function validateBackup(directory: string, options: { root: string; registry: StoreRegistry; sourceNode?: string }): Promise<StoreSnapshot[]> {
  const backup = await readBackup(directory), sourceNode = options.sourceNode ?? options.registry.nodeId;
  const declarations = new Map(options.registry.declarationsFor().map(entry => [`${entry.bag}/${entry.store}`, entry]));
  const snapshots: StoreSnapshot[] = [], files = new Set<string>(), restored = new Set<string>();
  for (const entry of backup.stores) {
    const manifest = entry.manifest, key = storeKey({ ...manifest, node: options.registry.nodeId });
    if (manifest.node !== sourceNode) throw new Error("backup mixes source nodes; select the source node explicitly");
    const declaration = declarations.get(`${manifest.bag}/${manifest.store}`);
    if (!declaration || manifest.bag === "vault") throw new Error("backup contains an unmanaged store");
    storePath(manifest, declaration.declaration.owned_by, options.root);
    if (files.has(entry.file) || restored.has(key)) throw new Error("duplicate backup store or file");
    files.add(entry.file); restored.add(key);
    if (manifest.resources?.length && !options.registry.hasRestoreAdapter(manifest.bag, manifest.store)) throw new Error("resource restore requires a local restore adapter");
    const snapshot = { path: join(directory, entry.file), manifest };
    await validateSnapshot(snapshot); await options.registry.validateDatabase(manifest, snapshot.path);
    snapshots.push(snapshot);
  }
  return snapshots;
}
export async function prepareBackupGeneration(directory: string, options: {
  root: string; previousId: string; servicesStopped: boolean; registry: StoreRegistry; sourceNode?: string; maximumEntries?: number;
  /** Runs inside the candidate after every store is overlaid, before it is sealed into the receipt. */
  finish?(candidate: string, restored: readonly StoreSnapshot[]): Promise<void>;
}): Promise<PreparedStoreGeneration> {
  if (!options.servicesStopped) throw new Error("stop and drain affected services before restoring a backup");
  const snapshots = await validateBackup(directory, options);
  const declarations = new Map(options.registry.declarationsFor().map(entry => [`${entry.bag}/${entry.store}`, entry]));
  const restored = new Set(snapshots.map(snapshot => storeKey({ ...snapshot.manifest, node: options.registry.nodeId })));
  return prepareStoreGeneration({ root: options.root, previousId: options.previousId, servicesStopped: true, maximumEntries: options.maximumEntries,
    async build(candidate) {
      const registry = options.registry.forRoot(candidate);
      for (const snapshot of snapshots) {
        const declaration = declarations.get(`${snapshot.manifest.bag}/${snapshot.manifest.store}`)!;
        await overlayStore(registry, snapshot, storePath(snapshot.manifest, declaration.declaration.owned_by, candidate));
      }
      const identities = await exists(join(candidate, "identities")) ? await readdir(join(candidate, "identities"), { withFileTypes: true }) : [];
      for (const { bag, store, declaration } of declarations.values()) {
        if (!registry.hasRestoreAdapter(bag, store)) continue;
        const refs: StoreRef[] = declaration.owned_by === "node" ? [{ node: registry.nodeId, bag, store }]
          : identities.filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/i.test(entry.name) && !entry.name.includes("..")).map(entry => ({ node: registry.nodeId, identity: entry.name, bag, store }));
        for (const ref of refs) {
          const path = storePath(ref, declaration.owned_by, candidate);
          if (restored.has(storeKey(ref)) || !await exists(path)) continue;
          const capture = await mkdtemp(join(candidate, ".capture-"));
          try { await overlayStore(registry, await registry.snapshot(ref, capture), path); }
          finally { await rm(capture, { recursive: true, force: true }); }
        }
      }
      await options.finish?.(candidate, snapshots);
    },
  });
}
