// Open owning stores read-only so dashboards cannot become an alternate writer.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-187

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { bagDataDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { identityStorePaths, storePath } from "@barry-rocks/sdk/stores";

export interface StorePartition {
  path: string;
  db: Database.Database;
  identity?: string;
}

/** One store: open handles (including partitions), or the reason there is none. */
export interface StoreHandle {
  name: string;
  path: string;
  db: Database.Database | null;
  partitions?: StorePartition[];
  /** Set iff db is null — why the panels backed by this store are unavailable. */
  problem?: string;
}

export interface Stores {
  sessions: StoreHandle;
  identities: StoreHandle;
  actions: StoreHandle;
  events: StoreHandle;
}

// sessions/src/store/sessions-db.ts and identities/src/store/identities-db.ts:
// active store generation when available, falling back to legacy bag data dir.
export function sessionsDbPath(): string {
  if (process.env.BARRY_SESSIONS_DB) return process.env.BARRY_SESSIONS_DB;
  if (existsSync(join(barryStoresDir(), "active.json"))) {
    return storePath({ node: "local", bag: "sessions", store: "catalog" }, "node", activeStoreRoot());
  }
  return join(bagDataDir("sessions"), "sessions.db");
}

export function identitiesDbPath(): string {
  if (process.env.BARRY_IDENTITIES_DB) return process.env.BARRY_IDENTITIES_DB;
  if (existsSync(join(barryStoresDir(), "active.json"))) {
    return join(activeStoreRoot(), "node", "identities", "identities.db");
  }
  return join(bagDataDir("identities"), "identities.db");
}

// actions/db.ts and events/db.ts:
// active store generation when available, falling back to legacy bag data dir.
export function actionsDbPath(): string {
  if (process.env.BARRY_ACTIONS_DB) return process.env.BARRY_ACTIONS_DB;
  if (existsSync(join(barryStoresDir(), "active.json"))) {
    return storePath({ node: "local", bag: "actions", store: "infrastructure" }, "node", activeStoreRoot());
  }
  return join(bagDataDir("actions"), "actions.db");
}

export function eventsDbPath(): string {
  if (process.env.BARRY_EVENTS_DB) return process.env.BARRY_EVENTS_DB;
  if (existsSync(join(barryStoresDir(), "active.json"))) {
    return storePath({ node: "local", bag: "events", store: "unscoped" }, "node", activeStoreRoot());
  }
  return join(bagDataDir("events"), "events.db");
}

/**
 * The user's home directory, from the OS rather than `process.env.HOME` with a
 * hard-coded personal fallback. An empty result means a genuinely broken
 * environment, so we fail loudly rather than silently stripping nothing (or a
 * stranger's `/Users/<name>`).
 */
export function userHome(): string {
  const home = os.homedir().replace(/\/+$/, "");
  if (!home) throw new Error("telemetry usage: os.homedir() is empty; cannot group worktrees by repo");
  return home;
}

// Normalize worktree paths to their parent repository before grouping usage.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-188
export function repoOf(wd: unknown): string | null {
  if (typeof wd !== "string" || wd === "") return null;
  const home = userHome();
  const stripped = wd.startsWith(`${home}/`) ? wd.slice(home.length + 1) : wd;
  // First two path segments: the slash after segment two, or the whole thing.
  const second = stripped.indexOf("/", stripped.indexOf("/") + 1);
  return second === -1 ? stripped : stripped.slice(0, second);
}

// Resolve the serving bag from the MCP tool name before attributing usage.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-189
function bagOf(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const first = name.indexOf("__");
  if (first === -1) return null;
  const rest = name.slice(first + 2);
  const second = rest.indexOf("__");
  return second === -1 ? rest : rest.slice(0, second);
}

function openStore(
  bag: string,
  store: string,
  nodeStore: string,
  envVar: string | undefined,
  legacyPathFn: () => string,
): StoreHandle {
  if (envVar) {
    if (!existsSync(envVar)) {
      return { name: bag, path: envVar, db: null, partitions: [], problem: `${bag} store not found at ${envVar}` };
    }
    try {
      const db = new Database(envVar, { readonly: true, fileMustExist: true });
      db.function("repo_of", repoOf);
      db.function("bag_of", bagOf);
      return { name: bag, path: envVar, db, partitions: [{ path: envVar, db }] };
    } catch (err) {
      return { name: bag, path: envVar, db: null, partitions: [], problem: `${bag} store at ${envVar} could not be opened: ${String(err)}` };
    }
  }

  const hasActiveGeneration = existsSync(join(barryStoresDir(), "active.json"));
  if (!hasActiveGeneration) {
    const path = legacyPathFn();
    if (!existsSync(path)) {
      return { name: bag, path, db: null, partitions: [], problem: `${bag} store not found at ${path}` };
    }
    try {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      db.function("repo_of", repoOf);
      db.function("bag_of", bagOf);
      return { name: bag, path, db, partitions: [{ path, db }] };
    } catch (err) {
      return { name: bag, path, db: null, partitions: [], problem: `${bag} store at ${path} could not be opened: ${String(err)}` };
    }
  }

  const root = activeStoreRoot();
  const nodePath = bag === "identities"
    ? join(root, "node", "identities", "identities.db")
    : storePath({ node: "local", bag, store: nodeStore }, "node", root);
  const idEntries = bag === "identities" ? [] : identityStorePaths(bag, store);

  const candidatePaths: { path: string; identity?: string }[] = [];
  if (existsSync(nodePath)) {
    candidatePaths.push({ path: nodePath });
  }
  for (const entry of idEntries) {
    candidatePaths.push({ path: entry.path, identity: entry.identity });
  }

  if (candidatePaths.length === 0) {
    return { name: bag, path: nodePath, db: null, partitions: [], problem: `${bag} store not found at ${nodePath}` };
  }

  const partitions: StorePartition[] = [];
  try {
    for (const c of candidatePaths) {
      const db = new Database(c.path, { readonly: true, fileMustExist: true });
      db.function("repo_of", repoOf);
      db.function("bag_of", bagOf);
      partitions.push({ path: c.path, db, identity: c.identity });
    }
    return {
      name: bag,
      path: partitions[0].path,
      db: partitions[0].db,
      partitions,
    };
  } catch (err) {
    for (const p of partitions) {
      try { p.db.close(); } catch { /* ignore */ }
    }
    return { name: bag, path: nodePath, db: null, partitions: [], problem: `${bag} store at ${nodePath} could not be opened: ${String(err)}` };
  }
}

export function openStores(): Stores {
  return {
    sessions: openStore("sessions", "sessions", "catalog", process.env.BARRY_SESSIONS_DB, () => join(bagDataDir("sessions"), "sessions.db")),
    identities: openStore("identities", "identities", "identities", process.env.BARRY_IDENTITIES_DB, () => join(bagDataDir("identities"), "identities.db")),
    actions: openStore("actions", "actions", "infrastructure", process.env.BARRY_ACTIONS_DB, () => join(bagDataDir("actions"), "actions.db")),
    events: openStore("events", "events", "unscoped", process.env.BARRY_EVENTS_DB, () => join(bagDataDir("events"), "events.db")),
  };
}

export function closeStores(stores: Stores): void {
  for (const handle of Object.values(stores)) {
    if (handle.partitions?.length) {
      for (const p of handle.partitions) {
        try { p.db.close(); } catch { /* ignore */ }
      }
    } else if (handle.db) {
      try { handle.db.close(); } catch { /* ignore */ }
    }
  }
}

/** The covering index the tool aggregations lean on, in sessions.db. */
export const TOOL_INDEX = "idx_messages_tool_calls";

// Check the covering index explicitly so slow fallback queries remain visible.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-190
export function toolIndexPresent(sessions: StoreHandle): boolean {
  const partitions = sessions.partitions?.length ? sessions.partitions : (sessions.db ? [{ path: sessions.path, db: sessions.db }] : []);
  if (partitions.length === 0) return false;
  for (const p of partitions) {
    try {
      const hasMessages = p.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'`).get();
      if (!hasMessages) continue;
      const row = p.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(TOOL_INDEX);
      if (row === undefined) return false;
    } catch {
      // Advisory: a failure here must not take down the page — the panels
      // report their own errors.
      return true;
    }
  }
  return true;
}

/** The warning `usageOverview.sourceWarning` carries when the index is gone. */
export function toolIndexMissingWarning(): string {
  return `Index ${TOOL_INDEX} is missing; tool aggregations will sequential-scan.`;
}
