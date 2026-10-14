import generatedMigrations from "./generated/logs-migrations.js";
import { migrateStore, openStoreFile, migratedStorePath } from "@barry-rocks/sdk/stores";


// Keep schema and retention together; a logs sub-bag must never depend on its collector parent.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-002

import { join } from "node:path";
import Database from "better-sqlite3";
import { LEVEL } from "@barry-rocks/sdk/logging";
import { bagDataDir } from "@barry-rocks/sdk/services";

export type Db = Database.Database;

// Evaluate severity bands first so debug volume does not dictate error retention.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-003
export const RETENTION_DAYS: Array<{ minLevel: number; days: number }> = [
  { minLevel: LEVEL.error, days: 30 },
  { minLevel: LEVEL.warn, days: 14 },
  { minLevel: LEVEL.info, days: 3 },
  { minLevel: 0, days: 1 },
];

export function logsDbPath(): string {
  return process.env.BARRY_LOGS_DB || migratedStorePath("logs", "logs", () => join(bagDataDir("logs"), "logs.db"), "logs", "node");
}

// The caller owns the WAL handle; telemetry accepts NORMAL durability and uses UNIX seconds.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-004
export function openLogsDb(path = logsDbPath()): Db {
  const db = openStoreFile(path, { connect: (file) => new Database(file), foreignKeys: false, synchronous: "NORMAL" });
  migrateStore(db, MIGRATIONS, path);
  return db;
}

// Disjoint severity bands prune each row once; report deleted counts even when zero.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-005
export function prune(
  db: Db,
  now = Math.floor(Date.now() / 1000),
  bands = RETENTION_DAYS,
): Array<{ minLevel: number; deleted: number }> {
  const out: Array<{ minLevel: number; deleted: number }> = [];
  const sorted = [...bands].sort((a, b) => b.minLevel - a.minLevel);

  for (let i = 0; i < sorted.length; i++) {
    const band = sorted[i];
    const upper = i === 0 ? Number.MAX_SAFE_INTEGER : sorted[i - 1].minLevel;
    const cutoff = now - band.days * 86_400;
    const r = db
      .prepare("DELETE FROM log_event WHERE level >= ? AND level < ? AND ts < ?")
      .run(band.minLevel, upper, cutoff);
    out.push({ minLevel: band.minLevel, deleted: r.changes });
  }
  return out;
}

export const STORE_DDL = generatedMigrations[0].sql;
export const MIGRATIONS = generatedMigrations;
