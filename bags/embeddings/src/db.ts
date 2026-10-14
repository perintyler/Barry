import generatedMigrations from "./generated/embeddings-migrations.js";
import { migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";
import { bagDataDir } from "@barry-rocks/sdk/services";

import { join } from "node:path";
import Database from "better-sqlite3";

export type VectorDb = Database.Database;

/** Authored SQL migrations are embedded in this generated catalog for bundled execution. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = generatedMigrations;

const store = openBagStore({
  file: "embeddings.db",
  migrations: MIGRATIONS,
  identityScoped: true,
  connect: (path) => new Database(path),
  path: () => process.env.BARRY_EMBEDDINGS_DB ?? migratedStorePath("embeddings", "embeddings", () => join(bagDataDir("embeddings"), "embeddings.db"), "unscoped"),
});

export const getDbPath = (): string => store.path();
export const getDb = (): VectorDb => store.db();
/** Test seam: point the module at a fresh database. */
export const setDb = (db: VectorDb): void => store.replace(db);
export const closeDb = (): void => store.close();
