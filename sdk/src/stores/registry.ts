import { SnapshotManifestSchema, type SnapshotResource } from "./snapshots.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { SqliteDatabase as DatabaseSync, withSqliteInspectionCopy } from "./sqlite-connection.js";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { barryStoresDir } from "../services/home.mjs";
import type { Migration } from "./migrate.js";
import {
  copySnapshot,
  digestSnapshotFile,
  snapshotRevision,
  validateSnapshotResources,
} from "./snapshot-resources.js";
export type { SnapshotResource } from "./snapshots.js";
export { copySnapshot } from "./snapshot-resources.js";
export type StoreScope = "identity" | "node";
export interface StoreRef {
  node: string;
  identity?: string;
  bag: string;
  store: string;
}
export interface StoreDeclaration {
  owned_by: StoreScope;
  engine: "sqlite";
  migrations: string;
}
export interface RegistryStoreHandle {
  schemaVersion(): number;
  revision(): string;
  snapshot(destination: string): Promise<void | SnapshotResource[]>;
  close(): void;
}
export interface StoreProvider {
  migrations: readonly Migration[];
  open(
    path: string,
    options: {
      readonly: boolean;
    },
  ): RegistryStoreHandle | Promise<RegistryStoreHandle>;
}
export interface SnapshotManifest extends StoreRef {
  format: 1;
  schemaVersion: number;
  revision: string;
  capturedAt: string;
  bytes: number;
  checksum: string;
  resources?: SnapshotResource[];
}
export { SnapshotManifestSchema } from "./snapshots.js";
export interface StoreSnapshot {
  manifest: SnapshotManifest;
  path: string;
}
export type StoreRestoreAdapter = (
  snapshot: StoreSnapshot,
  ref: StoreRef,
  destination: string,
) => Promise<void>;
export type StoreSnapshotAdapter = (
  ref: StoreRef,
  source: string,
  destination: string,
) => Promise<SnapshotResource[]>;
const segment = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes(".."))
    throw new Error(`unsafe store identifier: ${value}`);
  return value;
};
export function storePath(ref: StoreRef, scope: StoreScope, root = barryStoresDir()): string {
  if (scope === "identity" && !ref.identity) throw new Error("identity store requires an identity");
  if (scope === "node" && ref.identity) throw new Error("node store cannot carry an identity");
  return join(
    root,
    scope === "identity" ? "identities" : "node",
    ...(ref.identity ? [segment(ref.identity)] : []),
    segment(ref.bag),
    `${segment(ref.store)}.db`,
  );
}
export function storeKey(ref: StoreRef): string {
  return [ref.node, ref.identity ?? "node", ref.bag, ref.store].map(segment).join("/");
}
export async function validateSnapshot(snapshot: StoreSnapshot): Promise<void> {
  const manifest = SnapshotManifestSchema.parse(snapshot.manifest);
  const path = snapshot.path;
  storeKey(manifest);
  if (
    manifest.format !== 1 ||
    !Number.isInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 0 ||
    !Number.isFinite(Date.parse(manifest.capturedAt))
  )
    throw new Error("invalid snapshot metadata");
  const digest = await digestSnapshotFile(path);
  if (digest.bytes !== manifest.bytes || digest.checksum !== manifest.checksum)
    throw new Error("snapshot integrity mismatch");
  await validateSnapshotResources({ path, manifest });
}
/** Providers are installed locally. Snapshot metadata never supplies executable code. */
export class StoreRegistry {
  private snapshotAdapters = new Map<string, StoreSnapshotAdapter>();
  private restoreAdapters = new Map<string, StoreRestoreAdapter>();
  private declarations = new Map<
    string,
    {
      declaration: StoreDeclaration;
      provider: StoreProvider;
    }
  >();
  constructor(
    readonly nodeId: string,
    readonly root = barryStoresDir(),
  ) {
    segment(nodeId);
  }
  forRoot(root: string): StoreRegistry {
    if (!isAbsolute(root)) throw new Error("store registry root must be absolute");
    const registry = new StoreRegistry(this.nodeId, root);
    registry.declarations = new Map(this.declarations);
    registry.snapshotAdapters = new Map(this.snapshotAdapters);
    registry.restoreAdapters = new Map(this.restoreAdapters);
    return registry;
  }
  register(
    bag: string,
    name: string,
    declaration: StoreDeclaration,
    provider: StoreProvider,
  ): void {
    segment(bag);
    segment(name);
    if (bag === "vault") throw new Error("vaults are not ordinary stores");
    const key = `${bag}/${name}`;
    if (this.declarations.has(key)) throw new Error(`duplicate store ${key}`);
    this.declarations.set(key, { declaration, provider });
  }
  registerSnapshotAdapter(bag: string, name: string, adapter: StoreSnapshotAdapter): void {
    const key = `${segment(bag)}/${segment(name)}`;
    if (!this.declarations.has(key)) throw new Error(`unmanaged store ${key}`);
    if (this.snapshotAdapters.has(key)) throw new Error(`duplicate snapshot adapter ${key}`);
    this.snapshotAdapters.set(key, adapter);
  }
  hasSnapshotAdapter(bag: string, name: string): boolean {
    return this.snapshotAdapters.has(`${segment(bag)}/${segment(name)}`);
  }
  registerRestoreAdapter(bag: string, name: string, adapter: StoreRestoreAdapter): void {
    const key = `${segment(bag)}/${segment(name)}`;
    if (!this.declarations.has(key)) throw new Error(`unmanaged store ${key}`);
    if (this.restoreAdapters.has(key)) throw new Error(`duplicate restore adapter ${key}`);
    this.restoreAdapters.set(key, adapter);
  }
  hasRestoreAdapter(bag: string, name: string): boolean {
    return this.restoreAdapters.has(`${segment(bag)}/${segment(name)}`);
  }
  async prepareRestore(snapshot: StoreSnapshot, destination: string): Promise<void> {
    if (!isAbsolute(destination)) throw new Error("restore destination must be absolute");
    try {
      await lstat(destination);
      throw new Error("restore destination already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await validateSnapshot(snapshot);
    const ref: StoreRef = {
      node: this.nodeId,
      ...(snapshot.manifest.identity ? { identity: snapshot.manifest.identity } : {}),
      bag: snapshot.manifest.bag,
      store: snapshot.manifest.store,
    };
    const key = `${ref.bag}/${ref.store}`,
      registration = this.declarations.get(key);
    if (!registration) throw new Error(`unmanaged store ${key}`);
    storePath(ref, registration.declaration.owned_by, this.root);
    const adapter = this.restoreAdapters.get(key);
    if (!adapter && snapshot.manifest.resources?.length)
      throw new Error(`resource restore requires a local restore adapter for ${key}`);
    await this.validateRestoreDatabase(ref, snapshot.path);
    await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
    if (adapter) await adapter(snapshot, ref, destination);
    else await copySnapshot(snapshot, destination);
    const destinationFile = await lstat(destination);
    if (
      !destinationFile.isFile() ||
      destinationFile.isSymbolicLink() ||
      destinationFile.nlink !== 1
    )
      throw new Error("restore catalog must be an independent regular file");
    const catalog = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const file = await catalog.stat();
      if (!file.isFile() || file.nlink !== 1)
        throw new Error("restore catalog must be an independent regular file");
      await catalog.chmod(0o600);
    } finally {
      await catalog.close();
    }
    await this.validateRestoreDatabase(ref, destination);
  }
  private async validateRestoreDatabase(ref: StoreRef, path: string): Promise<void> {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error("restore catalog must be a regular file");
    await this.validateDatabase(ref, path);
    await withSqliteInspectionCopy(path, async (copy) => {
      const database = new DatabaseSync(copy, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout=1000");
        if (
          database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
          database.prepare("PRAGMA foreign_key_check").get()
        )
          throw new Error("invalid restore database integrity or foreign keys");
      } finally {
        database.close();
      }
    });
  }
  declarationsFor(scope?: StoreScope): {
    bag: string;
    store: string;
    declaration: StoreDeclaration;
  }[] {
    return [...this.declarations]
      .filter(([, v]) => !scope || v.declaration.owned_by === scope)
      .map(([key, v]) => {
        const [bag, store] = key.split("/");
        return { bag, store, declaration: v.declaration };
      });
  }
  async open(ref: StoreRef, readonly = false): Promise<RegistryStoreHandle> {
    if (ref.node !== this.nodeId) throw new Error("store belongs to another node");
    const registration = this.declarations.get(`${ref.bag}/${ref.store}`);
    if (!registration) throw new Error(`unmanaged store ${ref.bag}/${ref.store}`);
    const path = storePath(ref, registration.declaration.owned_by, this.root);
    if (!readonly) await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    return registration.provider.open(path, { readonly });
  }
  async validateDatabase(ref: StoreRef, path: string): Promise<void> {
    const registration = this.declarations.get(`${ref.bag}/${ref.store}`);
    if (!registration) throw new Error(`unmanaged store ${ref.bag}/${ref.store}`);
    await withSqliteInspectionCopy(path, async (copy) => {
      const handle = await registration.provider.open(copy, { readonly: true });
      try {
        if (handle.schemaVersion() > registration.provider.migrations.length)
          throw new Error("unsupported backup schema");
      } finally {
        handle.close();
      }
    });
  }
  async snapshot(ref: StoreRef, directory: string): Promise<StoreSnapshot> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.db`);
    const handle = await this.open(ref, true);
    try {
      const schemaVersion = handle.schemaVersion();
      const adapter = this.snapshotAdapters.get(`${ref.bag}/${ref.store}`);
      const registration = this.declarations.get(`${ref.bag}/${ref.store}`)!;
      const resources = adapter
        ? await adapter(ref, storePath(ref, registration.declaration.owned_by, this.root), path)
        : await handle.snapshot(path);
      // Hash the actual consistent snapshot, not a revision read before concurrent writes.
      const digest = await digestSnapshotFile(path);
      const checksum = digest.checksum;
      const manifest: SnapshotManifest = {
        ...ref,
        format: 1,
        schemaVersion,
        revision: snapshotRevision(checksum, resources || undefined),
        ...(resources ? { resources } : {}),
        capturedAt: new Date().toISOString(),
        bytes: digest.bytes,
        checksum,
      };
      await validateSnapshot({ path, manifest });
      await writeFile(`${path}.json`, JSON.stringify(manifest), { mode: 0o600 });
      return { path, manifest };
    } catch (error) {
      await rm(path, { force: true });
      await rm(`${path}.resources`, { recursive: true, force: true });
      await rm(`${path}.json`, { force: true });
      throw error;
    } finally {
      handle.close();
    }
  }
}
/** Install into a new generation; callers switch their index only after validation. */
export async function installSnapshot(
  snapshot: StoreSnapshot,
  directory: string,
): Promise<StoreSnapshot> {
  await validateSnapshot(snapshot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.db`);
  try {
    await copySnapshot(snapshot, path);
    return { path, manifest: snapshot.manifest };
  } catch (error) {
    await rm(path, { force: true });
    await rm(`${path}.resources`, { recursive: true, force: true });
    throw error;
  }
}
