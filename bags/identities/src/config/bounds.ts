import { getIdentitiesDb } from "../store/identities-db.js";
import { generateBoundToken } from "../tokens.js";
import { BoundSchema, type Bound } from "@barry-rocks/sdk/bounds";
import { sql } from "kysely";

/**
 * Bounds live in the identities store, with the traits that carry them.
 *
 * Read through a function rather than a module-level `const`: the store is
 * lazy, and binding the client at import time would create the database file
 * in every process that merely imports this package.
 */
const db = () => getIdentitiesDb();

export interface BoundRecord {
  id: number;
  token: string;
  name: string;
  description: string | null;
  bound: Bound;
  bag?: string;
}

/**
 * A bound the schema refuses is never stored. Every door writes through here:
 * the API, config import, and bag registration. A bound that does not parse
 * could read as a restriction and restrict nothing.
 */
export class InvalidBoundError extends Error {
  constructor(readonly boundName: string, readonly reason: string) {
    super(`bound ${boundName} is invalid: ${reason}`);
    this.name = "InvalidBoundError";
  }
}

function validBound(name: string, bound: unknown): Bound {
  const result = BoundSchema.safeParse(bound);
  if (result.success) return result.data;
  throw new InvalidBoundError(name, result.error.issues.map((issue) => `${issue.path.join(".") || "bound"}: ${issue.message}`).join("; "));
}

function parseBound(name: string, raw: unknown): Bound {
  if (!raw) return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    // A row that does not even parse as JSON is a refusal, not an empty bound:
    // "no restriction" and "a restriction we failed to read" must not look alike.
    try { value = JSON.parse(raw); }
    catch (error) { throw new InvalidBoundError(name, `stored row is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // Re-validate on read through the same schema the write side enforces, so a
  // row written under an older schema refuses here rather than drifting into
  // "no restriction" that doctor cannot see.
  return validBound(name, value);
}

function rowToBound(row: { id: number; token: string; name: string; description: string | null; bound: unknown; metadata?: unknown }): BoundRecord {
  const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    description: row.description,
    bound: parseBound(row.name, row.bound),
    ...(metadata && typeof metadata === "object" && "bag" in metadata && typeof metadata.bag === "string" ? { bag: metadata.bag } : {}),
  };
}

export async function listBounds(): Promise<BoundRecord[]> {
  const rows = await db().selectFrom("bounds").selectAll().orderBy("name", "asc").execute();
  return rows.map(rowToBound);
}

export async function getBoundById(id: number): Promise<BoundRecord | undefined> {
  const row = await db()
    .selectFrom("bounds")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? rowToBound(row) : undefined;
}

export async function getBoundByName(name: string): Promise<BoundRecord | undefined> {
  const row = await db()
    .selectFrom("bounds")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? rowToBound(row) : undefined;
}

export async function createBound(data: {
  name: string;
  description?: string | null;
  bound: Bound;
}): Promise<BoundRecord> {
  const bound = validBound(data.name, data.bound);
  const token = generateBoundToken();
  const result = await db()
    .insertInto("bounds")
    .values({
      token,
      name: data.name,
      description: data.description ?? null,
      // Stringified here, not handed over as an object: SQLite columns hold
      // TEXT. The previous driver serialized JSON columns for us, better-sqlite3
      // rejects an object outright — which is the good failure, since the
      // alternative driver behaviour is storing "[object Object]".
      bound: JSON.stringify(bound),
      metadata: "{}",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const record = await getBoundById(result.id);
  if (!record) throw new Error(`Failed to create bound ${data.name}`);
  return record;
}

/**
 * Insert or update a bound by name. Used by config import to restore
 * user-defined bounds from the config directory.
 */
export async function upsertBound(data: {
  name: string;
  description?: string | null;
  bound: Bound;
  bag?: string;
}): Promise<void> {
  const bound = validBound(data.name, data.bound);
  if (data.bag) await assertBoundOwnership([data]);
  await db()
    .insertInto("bounds")
    .values({
      token: generateBoundToken(),
      name: data.name,
      description: data.description ?? null,
      bound: JSON.stringify(bound),
      metadata: JSON.stringify(data.bag ? { bag: data.bag } : {}),
    })
    .onConflict((oc) =>
      oc.column("name").doUpdateSet({
        description: data.description ?? null,
        bound: JSON.stringify(bound),
        ...(data.bag ? { metadata: sql`json_patch(coalesce(bounds.metadata, '{}'), ${JSON.stringify({ bag: data.bag })})` } : {}),
      }),
    )
    .execute();
}

/** Refuse ambiguous aliases before publishing any declarations from a batch. */
export async function assertBoundOwnership(inputs: readonly { name: string; bag?: string }[]): Promise<void> {
  const owners = new Map((await listBounds()).map((bound) => [bound.name, bound.bag]));
  for (const input of inputs) {
    if (!input.bag) continue;
    const owner = owners.get(input.name);
    if (owner && owner !== input.bag) throw new Error(`bound ${input.name} is already owned by bag ${owner}`);
    owners.set(input.name, input.bag);
  }
}

export const Bounds = {
  assertOwnership: assertBoundOwnership,
  list: listBounds,
  getById: getBoundById,
  getByName: getBoundByName,
  create: createBound,
  upsertBound,
};
