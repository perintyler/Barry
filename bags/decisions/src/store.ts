import generatedMigrations from "./generated/decisions-migrations.js";
import { migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";
import { bagDataDir } from "@barry-rocks/sdk/services";

import { join } from "node:path";
import Database from "better-sqlite3";

export type DecisionsDb = Database.Database;

/** Authored SQL migrations are embedded in this generated catalog for bundled execution. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = generatedMigrations;

const store = openBagStore({
  file: "decisions",
  migrations: MIGRATIONS,
  identityScoped: true,
  connect: (path) => new Database(path),
  path: () => process.env.BARRY_DECISIONS_DB ?? migratedStorePath("decisions", "decisions", () => join(bagDataDir("decisions"), "decisions.db"), "unscoped"),
});

export const getDbPath = (): string => store.path();
export const getDb = (): DecisionsDb => store.db();
/** Test seam: close the cached handle so a new one opens against a new path. */
export const closeDb = (): void => store.close();
