import { migrateStore, type Migration } from "@barry-rocks/sdk/stores";
// Share local SQLite opening policy while keeping telemetry reads independent of API availability.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-065

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

export interface BagStoreOptions {
  /** Absolute path to the SQLite file. Created, with its directory, if absent. */
  path: string;
  /** Schema, idempotent. Runs on every open, so every DDL must be `IF NOT EXISTS`. */
  ddl: string;
  migrations?: readonly Migration[];
  // A bounded busy timeout tolerates a concurrent writer without blocking indefinitely.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-066
  busyTimeoutMs?: number;
}

/**
 * Open (creating if needed), apply pragmas, and migrate.
 *
 * Idempotent: every reader and writer calls it on every open, which is what
 * lets this bag have no migration framework at all.
 */
export function openBagStore({ path, ddl, migrations, busyTimeoutMs }: BagStoreOptions): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  if (busyTimeoutMs !== undefined) db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("synchronous = NORMAL");

  if (migrations) migrateStore(db, migrations, path); else db.exec(ddl);
  return db;
}
