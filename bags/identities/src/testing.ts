/**
 * Fixtures for other packages' tests: the identities store's handle, to seed
 * rows a test needs and to break them on purpose. Refused outside a test run,
 * so production code cannot reach the storage the package root keeps private.
 */
import type BetterSqlite3 from "better-sqlite3";
import { closeIdentitiesDb, getIdentitiesSqlite } from "./store/identities-db.js";
import { sessionPolicy, type SessionPolicyReaders } from "./config/session-bound.js";

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

/**
 * `traits.context` and `traits.bound` composed over readers a test supplies,
 * for a suite that fakes the identities operations: the composition is the
 * bag's own, only the store underneath is synthetic.
 */
export function sessionPolicyOver(readers: SessionPolicyReaders): ReturnType<typeof sessionPolicy> {
  assertUnderTest();
  return sessionPolicy(readers);
}
export type { SessionPolicyReaders };
