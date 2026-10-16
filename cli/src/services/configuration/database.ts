import { migratedStorePath, assertScratchStoreUnderTest, migrateStore } from "@barry-rocks/sdk/stores";
/**
 * Core's config store: the bag registry (`bags`) and the port each service was
 * assigned (`service_ports`), in `<app support>/config.db`.
 *
 * The one writer of `bags` is registration.ts beside this file, which also
 * publishes the snapshot every other reader uses; the service management owns
 * `service_ports`. Identities and actors belong to the identities bag and live in
 * its store. A store is opened only by its owner's code.
 *
 * Kysely over better-sqlite3, the driver and WAL + busy_timeout settings every
 * Barry store uses.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { ConfigDatabase } from "./types.js";
import { coreMigrations } from "./provider.js";


import { barryAppSupportDir } from "@barry-rocks/sdk/services";

/**
 * Migrations are IMPORTED, not read off disk.
 *
 * `migrations/` is not listed in package.json `files`, so a filesystem read
 * resolves fine in this checkout and fails for anyone who installs the package
 * — the worst shape of bug, invisible exactly where it is tested. The
 * file-tracker store hit this first and its migrations carry the same note.
 */
export const MIGRATIONS = coreMigrations;

let _sqlite: BetterSqlite3.Database | null = null;
let _db: Kysely<ConfigDatabase> | null = null;

/**
 * Where the store lives.
 *
 * `BARRY_CONFIG_DB` mirrors `BARRY_FILE_TRACKER_DB`: without an override every
 * test would share the developer's real config, so a test run could delete the
 * bags they have installed.
 */
export function configDbPath(): string {
  return process.env.BARRY_CONFIG_DB
    ?? migratedStorePath("core", "config", () => join(barryAppSupportDir(), "config.db"), "config", "node");
}

/**
 * Apply any migrations this file has not seen, through the sdk's runner: the
 * version is read and the migrations applied under one write lock, and a store
 * stamped newer than this build knows is refused.
 */
function migrate(sqlite: BetterSqlite3.Database): void {
  migrateStore(sqlite, MIGRATIONS, "config.db");
}

/**
 * Is this the machine's real config store, or a redirected one?
 *
 * A store reached through `BARRY_CONFIG_DB` is a test's or a worktree's; the
 * default path is the machine's. Pure, and keyed on the path rather than the
 * file's contents, so both branches are reachable in a test on a machine whose
 * only store IS the default one.
 */
export function isSharedConfigStore(): boolean {
  return !process.env.BARRY_CONFIG_DB;
}

/**
 * Refuse to serve a DEFAULT-PATH config store that has no bags in it.
 *
 * The sessions store once had the same guard, for the same reason: better-sqlite3 CREATES the file it is pointed at, so a
 * path that resolves somewhere unexpected does not fail — it migrates an empty
 * database and every reader gets zero rows back with a successful return. Zero
 * bags is indistinguishable from "no bags are registered", which is the exact
 * "check that cannot fail" shape.
 *
 * This is not hypothetical: a 0-byte config.db once sat at a path an older
 * layout pattern-matched to, inert only because every live handle was on the
 * real path, and nothing would have said so otherwise.
 *
 * Scoped to the SHARED store on purpose. A redirected store is legitimately
 * empty: every suite here starts from a fresh temp file, and `barry db
 * migrate-config` fills one from scratch. Guarding those would refuse the
 * populating write itself. The threshold is "any bag at all" rather than a
 * count, so it cannot rot as bags come and go.
 */
function assertConfigStorePopulated(sqlite: BetterSqlite3.Database): void {
  if (!isSharedConfigStore()) return;
  if (process.env.BARRY_CONFIG_ALLOW_EMPTY === "1") return;
  const row = sqlite
    .prepare("SELECT EXISTS(SELECT 1 FROM bags) AS any_rows")
    .get() as { any_rows: number };
  if (row.any_rows) return;
  throw new Error(
    `config store: the machine's config store (${configDbPath()}) has no bags in it. `
      + "better-sqlite3 creates the file it is pointed at, so this usually means an empty "
      + "database was just created at a path that is not the real store. Refusing to serve "
      + "an empty registry; set BARRY_CONFIG_ALLOW_EMPTY=1 if a genuinely empty store is intended.",
  );
}

/** The raw handle, for the migration tooling and tests that inspect the schema. */
export function getConfigSqlite(): BetterSqlite3.Database {
  if (!_sqlite) {
    const path = configDbPath();
    // Before mkdirSync, not after: creating the instance's directory is already
    // a write to the tree this guard exists to keep test runs out of.
    assertScratchStoreUnderTest("config", path);
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = new BetterSqlite3(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    migrate(sqlite);
    // Only after a successful check does the handle get cached. Assigning
    // `_sqlite` first would leave a poisoned module-level handle behind on
    // throw, and the NEXT call would sail past this guard and use it.
    assertConfigStorePopulated(sqlite);
    _sqlite = sqlite;
  }
  return _sqlite;
}

/**
 * The Kysely client the config modules query through.
 *
 * Lazy by design: importing this module must not create
 * a file, or every process that merely imports the package would materialise a
 * config store it never reads.
 */
export function getConfigDb(): Kysely<ConfigDatabase> {
  if (!_db) {
    _db = new Kysely<ConfigDatabase>({
      dialect: new SqliteDialect({ database: getConfigSqlite() }),
    });
  }
  return _db;
}

export function closeConfigDb(): void {
  _db = null;
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
  }
}

export async function backupConfigDb(destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  await getConfigSqlite().backup(destination);
}
