import generatedMigrations from "./generated/locks-migrations.js";
import { migrateStore, migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";


import { join } from "node:path";
import Database from "better-sqlite3";
import { bagDataDir } from "@barry-rocks/sdk/services";

export type LockDb = Database.Database;

/** Minutes a lock stays valid without being refreshed. */
export const DEFAULT_TTL_MINUTES = 30;

/**
 * Adopt an old, unversioned lock store once, before its history is recorded;
 * a versioned store goes straight through history verification.
 */
function adoptUnversioned(db: LockDb): void {
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return;
  db.exec(STORE_DDL);
  // Old intents omitted region. NULL means the whole file.
  addColumnIfMissing(db, "intents", "region", "TEXT");
}

/** The generated SQL catalog works in bundled code. */
export function initSchema(db: LockDb): void {
  adoptUnversioned(db);
  migrateStore(db, MIGRATIONS, "locks");
}

/** `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite; this makes it so. */
function addColumnIfMissing(db: LockDb, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// Parallel sessions genuinely contend on this file; the store waits rather than throws.
const store = openBagStore({
  file: "locks",
  migrations: generatedMigrations,
  adopt: adoptUnversioned,
  connect: (path) => new Database(path),
  path: () => process.env.BARRY_LOCKS_DB ?? migratedStorePath("locks", "locks", () => join(bagDataDir("locks"), "locks.db"), "locks", "node"),
});

export const getDb = (): LockDb => store.db();
export const closeDb = (): void => store.close();

export interface LockRow {
  id: number;
  repo_root: string;
  rel_path: string;
  session_id: string;
  intent: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface IntentRow {
  id: number;
  repo_root: string;
  rel_path: string;
  session_id: string;
  intent: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  repo_root: string;
  rel_path: string;
  session_id: string;
  action: string;
  detail: string | null;
  created_at: string;
}

export function recordEvent(
  db: LockDb,
  event: { repoRoot: string; relPath: string; sessionId: string; action: string; detail?: string },
): void {
  db.prepare(
    `INSERT INTO events (repo_root, rel_path, session_id, action, detail) VALUES (?, ?, ?, ?, ?)`,
  ).run(event.repoRoot, event.relPath, event.sessionId, event.action, event.detail ?? null);
}

/**
 * Drop locks that are past their TTL, or whose owning session is known dead.
 *
 * `deadSessionIds` comes from a liveness probe that fails OPEN — when it can't
 * reach the API it returns an empty set, so reaping degrades to TTL-only rather
 * than either wedging the repo or freeing live locks.
 */
export function reapStaleLocks(db: LockDb, deadSessionIds: Set<string> = new Set()): number {
  const expired = db.prepare(`SELECT * FROM locks WHERE expires_at <= datetime('now')`).all() as LockRow[];

  const dead = deadSessionIds.size
    ? (db
        .prepare(
          `SELECT * FROM locks WHERE expires_at > datetime('now') AND session_id IN (${[...deadSessionIds]
            .map(() => "?")
            .join(",")})`,
        )
        .all(...deadSessionIds) as LockRow[])
    : [];

  // Tag reason at collection time — the two queries return distinct row
  // objects, so identity checks across them would always be false.
  const stale = [
    ...expired.map((row) => ({ row, reason: "ttl elapsed" })),
    ...dead.map((row) => ({ row, reason: "owning session no longer active" })),
  ];
  if (stale.length === 0) return 0;

  const drop = db.prepare(`DELETE FROM locks WHERE id = ?`);
  const releaseIntent = db.prepare(
    `UPDATE intents SET state = 'released', updated_at = datetime('now')
     WHERE repo_root = ? AND rel_path = ? AND session_id = ? AND state = 'held'`,
  );

  for (const { row, reason } of stale) {
    drop.run(row.id);
    releaseIntent.run(row.repo_root, row.rel_path, row.session_id);
    recordEvent(db, {
      repoRoot: row.repo_root,
      relPath: row.rel_path,
      sessionId: row.session_id,
      action: "expire",
      detail: reason,
    });
  }

  return stale.length;
}

export function getLock(db: LockDb, repoRoot: string, relPath: string): LockRow | undefined {
  return db
    .prepare(`SELECT * FROM locks WHERE repo_root = ? AND rel_path = ? AND expires_at > datetime('now')`)
    .get(repoRoot, relPath) as LockRow | undefined;
}

/** Waiting intents for a path, oldest first — the queue order. */
export function getWaiters(db: LockDb, repoRoot: string, relPath: string): IntentRow[] {
  return db
    .prepare(
      `SELECT * FROM intents WHERE repo_root = ? AND rel_path = ? AND state = 'waiting' ORDER BY created_at ASC, id ASC`,
    )
    .all(repoRoot, relPath) as IntentRow[];
}

export interface ContendedPath {
  repoRoot: string;
  relPath: string;
  holder: LockRow | undefined;
  waiters: IntentRow[];
}

/**
 * Every path with at least one waiting intent, plus its current holder (if
 * any) and its full waiter queue — the bulk view a periodic sweep needs.
 * `getLock`/`getWaiters` above require a path in hand; a caller that doesn't
 * know paths in advance (locks_contention, and point-guard's book) needs to
 * discover them first, which is what this does. Kept here rather than
 * duplicated as raw SQL in each caller, per this file's own contract: no one
 * outside this module opens locks.db directly.
 */
export function contendedPaths(db: LockDb, repoRoot?: string): ContendedPath[] {
  const waiting = db
    .prepare(
      `SELECT DISTINCT repo_root, rel_path FROM intents WHERE state = 'waiting'${
        repoRoot ? " AND repo_root = ?" : ""
      }`,
    )
    .all(...(repoRoot ? [repoRoot] : [])) as Array<{ repo_root: string; rel_path: string }>;

  return waiting
    .map((row) => ({
      repoRoot: row.repo_root,
      relPath: row.rel_path,
      holder: getLock(db, row.repo_root, row.rel_path),
      waiters: getWaiters(db, row.repo_root, row.rel_path),
    }))
    .filter((entry) => entry.waiters.length > 0);
}

export const STORE_DDL = generatedMigrations[0].sql;
export const MIGRATIONS = generatedMigrations;
