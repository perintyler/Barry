import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSqlMigrations } from "./sql-migrations.js";
import { sqliteProvider } from "./sqlite-provider.js";
import type {
  StoreRegistry,
  StoreDeclaration,
  StoreRestoreAdapter,
  StoreSnapshotAdapter,
} from "./registry.js";

interface StoreBag {
  name: string;
  source: { type: string; path?: string };
  manifest?: {
    stores?: Record<string, StoreDeclaration>;
    storeSnapshots?: Record<string, { entry: string }>;
    storeRestores?: Record<string, { entry: string }>;
  } | null;
}
const pendingLoads = new WeakMap<StoreRegistry, Promise<void>>();
const loadedAdapters = new WeakMap<StoreRegistry, Map<string, string>>();

async function storeAdapterEntry(
  bagRoot: string,
  entry: string,
  operation: "snapshot" | "restore",
): Promise<string> {
  if (
    !/\.(?:m?js)$/.test(entry) ||
    isAbsolute(entry) ||
    !entry.split("/").every((part) => part !== ".." && /^[a-z0-9._-]+$/i.test(part))
  )
    throw new Error(`${operation} entry must be a compiled JavaScript path inside the bag`);
  const root = await realpath(bagRoot),
    path = await realpath(resolve(root, entry)),
    within = relative(root, path);
  if (
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith("../") ||
    !(await stat(path)).isFile()
  )
    throw new Error(`${operation} entry must remain inside the bag root`);
  return path;
}

async function installDeclaredStores(
  registry: StoreRegistry,
  bags: readonly StoreBag[],
): Promise<void> {
  const registered = new Set(
    registry.declarationsFor().map((entry) => `${entry.bag}/${entry.store}`),
  );
  const adapters = loadedAdapters.get(registry) ?? new Map<string, string>();
  loadedAdapters.set(registry, adapters);
  for (const bag of bags) {
    if (bag.source.type !== "local" || !bag.source.path) continue;
    for (const [name, declaration] of Object.entries(bag.manifest?.stores ?? {})) {
      if (registered.has(`${bag.name}/${name}`)) continue;
      if (declaration.engine !== "sqlite")
        throw new Error(`unsupported store engine ${declaration.engine}`);
      registry.register(
        bag.name,
        name,
        declaration,
        sqliteProvider(loadSqlMigrations(bag.source.path, declaration.migrations)),
      );
      registered.add(`${bag.name}/${name}`);
    }
    for (const [name, snapshot] of Object.entries(bag.manifest?.storeSnapshots ?? {})) {
      if (!Object.hasOwn(bag.manifest?.stores ?? {}, name))
        throw new Error("snapshot adapter must name a declared store");
      const path = await storeAdapterEntry(bag.source.path, snapshot.entry, "snapshot"),
        key = `snapshot:${bag.name}/${name}`;
      if (adapters.has(key)) {
        if (adapters.get(key) !== path)
          throw new Error(`snapshot adapter changed for ${key}; restart the runtime`);
        continue;
      }
      if (registry.hasSnapshotAdapter(bag.name, name))
        throw new Error(`snapshot adapter already installed for ${key}`);
      const module = (await import(pathToFileURL(path).href)) as {
        captureSnapshot?: StoreSnapshotAdapter;
      };
      if (typeof module.captureSnapshot !== "function")
        throw new Error(`${key}: snapshot entry must export captureSnapshot`);
      registry.registerSnapshotAdapter(bag.name, name, module.captureSnapshot);
      adapters.set(key, path);
    }
    for (const [name, restore] of Object.entries(bag.manifest?.storeRestores ?? {})) {
      if (!Object.hasOwn(bag.manifest?.stores ?? {}, name))
        throw new Error("restore adapter must name a declared store");
      const path = await storeAdapterEntry(bag.source.path, restore.entry, "restore"),
        key = `restore:${bag.name}/${name}`;
      if (adapters.has(key)) {
        if (adapters.get(key) !== path)
          throw new Error(`restore adapter changed for ${key}; restart the runtime`);
        continue;
      }
      if (registry.hasRestoreAdapter(bag.name, name))
        throw new Error(`restore adapter already installed for ${key}`);
      const module = (await import(pathToFileURL(path).href)) as {
        prepareRestore?: StoreRestoreAdapter;
      };
      if (typeof module.prepareRestore !== "function")
        throw new Error(`${key}: restore entry must export prepareRestore`);
      registry.registerRestoreAdapter(bag.name, name, module.prepareRestore);
      adapters.set(key, path);
    }
  }
}

export async function loadDeclaredStores(
  registry: StoreRegistry,
  bags: readonly StoreBag[],
): Promise<void> {
  // Services can request the same bag inventory concurrently; install each hook once.
  const previous = pendingLoads.get(registry) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => installDeclaredStores(registry, bags));
  pendingLoads.set(registry, pending);
  await pending;
}
