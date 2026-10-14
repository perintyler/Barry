import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "@barry-rocks/sdk/internal/stores";
import { discoverBuiltinBags } from "@barry-rocks/sdk/internal/bags";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { readInstallationId } from "@barry-rocks/sdk/internal/nodes";
import { loadDeclaredStores, loadSqlMigrations, StoreRegistry } from "@barry-rocks/sdk/internal/stores";
import { coreProvider } from "../services/configuration/index.js";
import { readRelease } from "./release.js";

function builtinStores(bagsDir: string) {
  return Object.entries(discoverBuiltinBags(bagsDir).local).map(([name, relative]) => {
    const path = join(bagsDir, relative);
    return { name, source: { type: "local", path }, manifest: parseManifest(path) };
  });
}
export function storeSchemas(root: string): Record<string, number> {
  const release = readRelease(root);
  if (release) return release.stores;
  const schemas: Record<string, number> = { "core/config": loadSqlMigrations(join(root, "cli/src/services/configuration"), "migrations").length };
  for (const bag of builtinStores(join(root, "bags"))) {
    for (const [store, declaration] of Object.entries(bag.manifest?.stores ?? {}))
      schemas[`${bag.name}/${store}`] = loadSqlMigrations(bag.source.path, declaration.migrations).length;
  }
  return schemas;
}
function storeFiles(directory: string): { path: string; bag: string; store: string; identity?: string }[] {
  const files: { path: string; bag: string; store: string; identity?: string }[] = [];
  const directories = (path: string) => existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  const partitions = [{ path: join(directory, "node"), identity: undefined },
    ...directories(join(directory, "identities")).map(identity => ({ path: join(directory, "identities", identity), identity }))];
  for (const partition of partitions) for (const bag of directories(partition.path)) {
    for (const entry of readdirSync(join(partition.path, bag), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".db")) files.push({ path: join(partition.path, bag, entry.name), bag, store: entry.name.slice(0, -3), identity: partition.identity });
    }
  }
  return files;
}
function storeVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const pragma = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    const hasMigrations = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    return Math.max(pragma, hasMigrations ? Number(database.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version ?? 0) : 0);
  } finally { database.close(); }
}
export function storeVersions(directory: string): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const file of storeFiles(directory)) {
    const key = `${file.bag}/${file.store}`;
    versions[key] = Math.max(versions[key] ?? 0, storeVersion(file.path));
  }
  return versions;
}
export function migrateCandidate(bagsDir: string): (directory: string, source: string) => Promise<void> {
  return async directory => {
    const node = readInstallationId(directory);
    if (!node) throw new Error("cannot migrate stores without an installation id");
    const registry = new StoreRegistry(node, directory);
    registry.register("core", "config", { owned_by: "node", engine: "sqlite", migrations: "core" }, coreProvider);
    await loadDeclaredStores(registry, builtinStores(bagsDir));
    const counts = storeSchemas(dirname(bagsDir));
    const declared = new Set(registry.declarationsFor().map(entry => `${entry.bag}/${entry.store}`));
    for (const file of storeFiles(directory)) {
      const key = `${file.bag}/${file.store}`;
      if (!declared.has(key)) continue;
      const handle = await registry.open({ node, bag: file.bag, store: file.store, ...(file.identity ? { identity: file.identity } : {}) });
      try { if (handle.schemaVersion() !== counts[key]) throw new Error(`${key} did not reach schema ${counts[key]}`); }
      finally { handle.close(); }
    }
  };
}
