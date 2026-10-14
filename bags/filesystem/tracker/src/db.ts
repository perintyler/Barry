import generatedMigrations from "./generated/file-tracker-migrations.js";
import { migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { bagDataDir } from "@barry-rocks/sdk/services";


export const MIGRATIONS = generatedMigrations;

const store = openBagStore({
  file: "file-tracker.db",
  migrations: MIGRATIONS,
  connect: (path) => {
    const database = new Database(path);
    if (!(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get())) database.pragma("auto_vacuum = INCREMENTAL");
    return database;
  },
  path: () => process.env.BARRY_FILE_TRACKER_DB
    ?? migratedStorePath("tracker", "file-tracker", () => join(bagDataDir("tracker"), "file-tracker.db"), "file-tracker", "node"),
});

// Report the resolved store path instead of a hardcoded backend label.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-012
export const getDbPath = (): string => store.path();
export const getDb = (): Database.Database => store.db();

export async function backupDb(destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  await getDb().backup(destination);
}

export const closeDb = (): void => store.close();
