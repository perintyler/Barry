import generatedMigrations from "../generated/identities-migrations.js";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { barryStoresDir, bagDataDir } from "@barry-rocks/sdk/services";
import { existsSync } from "node:fs";
/**
 * The identities store — `identities` and `actors`, and the `traits` and
 * `bounds` they are granted, in `identities.db` in the identities bag's data
 * directory.
 *
 * `identities` and `actors` move together because the only foreign key either
 * has is `identities.actor_id -> actors.id`, and splitting it across stores
 * would turn an enforced constraint into an unenforced one; the baseline
 * migration states the full argument. Traits and bounds are this bag's too:
 * it writes them, and every reader goes through its modules.
 *
 * Same driver, pragmas, imported migrations and migration runner as every
 * Barry store.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { IdentitiesStoreDatabase } from "./identities-types.js";

import { openBagStore } from "@barry-rocks/sdk/stores";

/** Authored SQL migrations are embedded in this generated catalog for bundled execution. */
export const MIGRATIONS = generatedMigrations;

let _db: Kysely<IdentitiesStoreDatabase> | null = null;

/**
 * Where the store lives.
 *
 * `BARRY_IDENTITIES_DB` mirrors `BARRY_SESSIONS_DB`: without an override every
 * test would share the developer's real identities, and the suites here create
 * and delete freely — a test run could destroy the barry they work as.
 */
export function identitiesDbPath(): string {
  if (process.env.BARRY_IDENTITIES_DB) return process.env.BARRY_IDENTITIES_DB;
  if (existsSync(join(barryStoresDir(), "active.json"))) return join(activeStoreRoot(), "node", "identities", "identities.db");
  return join(bagDataDir("identities"), "identities.db");
}

/**
 * Opened through the sdk's store opener: migrations under one write lock, so
 * two processes opening a fresh store together cannot both apply the first,
 * and a store stamped newer than this build knows is refused. The scratch
 * guard runs before anything is created, since creating the bag's data
 * directory is already a write to the tree it keeps test runs out of.
 * Foreign keys are on: `identities.actor_id` is a real foreign key with ON
 * DELETE CASCADE, and a CASCADE that silently does not fire is the failure
 * keeping these two tables together was meant to avoid (asserted in the drift
 * test).
 */
const store = openBagStore({
  file: "identities.db",
  migrations: MIGRATIONS,
  scratchGuard: "identities",
  connect: (path) => new BetterSqlite3(path),
  path: identitiesDbPath,
});

/** The raw handle, for the drift test and the data migration. */
export const getIdentitiesSqlite = (): BetterSqlite3.Database => store.db();

/**
 * The Kysely client the ported identity modules query through.
 *
 * No `jsonColumnPlugin`, unlike the sessions store: every JSON write in
 * identities.ts and users.ts is explicitly `JSON.stringify`'d at the call site,
 * because those writes MERGE into the stored document rather than replacing it
 * (`json_patch` here, a merge operator before) and a plugin that
 * serialised the bind silently would not make the merge correct.
 */
export function getIdentitiesDb(): Kysely<IdentitiesStoreDatabase> {
  if (!_db) {
    _db = new Kysely<IdentitiesStoreDatabase>({
      dialect: new SqliteDialect({ database: getIdentitiesSqlite() }),
    });
  }
  return _db;
}

export function closeIdentitiesDb(): void {
  _db = null;
  store.close();
}

export async function backupIdentitiesDb(destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  await getIdentitiesSqlite().backup(destination);
}
