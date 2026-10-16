/**
 * Fixtures for other packages' tests: the identities store's handle, to seed
 * rows a test needs and to break them on purpose. Refused outside a test run,
 * so production code cannot reach the storage the package root keeps private.
 */
import type BetterSqlite3 from "better-sqlite3";
import { closeIdentitiesDb, getIdentitiesSqlite } from "./store/identities-db.js";

function assertUnderTest(): void {
  if (!process.env.VITEST) throw new Error("@barry-rocks/identities-bag/testing is for tests; use the package root");
}

export function identitiesSqlite(): BetterSqlite3.Database {
  assertUnderTest();
  return getIdentitiesSqlite();
}

export function closeIdentitiesStore(): void {
  assertUnderTest();
  closeIdentitiesDb();
}
