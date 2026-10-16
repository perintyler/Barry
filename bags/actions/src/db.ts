import generatedMigrations from "./generated/actions-migrations.js";
import { migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";

/**
 * Where action runs live: this bag's own SQLite store. The rows are owned by
 * one bag and nothing joins them to anything else.
 *
 * Three representation choices:
 *
 * 1. **`metadata`, `validation_failures` and `output` are TEXT.** The first two
 *    hold JSON, read whole rather than queried by key, so TEXT holding JSON is
 *    the whole of it. `output` stays verbatim -- `output_type` says how to
 *    read it.
 *
 * 2. **Timestamps are ISO-8601 TEXT.** Same format and same reason as the
 *    sessions store: they sort lexicographically in timestamp order, which is
 *    what `ORDER BY started_at DESC` needs.
 *
 * 3. **`session_id` is a plain column, NOT a foreign key.** The sessions store
 *    is a DIFFERENT database file (the sessions bag's sessions.db), so there is
 *    nothing here to reference; a run's session resolves through
 *    @barry-rocks/sessions-bag/client in application code. An FK would either
 *    have to be pointed at a table that does not exist or be satisfied by
 *    copying sessions into this file, and both are worse than a documented
 *    soft reference.
 */

import { join, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { bagDataDir } from "@barry-rocks/sdk/services";


export type ActionsDb = Database.Database;

/** Authored SQL migrations are embedded in this generated catalog for bundled execution. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = generatedMigrations;

const store = openBagStore({
  file: "actions.db",
  migrations: MIGRATIONS,
  identityScoped: true,
  connect: (path) => new Database(path),
  path: () => process.env.BARRY_ACTIONS_DB ?? migratedStorePath("actions", "actions", () => join(bagDataDir("actions"), "actions.db"), "infrastructure"),
});
let replaced: ActionsDb | null = null;

/** The instance's action runs. `BARRY_ACTIONS_DB` points a test at a scratch file. */
export function getDbPath(): string {
  if (!currentStoreContext()?.identity && replaced?.name && replaced.name !== ":memory:") return replaced.name;
  return store.path();
}

export const getDb = (): ActionsDb => store.db();

/** Test seam: point the module at a fresh database. */
export function setDb(db: ActionsDb): void {
  store.replace(db);
  replaced = db;
}

export function closeDb(): void {
  store.close();
  replaced = null;
}

/** A trusted host selects the exact projection file; no ambient identity fallback. */
export function openActionWorkProjectionStore(path: string): { database: ActionsDb; close(): void } {
  if (!isAbsolute(path)) throw new Error("Projection store path must be absolute.");
  const selected = openBagStore({ file: "actions.db", identityScoped: false, migrations: MIGRATIONS, synchronous: "FULL", path: () => path, connect: file => new Database(file) });
  const database = selected.db();
  // Background publication must yield to scheduling when this store is busy.
  database.pragma("busy_timeout = 50");
  return { database, close: () => selected.close() };
}
