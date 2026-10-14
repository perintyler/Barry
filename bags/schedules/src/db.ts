import generatedMigrations from "./generated/schedules-migrations.js";
import { migratedStorePath, migrateStore } from "@barry-rocks/sdk/stores";
/**
 * Where schedule state lives: schedules.db in the schedules bag's data directory.
 *
 * Only STATE is stored here — when each schedule last fired, when it fires
 * next, whether it is paused — plus the schedules created at runtime. The
 * definitions of bag schedules stay in their bag.yaml, and the runs they
 * produce are action runs in actions.db, so a scheduled run reads the same as
 * any other run of that action.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { bagDataDir } from "@barry-rocks/sdk/services";


export type SchedulesDb = Database.Database;

let _db: SchedulesDb | null = null;

export function getDbPath(): string {
  return process.env.BARRY_SCHEDULES_DB ?? migratedStorePath("schedules", "schedules", () => join(bagDataDir("schedules"), "schedules.db"), "schedules", "node");
}

/** Generated from append-only SQL files; see sdk/scripts/store-migrations.json. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = generatedMigrations;

function migrate(db: SchedulesDb): void {
  migrateStore(db, MIGRATIONS, "schedules.db");
}

export function getDb(): SchedulesDb {
  if (!_db) {
    const path = getDbPath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    _db = new Database(path);
    // Wait for locks before anything else: switching to WAL takes one, and two
    // processes opening a new store together failed with "database is locked"
    // when the switch came first.
    _db.pragma("busy_timeout = 5000");
    _db.pragma("journal_mode = WAL");
    migrate(_db);
  }
  return _db;
}

/** Test seam: point the module at a fresh database. */
export function setDb(db: SchedulesDb): void {
  _db?.close();
  _db = db;
  migrate(db);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
