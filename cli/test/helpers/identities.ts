/**
 * Identity fixtures on the real identities store each test file's scratch
 * BARRY_HOME pins (see test/setup.ts): the installation's owner, directory
 * identities made through the operation every door uses, and raw rows for a
 * test about an identity with no directory, which the operations can read and
 * remove but never create.
 */
import { Barry, type IdentityCreate } from "@barry-rocks/sdk";
import { identityRecords, owner, type IdentityEntry } from "@barry-rocks/identities-bag";
import { identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { randomUUID } from "node:crypto";

/** The installation's owner, the user an owner caller acts for; provisioned once, then returned. */
export function provisionOwner(username = "fixture owner"): number {
  return owner.installation().provision({ username }).actorId;
}

/**
 * A directory identity, made as `barry identity create` makes one: through
 * `Barry`, so the test installs the identities subject first, as the CLI does.
 */
export async function createIdentity(input: IdentityCreate): Promise<IdentityEntry> {
  await Barry.createIdentity(input);
  return identityRecords.find(input.name);
}

export interface SeededIdentityRow {
  id: number;
  token: string;
  actor_id: number;
  name: string;
}

/** A row with no directory, written as the store writes one (metadata as JSON). */
export function seedIdentityRow(row: { actorId: number; name: string; metadata?: Record<string, unknown>; id?: number }): SeededIdentityRow {
  const token = `fixture-identity-${randomUUID()}`;
  const metadata = JSON.stringify(row.metadata ?? {});
  const inserted = identitiesSqlite()
    .prepare("INSERT INTO identities (id, token, actor_id, name, metadata) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .get(row.id ?? null, token, row.actorId, row.name, metadata) as { id: number };
  return { id: inserted.id, token, actor_id: row.actorId, name: row.name };
}

/** Rename a row in place, as a rename elsewhere would leave it. */
export function renameIdentityRow(id: number, name: string): void {
  identitiesSqlite().prepare("UPDATE identities SET name = ? WHERE id = ?").run(name, id);
}
