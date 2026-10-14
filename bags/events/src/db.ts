import generatedMigrations from "./generated/events-migrations.js";
import { migratedStorePath, openBagStore } from "@barry-rocks/sdk/stores";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bagDataDir } from "@barry-rocks/sdk/services";


export type EventsDb = Database.Database;

/** Authored SQL migrations are embedded in this generated catalog for bundled execution. */
export const MIGRATIONS: Array<{ name: string; sql: string }> = generatedMigrations;

const store = openBagStore({
  file: "events.db",
  migrations: MIGRATIONS,
  identityScoped: true,
  connect: (path) => new Database(path),
  path: () => process.env.BARRY_EVENTS_DB ?? migratedStorePath("events", "events", () => join(bagDataDir("events"), "events.db"), "unscoped"),
});

/** The instance's event log. `BARRY_EVENTS_DB` points a test at a scratch file. */
export const getDbPath = (): string => store.path();
export const getDb = (): EventsDb => store.db();
/** Test seam: point the module at a fresh database. */
export const setDb = (db: EventsDb): void => store.replace(db);
export const closeDb = (): void => store.close();
