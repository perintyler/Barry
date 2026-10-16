/**
 * Kysely interfaces for the identities store (see identities-db.ts).
 *
 * Separate from types.ts rather than reusing the legacy interfaces, because
 * the column TYPES genuinely differ and pretending otherwise is how a port goes
 * wrong quietly — the same argument config-types.ts makes:
 *
 *   - JSON columns are `string` here, not `unknown`. SQLite hands back the TEXT
 *     it stored; the previous driver handed back a parsed object.
 *     `identities.metadata` is
 *     the one that matters: `parseIdentityMetadata` already handles both, but
 *     only because it was written defensively — typing the column `unknown`
 *     would let a caller write `identity.metadata.github` against a string with
 *     no error at the boundary.
 *   - Timestamps are `string` (ISO-8601 text), not `Date`. `rowToBarry` called
 *     `.toISOString()` on them, which throws on a string, so the port has to
 *     handle both shapes rather than assume.
 *
 * The rule the shape encodes: every JSON column crossing this boundary must be
 * parsed by hand. Saying so in the type is what makes the compiler enforce it.
 */
import type { ColumnType } from "kysely";

/** Written as ISO text; supplied by the caller or defaulted by the column. */
type TimestampText = ColumnType<string, string | undefined, string>;

/** A JSON document held as TEXT. Read it through a parse helper, never a cast. */
type JsonText = ColumnType<string, string | undefined, string>;

export interface IdentitiesStoreActorsTable {
  /**
   * NOT `Generated<number>`. The migration preserves the production ids
   * explicitly, and `Generated` would let a caller omit one — which is exactly
   * how the ids would drift from the tokens 901 sessions already reference.
   * Insertable-optional so ordinary creates can still let SQLite assign.
   */
  id: ColumnType<number, number | undefined, never>;
  token: string;
  type: "user" | "agent";
  name: string;
  email: string | null;
  username: string | null;
  settings: JsonText;
  provider: string | null;
  metadata: JsonText;
  created_at: TimestampText;
}

export interface IdentitiesStoreIdentitiesTable {
  /** See the actors note — ids 3 and 16 are referenced by 884 sessions. */
  id: ColumnType<number, number | undefined, never>;
  token: string;
  actor_id: number;
  name: string;
  metadata: JsonText;
  created_at: TimestampText;
  last_used_at: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface DeviceCredentialsTable {
  id: string; name: string; token_hash: string; token_prefix: string; actor_id: number;
  scopes: string; identity_ids: string; created_at: number; unused_expires_at: number;
  expires_at: number | null; first_used_at: number | null; last_used_at: number | null; revoked_at: number | null;
}
export interface PairingRequestsTable {
  id: string; code: string; poll_token_hash: string; source_hash: string; client_name: string;
  requested_scopes: string; requested_identity_ids: string; approved_scopes: string | null; approved_identity_ids: string | null;
  actor_id: number | null; approved_at: number | null;
  status: "pending" | "authorized" | "rejected" | "expired" | "consumed";
  created_at: number; expires_at: number; credential_expires_at: number | null; last_claim_at: number | null; issued_device_id: string | null;
}

export interface IdentitiesStoreDatabase {
  installation_owner: { singleton: 1; actor_id: number; actor_token: string; actor_type: "user"; bound_at: number };
  device_credentials: DeviceCredentialsTable;
  pairing_requests: PairingRequestsTable;
  actors: IdentitiesStoreActorsTable;
  identities: IdentitiesStoreIdentitiesTable;
}

export type IdentitiesStoreTableName = keyof IdentitiesStoreDatabase;

/**
 * The runtime mirror of the interfaces above, read by the drift test.
 *
 * TypeScript types are erased, so nothing at runtime can compare the interfaces
 * to the live schema. This list is what makes the drift test possible, and it
 * only works if it is maintained in lockstep — which is why the test asserts
 * BOTH directions.
 *
 * Keep entries in the same order as the interface fields.
 */
export const IDENTITIES_TABLE_COLUMNS: Record<IdentitiesStoreTableName, readonly string[]> = {
  installation_owner: ["singleton", "actor_id", "actor_token", "actor_type", "bound_at"],
  device_credentials: ["id", "name", "token_hash", "token_prefix", "actor_id", "scopes", "identity_ids", "created_at", "unused_expires_at", "expires_at", "first_used_at", "last_used_at", "revoked_at"],
  pairing_requests: ["id", "code", "poll_token_hash", "source_hash", "client_name", "requested_scopes", "requested_identity_ids", "approved_scopes", "approved_identity_ids", "actor_id", "approved_at", "status", "created_at", "expires_at", "credential_expires_at", "last_claim_at", "issued_device_id"],
  actors: [
    "id", "token", "type", "name",
    "email", "username", "settings", "provider",
    "metadata", "created_at",
  ],
  identities: ["id", "token", "actor_id", "name", "metadata", "created_at", "last_used_at"],
};
