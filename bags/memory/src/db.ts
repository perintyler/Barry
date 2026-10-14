import generatedMigrations from "./generated/memory-migrations.js";
import { migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bagDataDir } from "@barry-rocks/sdk/services";


export type MemoryDb = Database.Database;

/** Authored SQL migrations are embedded in this generated catalog for bundled execution. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = generatedMigrations;

const store = openBagStore({
  file: "memory.db",
  migrations: MIGRATIONS,
  identityScoped: true,
  connect: (path) => new Database(path),
  path: () => process.env.BARRY_MEMORY_DB ?? migratedStorePath("memory", "memory", () => join(bagDataDir("memory"), "memory.db"), "unscoped"),
});

export const getDbPath = (): string => store.path();
export const getDb = (): MemoryDb => store.db();
/** Test seam: point the module at a fresh database. */
export const setDb = (db: MemoryDb): void => store.replace(db);
export const closeDb = (): void => store.close();
