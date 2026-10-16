import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "./sqlite-connection.js";
import { activeStoreRoot } from "./migration.js";
import { readLocalIdentities } from "../nodes/registry.js";
import type { StoreScope } from "./registry.js";

export type { StoreScope };

export interface StoreInfo {
  bag: string;
  store: string;
  scope: StoreScope;
  identityName?: string;
  identityId?: number;
  partitionKey?: string;
  path: string;
  bytes: number;
  walBytes: number;
  version: number;
  tables: number;
}

export interface StoreVerificationResult {
  store: StoreInfo;
  ok: boolean;
  integrity: string;
  error?: string;
}

/**
 * Resolve an identity partition directory name (UUID or legacy numeric) to identity name and id.
 * A folder peers.db does not map (a restored or foreign partition) is listed without a name.
 */
function resolveIdentity(
  dirName: string,
  localIdentities: Map<string, number>,
  identities: Map<number, string>,
): { name?: string; id?: number } {
  const idFromUuid = localIdentities.get(dirName);
  if (idFromUuid !== undefined && identities.has(idFromUuid)) {
    return { id: idFromUuid, name: identities.get(idFromUuid) };
  }
  // If it's numeric directly
  const num = Number(dirName);
  if (Number.isSafeInteger(num) && identities.has(num)) {
    return { id: num, name: identities.get(num) };
  }
  return {};
}

/**
 * List all SQLite stores in the active generation / stores root.
 */
export async function listStores(filter?: {
  identity?: string;
  bag?: string;
  scope?: StoreScope;
}): Promise<StoreInfo[]> {
  const root = activeStoreRoot();
  if (!existsSync(root)) return [];

  // Read-only: listing stores must not create peers.db or a new installation id.
  const localIdentities = readLocalIdentities(root);
  const identityNameMap = new Map<number, string>();
  try {
    const identitiesDbPath = join(root, "node", "identities", "identities.db");
    if (existsSync(identitiesDbPath)) {
      const db = new DatabaseSync(identitiesDbPath, { open: true, readOnly: true });
      try {
        const rows = db.prepare("SELECT id, name FROM identities").all() as Array<{ id: number; name: string }>;
        for (const row of rows) {
          identityNameMap.set(row.id, row.name);
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // If identities database is unavailable, identity names will simply be omitted
  }

  const stores: StoreInfo[] = [];

  // 1. Scan node stores
  const nodeDir = join(root, "node");
  if (existsSync(nodeDir)) {
    for (const bagEntry of readdirSync(nodeDir, { withFileTypes: true })) {
      if (!bagEntry.isDirectory()) continue;
      const bagName = bagEntry.name;
      const bagPath = join(nodeDir, bagName);
      for (const fileEntry of readdirSync(bagPath, { withFileTypes: true })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".db")) continue;
        const storeName = fileEntry.name.replace(/\.db$/, "");
        const fullPath = join(bagPath, fileEntry.name);
        stores.push(inspectStoreFile({
          bag: bagName,
          store: storeName,
          scope: "node",
          path: fullPath,
        }));
      }
    }
  }

  // 2. Scan identity stores
  const identitiesDir = join(root, "identities");
  if (existsSync(identitiesDir)) {
    for (const idEntry of readdirSync(identitiesDir, { withFileTypes: true })) {
      if (!idEntry.isDirectory()) continue;
      const partitionKey = idEntry.name;
      const { name: idName, id: idNum } = resolveIdentity(partitionKey, localIdentities, identityNameMap);

      const idPath = join(identitiesDir, partitionKey);
      for (const bagEntry of readdirSync(idPath, { withFileTypes: true })) {
        if (!bagEntry.isDirectory()) continue;
        const bagName = bagEntry.name;
        const bagPath = join(idPath, bagName);
        for (const fileEntry of readdirSync(bagPath, { withFileTypes: true })) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".db")) continue;
          const storeName = fileEntry.name.replace(/\.db$/, "");
          const fullPath = join(bagPath, fileEntry.name);
          stores.push(inspectStoreFile({
            bag: bagName,
            store: storeName,
            scope: "identity",
            identityName: idName,
            identityId: idNum,
            partitionKey,
            path: fullPath,
          }));
        }
      }
    }
  }

  // Apply filters
  return stores.filter((s) => {
    if (filter?.scope && s.scope !== filter.scope) return false;
    if (filter?.bag && s.bag !== filter.bag) return false;
    if (filter?.identity) {
      if (s.scope === "node") return true; // Node stores can be included or handled by caller
      if (s.identityName && s.identityName !== filter.identity) return false;
    }
    return true;
  });
}

function inspectStoreFile(base: {
  bag: string;
  store: string;
  scope: StoreScope;
  identityName?: string;
  identityId?: number;
  partitionKey?: string;
  path: string;
}): StoreInfo {
  let bytes = 0;
  let walBytes = 0;
  try {
    bytes = statSync(base.path).size;
  } catch {
    // Unreadable: reported as empty.
  }

  const walPath = `${base.path}-wal`;
  if (existsSync(walPath)) {
    try {
      walBytes = statSync(walPath).size;
    } catch {
      // Checkpointed away between the check and the stat.
    }
  }

  let version = 0;
  let tables = 0;

  try {
    const db = new DatabaseSync(base.path, { readOnly: true });
    try {
      const v = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      version = v?.user_version ?? 0;
      const count = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table'").get() as { count?: number } | undefined;
      tables = count?.count ?? 0;
    } finally {
      db.close();
    }
  } catch {
    // If opening fails, keep 0s
  }

  return {
    ...base,
    bytes,
    walBytes,
    version,
    tables,
  };
}

/**
 * Verify SQLite integrity and WAL state of a store file.
 */
export function verifyStore(store: StoreInfo, options: { deep?: boolean } = {}): StoreVerificationResult {
  try {
    if (!existsSync(store.path)) {
      return { store, ok: false, integrity: "missing", error: "database file does not exist" };
    }

    const db = new DatabaseSync(store.path, { readOnly: true });
    try {
      const pragma = options.deep ? "PRAGMA integrity_check" : "PRAGMA integrity_check(100)";
      const row = db.prepare(pragma).get() as { integrity_check?: string } | undefined;
      const result = row?.integrity_check ?? "unknown";
      const ok = result === "ok";

      let error: string | undefined;
      if (!ok) {
        error = `integrity check failed: ${result}`;
      } else if (store.walBytes > 50 * 1024 * 1024) {
        error = `large WAL file (${Math.round(store.walBytes / (1024 * 1024))}MB); checkpoint recommended`;
      }

      return {
        store,
        ok: ok && !error,
        integrity: result,
        error,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      store,
      ok: false,
      integrity: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
