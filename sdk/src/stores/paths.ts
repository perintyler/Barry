import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "./sqlite-connection.js";
import { barryStoresDir } from "../services/home.mjs";
import { activeStoreRoot } from "./migration.js";
import { currentStoreContext } from "./context.js";
import { storePath } from "./registry.js";
export function migratedStorePath(
  bag: string,
  store: string,
  legacy: () => string,
  nodeStore = store,
  scope: "identity" | "node" = "identity",
): string {
  if (!existsSync(join(barryStoresDir(), "active.json"))) return legacy();
  const identity = scope === "identity" ? currentStoreContext()?.identity : undefined;
  return storePath(
    { node: "local", identity, bag, store: identity ? store : nodeStore },
    identity ? "identity" : "node",
    activeStoreRoot(),
  );
}
export function identityStorePaths(
  bag: string,
  store: string,
): {
  identity: string;
  path: string;
}[] {
  if (!existsSync(join(barryStoresDir(), "active.json"))) return [];
  const root = join(activeStoreRoot(), "identities");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      identity: entry.name,
      path: storePath(
        { node: "local", identity: entry.name, bag, store },
        "identity",
        activeStoreRoot(),
      ),
    }))
    .filter((entry) => existsSync(entry.path));
}
export class AmbiguousSessionLocation extends Error {
  constructor() {
    super("Ambiguous Session location");
    this.name = "AmbiguousSessionLocation";
  }
}

const sessionLocations = new Map<string, { identity: string | undefined; expires: number }>();
export function forgetSessionIdentity(sessionId?: string): void { if (sessionId === undefined) sessionLocations.clear(); else sessionLocations.delete(sessionId); }
export function sessionIdentity(sessionId: string): string | undefined {
  const cached = sessionLocations.get(sessionId);
  if (cached && cached.expires > Date.now()) {
    sessionLocations.delete(sessionId); sessionLocations.set(sessionId, cached);
    return cached.identity;
  }
  const result = resolveSessionIdentity(sessionId);
  if (sessionLocations.size >= 10_000) sessionLocations.delete(sessionLocations.keys().next().value!);
  sessionLocations.set(sessionId, { identity: result, expires: result === undefined ? Date.now() + 2000 : Infinity });
  return result;
}
function resolveSessionIdentity(sessionId: string): string | undefined {
  if (!existsSync(join(barryStoresDir(), "active.json"))) return undefined;
  const deadline = performance.now() + 5000;
  const root = activeStoreRoot();
  const catalog = storePath({ node: "local", bag: "sessions", store: "catalog" }, "node", root);
  const stores: { identity?: string; path: string }[] = identityStorePaths("sessions", "sessions");
  if (existsSync(catalog)) stores.push({ path: catalog });
  let matched = false;
  let identity: string | undefined;
  for (const store of stores) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Session location resolution deadline exceeded");
    const db = new DatabaseSync(store.path, { readOnly: true });
    try {
      db.exec(
        `PRAGMA query_only=ON; PRAGMA busy_timeout=${Math.max(1, Math.min(1000, Math.floor(remaining)))}`,
      );
      const row = db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId);
      if (performance.now() >= deadline)
        throw new Error("Session location resolution deadline exceeded");
      if (row) {
        // Checking every file prevents a duplicate in another partition
        // from silently changing which actor's resource is selected.
        if (matched) throw new AmbiguousSessionLocation();
        matched = true;
        identity = store.identity;
      }
    } finally {
      db.close();
    }
  }
  return identity;
}
