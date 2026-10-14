/**
 * Actions a session defined for itself with `create_action`.
 *
 * Each belongs to the session that created it, and only that session can see
 * or run it: the store is keyed by owner, and there is no read that is not.
 * A definition is stored as the fields the session gave, and validated again
 * on every read, so a row written under an older, looser allowlist cannot run
 * under the current one.
 */

import { formatAdhocRef, validateAdhocAction, adhocActionMeta, type AdhocActionMeta } from "@barry-rocks/sdk/internal/actions";

import { getDb } from "./db.js";

import { randomUUID } from "node:crypto";
import { createArtifact } from "@barry-rocks/artifacts-bag";

interface AdhocActionRow {
  owner_session_id: string;
  name: string;
  dir: string;
  definition: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SaveAdhocActionInput {
  ownerSessionId: string;
  /** Where the owner session is working; a run of the action starts here. */
  dir: string;
  /** The action.yaml fields as the session gave them. */
  definition: Record<string, unknown>;
}

export interface SaveAdhocActionResult {
  action: AdhocActionMeta;
  replaced: boolean;
  revision: number;
  outboxId: string;
  artifactId?: string;
}

/**
 * Validate and save an ad-hoc action, replacing one of the same name.
 *
 * Replacing is safe while a run of the old definition is in flight, because
 * a run snapshots the definition it started with.
 *
 * On create or replacement, captures the action definition as a durable deliverable
 * artifact via the programmatic artifact API, tracked by a durable outbox record.
 */
export async function saveAdhocAction(
  input: SaveAdhocActionInput,
): Promise<SaveAdhocActionResult> {
  const manifest = validateAdhocAction(input.definition, "definition");
  const now = new Date().toISOString();
  const db = getDb();

  const outboxId = randomUUID();
  const { replaced, revision } = db.transaction(() => {
    const existing = db
      .prepare("SELECT revision FROM adhoc_actions WHERE owner_session_id = ? AND name = ?")
      .get(input.ownerSessionId, manifest.name) as { revision?: number } | undefined;
    const nextRev = (existing?.revision ?? 0) + 1;
    db.prepare(
      `INSERT INTO adhoc_actions (owner_session_id, name, dir, definition, revision, created_at, updated_at)
       VALUES (@owner, @name, @dir, @definition, @revision, @now, @now)
       ON CONFLICT (owner_session_id, name)
       DO UPDATE SET dir = @dir, definition = @definition, revision = @revision, updated_at = @now`,
    ).run({
      owner: input.ownerSessionId,
      name: manifest.name,
      dir: input.dir,
      definition: JSON.stringify(input.definition),
      revision: nextRev,
      now,
    });

    db.prepare(
      `INSERT INTO adhoc_action_outbox (id, owner_session_id, name, revision, definition, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(outboxId, input.ownerSessionId, manifest.name, nextRev, JSON.stringify(input.definition, null, 2), now, now);

    return { replaced: existing !== undefined, revision: nextRev };
  })();

  const idempotencyKey = `adhoc-action:${input.ownerSessionId}:${manifest.name}:${revision}`;
  const definitionText = JSON.stringify(input.definition, null, 2);
  const textBytes = Buffer.from(definitionText, "utf-8");

  async function* toAsyncStream(bytes: Uint8Array) {
    yield bytes;
  }

  let artifactId: string | undefined;
  try {
    const record = await createArtifact(
      {
        filename: `${manifest.name}.json`,
        mimeType: "application/json",
        kind: "code",
        title: `Action: ${manifest.name} (rev ${revision})`,
        tags: ["action", "adhoc", manifest.name],
        idempotencyKey,
      },
      toAsyncStream(textBytes),
    );
    artifactId = record.id;
    db.prepare(
      `UPDATE adhoc_action_outbox SET status = 'captured', artifact_id = ?, updated_at = ? WHERE id = ?`,
    ).run(record.id, new Date().toISOString(), outboxId);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE adhoc_action_outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
    ).run(errorMessage, new Date().toISOString(), outboxId);
  }

  return {
    action: adhocActionMeta(manifest, { sessionId: input.ownerSessionId, dir: input.dir }),
    replaced,
    revision,
    outboxId,
    ...(artifactId ? { artifactId } : {}),
  };
}

function toMeta(row: AdhocActionRow): AdhocActionMeta {
  const manifest = validateAdhocAction(
    JSON.parse(row.definition),
    formatAdhocRef(row.name, row.owner_session_id),
  );
  return adhocActionMeta(manifest, { sessionId: row.owner_session_id, dir: row.dir });
}

/**
 * The owner's ad-hoc action of this name, or null when it has none.
 *
 * Throws when the stored definition no longer validates. That is a
 * definition the session must re-create, which is a different fact from one
 * that was never there.
 */
export async function getAdhocAction(ownerSessionId: string, name: string): Promise<AdhocActionMeta | null> {
  const row = getDb()
    .prepare("SELECT * FROM adhoc_actions WHERE owner_session_id = ? AND name = ?")
    .get(ownerSessionId, name) as AdhocActionRow | undefined;
  return row ? toMeta(row) : null;
}

/**
 * Every ad-hoc action the owner has, oldest first. One that no longer
 * validates is left out rather than hiding the rest; running it by name
 * still reports why.
 */
export async function listAdhocActions(ownerSessionId: string): Promise<AdhocActionMeta[]> {
  const rows = getDb()
    .prepare("SELECT * FROM adhoc_actions WHERE owner_session_id = ? ORDER BY created_at")
    .all(ownerSessionId) as AdhocActionRow[];
  const actions: AdhocActionMeta[] = [];
  for (const row of rows) {
    try {
      actions.push(toMeta(row));
    } catch {
      continue;
    }
  }
  return actions;
}

export async function flushAdhocActionOutbox(database?: import("./db.js").ActionsDb): Promise<{ processed: number; failures: number }> {
  const db = database ?? getDb();
  const pending = db
    .prepare("SELECT * FROM adhoc_action_outbox WHERE status != 'captured' ORDER BY created_at ASC LIMIT 50")
    .all() as Array<{
      id: string;
      owner_session_id: string;
      name: string;
      revision: number;
      definition: string;
    }>;
  let processed = 0;
  let failures = 0;
  for (const item of pending) {
    const idempotencyKey = `adhoc-action:${item.owner_session_id}:${item.name}:${item.revision}`;
    const textBytes = Buffer.from(item.definition, "utf-8");
    async function* toAsyncStream(bytes: Uint8Array) {
      yield bytes;
    }
    try {
      const record = await createArtifact(
        {
          filename: `${item.name}.json`,
          mimeType: "application/json",
          kind: "code",
          title: `Action: ${item.name} (rev ${item.revision})`,
          tags: ["action", "adhoc", item.name],
          idempotencyKey,
        },
        toAsyncStream(textBytes),
      );
      db.prepare(
        `UPDATE adhoc_action_outbox SET status = 'captured', artifact_id = ?, error = NULL, updated_at = ? WHERE id = ?`,
      ).run(record.id, new Date().toISOString(), item.id);
      processed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      db.prepare(
        `UPDATE adhoc_action_outbox SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      ).run(errorMessage, new Date().toISOString(), item.id);
      failures++;
    }
  }
  return { processed, failures };
}

export const AdhocActions = {
  save: saveAdhocAction,
  get: getAdhocAction,
  list: listAdhocActions,
  flushOutbox: flushAdhocActionOutbox,
};

