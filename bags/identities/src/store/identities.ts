import { sql, type RawBuilder } from "kysely";
import { getIdentitiesDb } from "./identities-db.js";
import { generateBarryToken } from "../tokens.js";
import { getUser } from "./users.js";
// Runtime import in this direction only: identity-files imports nothing but
// types from this module, and reaches its functions through dynamic imports.
import { FILE_OWNED_FIELDS, findIdentityDirectoryByName, updateIdentity } from "./identity-files.js";

/**
 * Identities live in the identities store. See identities-db.ts
 * for why `actors` came along.
 *
 * Called per-query rather than captured once: the handle is
 * lazy, so binding it at module scope would materialise the database file in
 * every process that merely imports this bag.
 */
const db = () => getIdentitiesDb();

// Barry metadata shape — stored as JSON TEXT in identities.metadata
export interface IdentityMetadata {
  inherits?: string;
  secrets?: import("@barry-rocks/sdk/internal/identities").SecretBindings;
  /**
   * Human-readable name for display. `name` stays the identifier every command
   * and config file addresses the Barry by; this is what a UI shows instead.
   */
  display_name?: string;
  /** Extra command names this identity answers to. See `IdentityYaml.aliases`. */
  aliases?: string[];
  vault?: string;
  bounds?: import("@barry-rocks/sdk/internal/identities").IdentityEntries;
  bags?: string[];
  bag_configs?: import("@barry-rocks/sdk/internal/identities").IdentityDefinition["bag_configs"];
  /**
   * Deny rules written inline rather than referencing a `bounds` entry. Set from
   * a file-based Barry's `identity.yaml`, which has no id to point at one. Merges
   * as one more source in the union of denials, alongside named
   * bounds.
   */
  bound?: import("@barry-rocks/sdk/bounds").Bound & Record<string, unknown>;
  /** Legacy JSON key, read as a fallback — migration 028 renames it. */
  scope?: Record<string, unknown>;
  adapters?: import("@barry-rocks/sdk").IdentityAdapters;
  /**
   * Default notifier for the record_event tool: which existing tool the agent
   * should call to deliver an event, and an optional target (Slack channel,
   * phone number, …). Overridable per call via the tool's params.
   *
   * The key stays `status_notify` for compatibility — renaming it would drop
   * the notifier from every barry that has one configured.
   */
  status_notify?: { tool: string; target?: string };
  /**
   * Which GitHub App installation this barry answers for. The webhook receiver
   * is one shared process serving many identities; GitHub sends `installation.id`
   * on every App event, and it is the only stable identifier tied to the app
   * credentials, so it is the routing key from a webhook to a barry.
   */
  github?: { installationId: number };
  /**
   * How deferred tools are discovered and called.
   * - "provider": all tools in tools/list, client handles deferral (Claude Code)
   * - "barry": deferred tools hidden from tools/list, discoverable via
   *   tool_search and invokable via call_tool (works on any MCP client)
   */
  tool_discovery?: "provider" | "barry";
  [key: string]: unknown;
}

export interface IdentityRecord {
  id: number;
  token: string;
  actor_id: number;
  name: string;
  metadata: IdentityMetadata;
  created_at: string;
  last_used_at: string | null;
}

export function parseIdentityMetadata(raw: unknown): IdentityMetadata {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as IdentityMetadata;
    } catch {
      return {};
    }
  }
  return raw as IdentityMetadata;
}

/**
 * Normalise a timestamp column to ISO-8601 text.
 *
 * SQLite stores these as TEXT and hands back a string; the previous driver
 * handed back a `Date`. The old code called `.toISOString()` unconditionally,
 * which throws on a string — so this cannot simply be dropped.
 *
 * Both shapes are accepted rather than only the new one: rows written by
 * `CURRENT_TIMESTAMP` arrive as `"YYYY-MM-DD HH:MM:SS"` (space-separated, no
 * zone), while rows the data migration carried over are already
 * strict ISO. Re-parsing normalises the former without corrupting the latter,
 * and an unparseable value is passed through rather than silently blanked.
 */
function toIsoText(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function rowToBarry(row: {
  id: number;
  token: string;
  actor_id: number;
  name: string;
  metadata: unknown;
  created_at: Date | string | null;
  last_used_at: Date | string | null;
}): IdentityRecord {
  return {
    id: row.id,
    token: row.token,
    actor_id: row.actor_id,
    name: row.name,
    metadata: parseIdentityMetadata(row.metadata),
    created_at: toIsoText(row.created_at) ?? "",
    last_used_at: toIsoText(row.last_used_at),
  };
}

export async function getIdentity(id: number): Promise<IdentityRecord | undefined> {
  const row = await db()
    .selectFrom("identities")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? rowToBarry(row) : undefined;
}

export async function getIdentityByName(actorId: number, name: string): Promise<IdentityRecord | undefined> {
  const row = await db()
    .selectFrom("identities")
    .selectAll()
    .where("actor_id", "=", actorId)
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? rowToBarry(row) : undefined;
}

export async function listIdentities(actorId: number): Promise<IdentityRecord[]> {
  const rows = await db()
    .selectFrom("identities")
    .selectAll()
    .where("actor_id", "=", actorId)
    .orderBy("name", "asc")
    .execute();
  return rows.map(rowToBarry);
}

export async function listAllIdentities(): Promise<IdentityRecord[]> {
  const rows = await db()
    .selectFrom("identities")
    .selectAll()
    .orderBy("name", "asc")
    .execute();
  return rows.map(rowToBarry);
}

/**
 * Find the barry that answers for a GitHub App installation.
 *
 * Two identities claiming the same installation is a config error, not a request
 * error: a webhook is not the place to surface it as a 500. Return the lowest
 * id deterministically so the same barry answers every time, and log which
 * identities collided so the misconfiguration is still visible.
 */
export async function findIdentityByGitHubInstallation(
  installationId: number,
  log?: { warn(event: string, fields: Record<string, unknown>): void },
): Promise<IdentityRecord | null> {
  const rows = await db()
    .selectFrom("identities")
    .selectAll()
    // CAST(... AS TEXT) is load-bearing, not tidiness.
    //
    // The previous engine's `->>` rendered any JSON scalar as text, so
    // `metadata->'github'->>'installationId' = '115967328'` matched a stored
    // NUMBER by accident of the operator. SQLite's `json_extract` returns the
    // NATIVE type instead: an integer compared against a text parameter is
    // false, so a mechanical translation of this query matches NOTHING.
    //
    // Production stores a number — identity `bux` holds a JSON number for
    // `metadata->'github'->'installationId'` — and the
    // CLI writes one (cli/src/commands/identity.ts, `Number(installationId)`).
    // The cast makes the comparison type-agnostic so both encodings match,
    // which matters because an identity edited by hand may hold a string.
    //
    // The failure this prevents has NO error to notice: the lookup returns
    // null, the webhook receiver reads that as "no barry claims this
    // installation" and falls back to env credentials, so the event is answered
    // by the wrong identity rather than raised. Pinned by
    // identities-installation-sqlite.test.ts, which also demonstrates that a
    // STRING-seeded fixture passes in the broken state.
    .where(
      sql<boolean>`CAST(json_extract(metadata, '$.github.installationId') AS TEXT) = ${String(installationId)}`,
    )
    .orderBy("id", "asc")
    .execute();

  if (rows.length === 0) return null;

  if (rows.length > 1) {
    log?.warn("barry.github_installation_ambiguous", {
      installationId,
      identities: rows.map((r) => r.name),
      chose: rows[0].name,
    });
  }

  return rowToBarry(rows[0]);
}

/**
 * Points the actor's `defaultBarry` at `identityName` when they have no usable
 * pointer — either it is unset, or it names a barry that no longer exists.
 * A valid pointer is never overwritten, so the first barry created wins and
 * later ones leave the choice alone.
 *
 * Returns true when the pointer was claimed.
 */
export async function claimDefaultIdentityIfUnset(
  actorId: number,
  identityName: string,
): Promise<boolean> {
  const user = await getUser(actorId);
  if (!user) return false;

  const current = (user.settings ?? {}).defaultBarry;

  if (typeof current === "string" && current.length > 0) {
    // Keep a pointer that still resolves; reclaim one left dangling by a delete.
    const existing = await getIdentityByName(actorId, current);
    if (existing) return false;
  }

  // Written as one conditional UPDATE rather than read-modify-write. Two
  // creates can race here — the CLI and the API are separate processes — and a
  // read-then-write would let the later writer clobber the earlier claim, so
  // "first wins" would really be "last wins". The WHERE clause re-checks
  // emptiness at write time so exactly one racer claims it.
  //
  // `json_set` replaces the previous engine's create-missing JSON set, and
  // is a genuine equivalent rather than an approximation: it sets ONE path and
  // returns the rest of the document untouched, creating the key when absent.
  // That merge behaviour is the point — an unrelated concurrent settings write
  // (a theme, a preference) must not be lost to a claim that rewrote the whole
  // blob. `${identityName}` binds as a TEXT parameter, which json_set stores as
  // a JSON string, matching the previous text-to-JSON cast.
  //
  // `coalesce` is kept although the column is NOT NULL with a '{}' default: it
  // costs nothing and json_set propagates NULL, so a row that somehow held one
  // would have its settings silently erased rather than claimed.
  const result = await db()
    .updateTable("actors")
    .set({
      settings: sql`json_set(coalesce(settings, '{}'), '$.defaultBarry', ${identityName})`,
    })
    .where("id", "=", actorId)
    .where("type", "=", "user")
    .where((eb) =>
      eb.or([
        // `json_extract` on an absent key yields SQL NULL, so the "never set"
        // case still lands on this branch exactly as `->>` did.
        eb(sql`json_extract(settings, '$.defaultBarry')`, "is", null),
        eb(sql`json_extract(settings, '$.defaultBarry')`, "=", ""),
        // The dangling-pointer case: re-checked here so the claim stays atomic.
        eb(
          sql`json_extract(settings, '$.defaultBarry')`,
          "=",
          typeof current === "string" ? current : "",
        ),
      ]),
    )
    .executeTakeFirst();

  return (result.numUpdatedRows ?? 0n) > 0n;
}

export async function createIdentity(data: {
  actor_id: number;
  name: string;
  metadata?: IdentityMetadata;
}): Promise<IdentityRecord> {
  const token = generateBarryToken();
  const row = await db()
    .insertInto("identities")
    .values({
      token,
      actor_id: data.actor_id,
      name: data.name,
      // Serialised here rather than by a Kysely plugin: better-sqlite3 rejects
      // an object bind, and this store carries no jsonColumnPlugin (see
      // identities-db.ts) because every other JSON write on this table is a
      // merge expression, not a plain bind.
      metadata: JSON.stringify(data.metadata ?? {}),
      last_used_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Nothing seeds a default barry, so the first one created has to claim the
  // pointer or the user would have to set it by hand before anything resolves.
  // Never let this fail the create — the barry exists either way, and the
  // pointer can be set later.
  try {
    await claimDefaultIdentityIfUnset(data.actor_id, data.name);
  } catch (err) {
    diagnostics.warn("identities.active_pointer_failed", { detail: `Failed to claim active barry pointer for '${data.name}': ${err instanceof Error ? err.message : String(err)}` });
  }

  return rowToBarry(row);
}

export async function deleteIdentity(id: number): Promise<void> {
  await db()
    .deleteFrom("identities")
    .where("id", "=", id)
    .execute();

}

/**
 * Change a Barry's identifier.
 *
 * Sessions reference the Barry by id, so they follow the rename. What does not
 * follow is anything storing the name as a string — the active-Barry pointer
 * and a repo's `.barry/config.yaml`. Callers own repointing those.
 */
export async function renameIdentity(id: number, name: string): Promise<IdentityRecord | undefined> {
  await db().updateTable("identities").set({ name }).where("id", "=", id).executeTakeFirst();
  return getIdentity(id);
}

/**
 * A SHALLOW top-level merge of `updates` into the `metadata` column — the
 * faithful SQLite equivalent of the previous engine's document merge operator.
 *
 * NOT `json_patch`, which is the obvious-looking translation and is WRONG here.
 * `json_patch` implements RFC-7386 merge-patch, which differs from that merge
 * in two ways that both corrupt data silently:
 *
 *   1. It merges nested objects RECURSIVELY. The old merge replaced them
 *      wholesale. Verified against both engines:
 *        merge:  '{"env":{"A":1,"B":2}}' merged with '{"env":{"A":9}}'
 *                  -> {"env":{"A":9}}
 *        patch:  json_patch(same)
 *                  -> {"env":{"A":9,"B":2}}
 *      `setMetadataField(id, "env", {...})` rewrites the whole env map, so
 *      under json_patch a DELETED env binding would survive the write. The
 *      caller would report success and the secret would still resolve.
 *   2. It treats a null value as a DELETE instruction, where the old merge
 *      stored null as a value. `{"n":"x"}` patched with `{"n":null}` loses the key entirely.
 *
 * `json_set` has neither behaviour: it assigns each path independently, so
 * nested objects are replaced and explicit nulls are stored. Each value goes
 * through `json(?)` — without it SQLite stores the serialised text as a JSON
 * STRING (`"env": "{\\"A\\":9}"`), which is the same class of double-encoding
 * bug the previous version's double-cast comment describes.
 *
 * An empty `updates` yields a no-op expression rather than a malformed
 * `json_set(metadata)` with no path arguments.
 */
function mergeMetadataExpr(
  column: "metadata" | "settings",
  updates: Record<string, unknown>,
): RawBuilder<string> {
  const col = sql.ref(column);
  // `undefined` removes a key and `null` stores one, as everywhere else in
  // this store. Writing `undefined` as JSON null broke the identity: the merge
  // of an inheriting identity hands back `vault: undefined` (a vault is never
  // inherited), and a null vault fails every config read.
  const set = Object.keys(updates).filter((key) => updates[key] !== undefined);
  const removed = Object.keys(updates).filter((key) => updates[key] === undefined);
  // Typed as the column's own type (TEXT) rather than `unknown`: the column
  // holds JSON text either way, and an `unknown` expression will not assign to
  // a typed `.set()`.
  let expression = sql<string>`${col}`;
  // Keys are bound as parameters inside the path string rather than
  // interpolated, so a key containing a quote cannot break out of the path.
  if (set.length > 0) {
    const assignments = set.map((key) => sql`${"$." + key}, json(${JSON.stringify(updates[key])})`);
    expression = sql<string>`json_set(${expression}, ${sql.join(assignments, sql`, `)})`;
  }
  if (removed.length > 0) {
    expression = sql<string>`json_remove(${expression}, ${sql.join(removed.map((key) => sql`${"$." + key}`), sql`, `)})`;
  }
  return expression;
}

/**
 * Refuse a row write that `identity.yaml` would silently undo.
 *
 * For an identity with a directory, FILE_OWNED_FIELDS live in the file and the
 * row caches them; the next file-to-row sync overwrites whatever was written
 * here, after the caller has already reported success. Throwing turns that
 * silent revert into an error at the call site that made it. Use
 * `Identities.update`, which writes to whichever store owns the identity.
 */
async function assertRowOwnsFields(id: number, keys: string[]): Promise<void> {
  const fileOwned = keys.filter((key) => (FILE_OWNED_FIELDS as readonly string[]).includes(key));
  if (fileOwned.length === 0) return;
  const identity = await getIdentity(id);
  if (!identity) return;
  const dir = findIdentityDirectoryByName(identity.name);
  if (!dir) return;
  throw new Error(
    `Identity "${identity.name}" keeps ${fileOwned.join(", ")} in ${dir}/identity.yaml; ` +
      `a DB-row write would be reverted by the next sync. Write it with Identities.update.`,
  );
}

/** Guarded: see assertRowOwnsFields. */
export async function updateIdentityMetadata(
  id: number,
  updates: Partial<IdentityMetadata>,
): Promise<IdentityRecord | undefined> {
  await assertRowOwnsFields(id, Object.keys(updates));
  return updateIdentityMetadataInRow(id, updates);
}

/** Guarded: see assertRowOwnsFields. */
export async function setIdentityMetadataField(id: number, key: string, value: unknown): Promise<void> {
  await assertRowOwnsFields(id, [key]);
  await setIdentityMetadataFieldInRow(id, key, value);
}

/**
 * Write the row, unconditionally. For the file-to-row sync and for DB-only
 * identities — everything else goes through `Identities.update`.
 */
export async function updateIdentityMetadataInRow(
  id: number,
  updates: Partial<IdentityMetadata>,
): Promise<IdentityRecord | undefined> {
  const result = await db()
    .updateTable("identities")
    .set({ metadata: mergeMetadataExpr("metadata", updates) })
    .where("id", "=", id)
    .executeTakeFirst();

  // No row matched — nothing changed, so there is nothing to announce.
  if (Number(result.numUpdatedRows ?? 0n) === 0) return undefined;

  return getIdentity(id);
}

/** Unguarded row write — see updateIdentityMetadataInRow. */
export async function setIdentityMetadataFieldInRow(
  id: number,
  key: string,
  value: unknown,
): Promise<void> {
  if (value === undefined) {
    await db()
      .updateTable("identities")
      // `json_remove` replaces the previous key-delete operator. Both delete
      // the key outright, and both are no-ops when it is absent.
      .set({ metadata: sql`json_remove(metadata, ${"$." + key})` })
      .where("id", "=", id)
      .executeTakeFirst();
  } else {
    await db()
      .updateTable("identities")
      // Shallow-replaces this one key. See mergeMetadataExpr for why this is
      // json_set and not json_patch — the difference decides whether deleting
      // an env binding actually deletes it.
      .set({ metadata: mergeMetadataExpr("metadata", { [key]: value }) })
      .where("id", "=", id)
      .executeTakeFirst();
  }
}

export async function touchIdentityLastUsed(id: number): Promise<void> {
  await db()
    .updateTable("identities")
    // ISO text, not a Date: better-sqlite3 rejects a Date bind. Written in the
    // same strict ISO-8601 shape the migrated rows carry, so the two
    // generations of row sort together and `toIsoText` round-trips both.
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", id)
    .execute();

}

export type { ResolvedIdentityConfig } from "@barry-rocks/sdk/internal/identities";
import { resolveIdentityConfig as normalizeIdentity, type ResolvedIdentityConfig } from "@barry-rocks/sdk/internal/identities";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("identities.store", { transport: "stderr" });


/** Normalize effective metadata after ancestry resolution; defaults are applied in one place. */
export function resolveIdentityConfig(barry: IdentityRecord): ResolvedIdentityConfig { return normalizeIdentity(barry.metadata); }

export const Identities = {
  get: getIdentity,
  getByName: getIdentityByName,
  list: listIdentities,
  listAll: listAllIdentities,
  findByGitHubInstallation: findIdentityByGitHubInstallation,
  create: createIdentity,
  claimDefaultIfUnset: claimDefaultIdentityIfUnset,
  delete: deleteIdentity,
  rename: renameIdentity,
  /** Change config where the identity lives: identity.yaml, or the row. */
  update: updateIdentity,
  updateMetadata: updateIdentityMetadata,
  setMetadataField: setIdentityMetadataField,
  touchLastUsed: touchIdentityLastUsed,
  parseMetadata: parseIdentityMetadata,
  resolveConfig: resolveIdentityConfig,
};
