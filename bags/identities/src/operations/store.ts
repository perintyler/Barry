/**
 * The identities store as a whole: closing it (a process that is done with it,
 * or a test isolating itself) and backing it up. Its handle and path stay
 * private.
 */
import { backupIdentitiesDb, closeIdentitiesDb, identitiesDbPath } from "../store/identities-db.js";

export const store = {
  close: closeIdentitiesDb,
  backup: backupIdentitiesDb,
  /** Where the store lives, for `barry db` to report and to refuse a legacy layout. */
  path: identitiesDbPath,
};
