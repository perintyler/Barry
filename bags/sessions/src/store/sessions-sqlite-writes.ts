import {classify} from "../process-liveness.js";
import { persistInThread } from "./threaded-persist.js";
import { forgetSessionIdentity } from "@barry-rocks/sdk/stores";
/**
 * Session writes against the SQLite store.
 *
 * Three rules shape every function here:
 *
 * 1. **JSON columns are serialised by hand.** better-sqlite3 refuses an
 *    object outright
 *    ("can only bind numbers, strings, bigints, buffers, and null"). Every
 *    `traits` / `bound` / `metadata` value therefore goes through
 *    `JSON.stringify` on the way in. Forgetting one is a runtime throw rather
 *    than a silent wrong value, which is the good failure mode.
 *
 * 2. **Timestamps are ISO-8601 text.** `new Date()` would bind as an object
 *    and throw; `Date.now()` would store a number that sorts fine but reads
 *    back as a number where every consumer expects a string. `nowIso()` is
 *    the single source of the format, matching the column defaults in
 *    ../../../migrations/sessions/001_baseline.sql.
 *
 * 3. **Booleans are 0/1.** SQLite has no boolean type.
 */

import { randomUUID } from "node:crypto";
import { persistOne, MODEL_AUTHORED } from "./messages.js";
import { resolveModelId } from "./models-registry.js";
import { getSessionsDb } from "./sessions-db.js";
import { getSessionsSqlite } from "./sessions-db.js";
import {
  assertInteractiveSession,
  retireWorkflowDestination,
  type RetiredWorkflowDestination,
} from "./workflow-ownership.js";
import { generateId } from "@barry-rocks/sdk/ids";
// `WsMessageInput` rather than `Parameters<typeof persistOne>[2]`: the
// derived form names a symbol `index.ts` does not re-export, so declaration
// emit fails with TS4078 ("using private name 'persistOne'") and the whole
// package stops producing .d.ts files. Same type, nameable from outside.
import type { WsMessageInput } from "./session-records.js";
// The budgets are shared with messages.ts deliberately: two TTL sweeps with
// different batch sizes would be two different retention policies.
import {
  TTL_DELETE_BATCH_SIZE,
  TTL_DELETE_MAX_BATCHES,
  TTL_DELETE_TIME_BUDGET_MS,
  defaultStatusForDelivery,
} from "./session-helpers.js";
import type {
  ClientMessageRecord,
  PromptDeliveryState,
  PromptEnqueueResult,
  PromptRecord,
} from "./session-records.js";
import { getSessionSqlite } from "./sessions-sqlite-reads.js";
// Namespaced for the prompt block: the delivery state machine reads back
// through the same functions the read side exposes, so a change to how a
// prompt's state is derived cannot apply to reads and not to writes.
import * as reads from "./sessions-sqlite-reads.js";
import {
  cleanSessionName,
  formatSessionName,
  parseMetadata,
  EMPTY_SESSION_IDLE_MS,
} from "./session-helpers.js";
import type { Bound } from "@barry-rocks/sdk";
import type { SessionMetadata, SessionRecord } from "./session-records.js";

/**
 * The timestamp format the store uses everywhere.
 *
 * Matches `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in the baseline schema, which
 * matters because the session list pages by comparing these as STRINGS -- a
 * value in any other shape sorts into the wrong page rather than erroring.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/** Bind a Date, an ISO string, or null uniformly. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** JSON columns are TEXT here; an object binding throws in better-sqlite3. */
function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function createSessionSqlite(data: {
  id: string;
  active?: boolean;
  state?: SessionRecord["state"];
  agent_token: string | null;
  user_id?: number | null;
  identity_id?: number | null;
  status?: SessionRecord["status"];
  system_prompt?: string | null;
  bags?: string[];
  bounds?: Array<string | Bound | Record<string, unknown>>;
  bound?: Bound | Record<string, unknown> | null;
  metadata: SessionMetadata;
}): void {
  forgetSessionIdentity(data.id);
  getSessionsSqlite()
    .prepare(
      `INSERT INTO sessions (
         id, active, state, agent_token, user_id, identity_id, status,
         system_prompt, summary, bags, bound, bounds, metadata, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      data.id,
      (data.active ?? true) ? 1 : 0,
      data.state ?? "open",
      data.agent_token,
      data.user_id ?? null,
      data.identity_id ?? null,
      data.status ?? "pending",
      data.system_prompt ?? null,
      null,
      toJson(data.bags ?? []),
      toJson(data.bound ?? null),
      toJson(data.bounds ?? []),
      toJson(data.metadata),
      nowIso(),
    );
}

/**
 * Patch a session, returning the row as it now stands.
 *
 * Builds the SET list from only the keys actually supplied: passing
 * `undefined` for a column must leave it alone, not null it. An empty patch
 * is a read, not a no-op write.
 *
 * The `completed_at` rule is deliberate -- moving to a terminal
 * status stamps a completion time unless the caller supplied one. Dropping it
 * here would leave SQLite-era sessions with a status of "completed" and no
 * completion time, which reads as a session that never finished.
 */
export function updateSessionSqlite(
  id: string,
  updates: {
    status?: SessionRecord["status"];
    state?: SessionRecord["state"];
    summary?: string;
    system_prompt?: string;
    identity_id?: number | null;
    bags?: string[];
    bounds?: Array<string | Bound | Record<string, unknown>>;
    bound?: Bound | Record<string, unknown> | null;
    started_at?: Date | string | null;
    completed_at?: Date | string | null;
    active?: boolean;
    ended_at?: Date | string | null;
    metadata?: Record<string, unknown>;
  },
): SessionRecord | undefined {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, id);
      const columns: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        columns.push(`${column} = ?`);
        params.push(value);
      };

      if (updates.status !== undefined) {
        set("status", updates.status);
        const terminal =
          updates.status === "completed" ||
          updates.status === "failed" ||
          updates.status === "cancelled";
        if (updates.completed_at === undefined && terminal) set("completed_at", nowIso());
      }
      if (updates.state !== undefined) set("state", updates.state);
      if (updates.summary !== undefined) set("summary", updates.summary);
      if (updates.system_prompt !== undefined) set("system_prompt", updates.system_prompt);
      if (updates.identity_id !== undefined) set("identity_id", updates.identity_id);
      if (updates.bags !== undefined) {
        set("bags", toJson(updates.bags));
      }
      if (updates.bounds !== undefined) set("bounds", toJson(updates.bounds));
      if (updates.bound !== undefined) set("bound", toJson(updates.bound));
      if (updates.started_at !== undefined) set("started_at", toIso(updates.started_at));
      if (updates.completed_at !== undefined) set("completed_at", toIso(updates.completed_at));
      if (updates.active !== undefined) set("active", updates.active ? 1 : 0);
      if (updates.ended_at !== undefined) set("ended_at", toIso(updates.ended_at));
      if (updates.metadata !== undefined) {
        const formatted = { ...updates.metadata };
        if (typeof formatted.name === "string") formatted.name = cleanSessionName(formatted.name);
        set("metadata", toJson(formatted));
      }

      if (columns.length === 0) return getSessionSqlite(id);

      getSessionsSqlite()
        .prepare(`UPDATE sessions SET ${columns.join(", ")} WHERE id = ?`)
        .run(...params, id);
      return getSessionSqlite(id);
    })
    .immediate();
}

/**
 * MERGE new keys into `metadata`, leaving the rest intact.
 *
 * It uses `json_patch`, which REMOVES a key whose new value is null rather
 * than setting it to JSON null. Callers here only ever add or overwrite keys, so the
 * distinction does not currently bite -- but a caller that starts clearing a
 * key by writing null would see it vanish rather than become null.
 *
 * Done in SQL rather than read-modify-write in JS so a concurrent update to a
 * different key is not silently overwritten by a stale copy.
 */
export function updateSessionMetadataSqlite(id: string, updates: Record<string, unknown>): void {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, id);
      getSessionsSqlite()
        .prepare("UPDATE sessions SET metadata = json_patch(metadata, ?) WHERE id = ?")
        .run(JSON.stringify(updates), id);
    })
    .immediate();
}

/**
 * As above, but normalises a supplied `name` and returns the updated row.
 *
 * Was `updatePlannedSessionMetadataSqlite`. The two differ in normalisation and
 * return value, not in what KIND of session they touch — both write the same
 * `sessions.metadata` column on the same table.
 */
export function updateSessionMetadataNormalizedSqlite(
  id: string,
  metadata: Record<string, unknown>,
): SessionRecord | undefined {
  const formatted = { ...metadata };
  if (typeof formatted.name === "string") formatted.name = cleanSessionName(formatted.name);
  updateSessionMetadataSqlite(id, formatted);
  return getSessionSqlite(id);
}

export function issueWorkflowCredentialSqlite(
  id: string,
  expected: { actorId: number; identityId: number; boundFingerprint: string },
): string | null {
  const fingerprint = expected.boundFingerprint;
  if (!fingerprint) return null;
  const credentialId = randomUUID();
  const workflowDb = getSessionsSqlite();
  // Compare and rotate under the same write lock; concurrent starts cannot share authority.
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, id);
      const issued = workflowDb
        .prepare(
          `
    UPDATE sessions SET workflow_credential_id = ?
    WHERE id = ? AND user_id = ? AND identity_id = ?
      AND state = 'open' AND ended_at IS NULL
      AND json_extract(metadata, '$.workflow_identity_id') = ?
      AND json_extract(metadata, '$.workflow_bound.fingerprint') = ?
    RETURNING workflow_credential_id
  `,
        )
        .get(
          credentialId,
          id,
          expected.actorId,
          expected.identityId,
          expected.identityId,
          fingerprint,
        );
      return issued ? credentialId : null;
    })
    .immediate();
}

/**
 * Close a session.
 *
 * `status` is NOT simply set to closed. An ended session must not keep a live
 * status -- left alone it stays wherever the last turn put it (usually
 * "pending"), so every consumer reading the column still sees it as live. But
 * a terminal status the caller already set carries the real outcome
 * (cancelled by a discard, failed by an error) and has to survive, hence the
 * CASE rather than an assignment.
 *
 * `completed_at` is COALESCEd for the same reason: a genuine completion time
 * must not be overwritten by the moment of closing.
 *
 * All of it in one statement, so a crash cannot leave `active = 0` without
 * `ended_at` -- exactly the half-closed state the reaper exists to clean up.
 */
export function endSessionSqlite(id: string, reason?: string | null): SessionRecord | undefined {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, id);
      const now = nowIso();
      const terminal =
        reason === "evicted"
          ? "'pending'"
          : "CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE 'completed' END";
      const completedAt = reason === "evicted" ? "NULL" : "COALESCE(completed_at, ?)";
      const sqlite = getSessionsSqlite();

      if (reason) {
        // The reason is MERGED into metadata, never assigned: an assignment would
        // drop the working directory, name and everything else the session holds.
        sqlite
          .prepare(
            `UPDATE sessions
           SET active = 0, state = 'closed', ended_at = ?,
               status = ${terminal},
               completed_at = ${completedAt},
               metadata = json_patch(metadata, ?)
           WHERE id = ?`,
          )
          .run(
            ...(reason === "evicted"
              ? [now, JSON.stringify({ end_reason: reason }), id]
              : [now, now, JSON.stringify({ end_reason: reason }), id]),
          );
      } else {
        sqlite
          .prepare(
            `UPDATE sessions
           SET active = 0, state = 'closed', ended_at = ?,
               status = ${terminal},
               completed_at = COALESCE(completed_at, ?)
           WHERE id = ?`,
          )
          .run(now, now, id);
      }
      return getSessionSqlite(id);
    })
    .immediate();
}

/**
 * Delete a session and everything hanging off it.
 *
 * Messages and provider_sessions go via ON DELETE CASCADE, which is a REAL
 * foreign key here -- but only because `PRAGMA foreign_keys=ON` is set per
 * connection in sessions-db.ts. Without it SQLite silently ignores the FK and
 * this leaves orphaned messages behind with no error.
 */
function deleteSessionTurnChildren(
  workflowDb: ReturnType<typeof getSessionsSqlite>,
  sessionId: string,
): void {
  if (
    !workflowDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_turns'")
      .get()
  )
    return;
  workflowDb.prepare("DELETE FROM session_execution_events WHERE session_id = ?").run(sessionId);
  workflowDb
    .prepare(
      "DELETE FROM session_interrupts WHERE turn_id IN (SELECT id FROM session_turns WHERE session_id = ?)",
    )
    .run(sessionId);
  workflowDb
    .prepare(
      "DELETE FROM session_resolution_receipts WHERE turn_id IN (SELECT id FROM session_turns WHERE session_id = ?)",
    )
    .run(sessionId);
  workflowDb
    .prepare(
      "DELETE FROM session_call_outcomes WHERE turn_id IN (SELECT id FROM session_turns WHERE session_id = ?)",
    )
    .run(sessionId);
  workflowDb
    .prepare(
      "DELETE FROM session_run_segments WHERE turn_id IN (SELECT id FROM session_turns WHERE session_id = ?)",
    )
    .run(sessionId);
  workflowDb.prepare("DELETE FROM session_turns WHERE session_id = ?").run(sessionId);
}

export function retireWorkflowSessionSqlite(id: string): RetiredWorkflowDestination {
  return retireWorkflowDestination(getSessionsSqlite(), id);
}

export function retireWorkflowSessionsByIdentitySqlite(
  identityId: number,
): RetiredWorkflowDestination[] {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction((): RetiredWorkflowDestination[] => {
      if (
        !workflowDb
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_workflow_destinations'",
          )
          .get()
      ) {
        return [];
      }
      const rows = workflowDb
        .prepare(
          `SELECT d.session_id FROM session_workflow_destinations d
       LEFT JOIN sessions s ON s.id = d.session_id
       WHERE d.identity_id = ? OR s.identity_id = ?
       ORDER BY d.session_id`,
        )
        .all(identityId, identityId) as { session_id: string }[];
      return rows.map((row) => retireWorkflowDestination(workflowDb, row.session_id));
    })
    .immediate();
}

export function deleteSessionSqlite(id: string): void {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, id);
      deleteSessionTurnChildren(workflowDb, id);
      getSessionsSqlite().prepare("DELETE FROM sessions WHERE id = ?").run(id);
      getSessionsSqlite();
    })
    .immediate();
}

/**
 * Every session belonging to an identity, deleted together.
 *
 * The baseline declares `identity_id` as a plain INTEGER with no REFERENCES
 * clause -- the omission is specific to that column, since `messages` in the
 * same file does cascade -- so nothing here happens automatically.
 *
 * Deleting them is deliberate: "Sessions are owned by their Barry... no
 * traits, no scope, no model, nothing to resume against." A dangling
 * identity_id is not harmless, it is a session that every reader silently
 * degrades on -- lost traits, lost bags, lost credentials, dropped network
 * bounds -- with no error anywhere.
 *
 * One statement, so it is one transaction: a partial fanout would leave some
 * sessions deleted and others dangling. `messages` and `provider_sessions`
 * follow via their own ON DELETE CASCADE, which works here only because
 * sessions-db.ts sets `PRAGMA foreign_keys=ON` per connection.
 */
export function deleteSessionsByIdentitySqlite(identityId: number): number {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      const sessions = workflowDb
        .prepare("SELECT id FROM sessions WHERE identity_id=?")
        .all(identityId) as { id: string }[];
      for (const session of sessions) assertInteractiveSession(workflowDb, session.id);
      for (const session of sessions) deleteSessionTurnChildren(workflowDb, session.id);
      return workflowDb.prepare("DELETE FROM sessions WHERE identity_id = ?").run(identityId)
        .changes;
    })
    .immediate();
}

/** One provider_sessions row, as stored. */
export interface ProviderSessionRow {
  id: number;
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  created_at: string;
  ended_at: string | null;
}

/**
 * Attach a provider session to a session, returning the stored row.
 *
 * Returns the row rather than void because callers use the generated `id`. Read back rather than constructed, so the
 * value reflects the column defaults instead of this function's idea of them.
 */
export function createProviderSessionSqlite(data: {
  session_id: string;
  provider: string;
  provider_session_id?: string | null;
}): ProviderSessionRow {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, data.session_id);
      const sqlite = getSessionsSqlite();
      sqlite.prepare("INSERT OR IGNORE INTO agent_adapters (id) VALUES (?)").run(data.provider);
      const result = sqlite
        .prepare(
          `INSERT INTO provider_sessions (session_id, provider, provider_session_id, created_at)
         VALUES (?,?,?,?)`,
        )
        .run(data.session_id, data.provider, data.provider_session_id ?? null, nowIso());

      return sqlite
        .prepare("SELECT * FROM provider_sessions WHERE id = ?")
        .get(result.lastInsertRowid) as ProviderSessionRow;
    })
    .immediate();
}

/** Mark a provider session ended, by the provider's own id. */
export function endProviderSessionByProviderIdSqlite(harnessSessionId: string): void {
  getSessionsSqlite()
    .prepare("UPDATE provider_sessions SET ended_at = ? WHERE provider_session_id = ? AND ended_at IS NULL")
    .run(nowIso(), harnessSessionId);
}

/**
 * Close sessions whose process has gone quiet. Returns how many were closed.
 *
 * TWO CUTOFFS, chosen per session by whether it ever produced a message, and
 * both are load-bearing: a session with messages is judged on its newest one
 * against `idleMs`, while a session with NONE is judged on `created_at`
 * against the much shorter EMPTY_SESSION_IDLE_MS -- it never started, rather
 * than paused. Collapsing them into one `COALESCE(last_message_at,
 * created_at)` comparison (which an earlier draft of this did) leaves every
 * never-started session "active" for a full day.
 *
 * `status` is only overwritten when it is NOT already terminal, so a session
 * that genuinely failed is not relabelled "completed" on its way out. And
 * `completed_at` is COALESCEd rather than assigned, so a real completion time
 * is not replaced by the reaper's clock.
 */
export function markCrashedSessionsSqlite(
  idleMs = 24 * 60 * 60 * 1000,
  excludeIds: readonly string[] = [],
): number {
  const now = nowIso();
  const cutoff = new Date(Date.now() - idleMs).toISOString();
  // Never longer than the caller's own threshold: a small `idleMs` (tests
  // pass one) must not make the empty-session rule the LOOSER of the two.
  const emptyCutoff = new Date(Date.now() - Math.min(idleMs, EMPTY_SESSION_IDLE_MS)).toISOString();

  const exclusion =
    excludeIds.length > 0 ? ` AND id NOT IN (${excludeIds.map(() => "?").join(",")})` : "";

  const result = getSessionsSqlite()
    .prepare(
      `UPDATE sessions
       SET active = 0,
           state = 'closed',
           ended_at = ?,
           completed_at = COALESCE(completed_at, ?),
           status = CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE 'completed' END,
           metadata = json_patch(metadata, '{"end_reason":"crashed"}')
       WHERE active = 1
         AND NOT EXISTS (SELECT 1 FROM session_workflow_destinations d WHERE d.session_id=sessions.id)
         AND NOT EXISTS (SELECT 1 FROM session_turns t WHERE t.session_id=sessions.id AND (t.state IN ('running','waiting_for_input','recovery_required') OR t.owner IS NOT NULL))
         AND (
           (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = sessions.id) < ?
           OR (
             (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = sessions.id) IS NULL
             AND created_at < ?
           )
         )${exclusion}`,
    )
    .run(now, now, cutoff, emptyCutoff, ...excludeIds);
  return result.changes;
}

/**
 * Archive one session.
 */
export function archiveSessionSqlite(id: string): void {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, id);
      getSessionsSqlite().prepare("UPDATE sessions SET state = 'archived' WHERE id = ?").run(id);
    })
    .immediate();
}

/** Archive every closed session. Returns how many moved. */
export function archiveAllClosedSessionsSqlite(): number {
  const result = getSessionsSqlite()
    .prepare(
      "UPDATE sessions SET state = 'archived' WHERE state = 'closed' AND NOT EXISTS(SELECT 1 FROM session_workflow_destinations d WHERE d.session_id=sessions.id)",
    )
    .run();
  return result.changes;
}

/**
 * Create a session, deriving its display name from the system prompt.
 *
 * The two creators differ in exactly one respect, which is why they are not
 * one function with a flag: a PLANNED session derives a name from its system
 * prompt when none was given (`formatSessionName`, which title-cases and
 * strips punctuation), while a DRAFT leaves the name unset. Collapsing them
 * would mean drafts silently acquiring derived names.
 */
export function createNamedSessionSqlite(data: {
  user_id?: number;
  id: string;
  agent_token: string | null;
  system_prompt?: string;
  identity_id?: number | null;
  bags?: string[];
  bounds?: Array<string | Bound | Record<string, unknown>>;
  bound?: Bound | Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}): SessionRecord {
  const metadata = { ...(data.metadata ?? {}) };
  if (typeof metadata.name === "string" && metadata.name) {
    // An explicit name is kept verbatim (beyond normalisation).
    metadata.name = cleanSessionName(metadata.name);
  } else if (data.system_prompt) {
    metadata.name = formatSessionName(data.system_prompt);
  }
  return insertInactiveSession({ ...data, metadata });
}

/**
 * As above, but never derives a name from the system prompt.
 *
 * Was `createDraftSessionSqlite`. The old name described a session KIND that does
 * not exist — the row is an ordinary session that no agent has started yet. What
 * actually differs from `createSessionSqlite` is the one line below: an unnamed
 * row stays unnamed rather than being named after its prompt, because the caller
 * supplies the display name separately.
 */
export function createInertSessionSqlite(data: {
  user_id?: number;
  id: string;
  agent_token: string | null;
  system_prompt?: string;
  identity_id?: number | null;
  bags?: string[];
  bounds?: Array<string | Bound | Record<string, unknown>>;
  bound?: Bound | Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}): SessionRecord {
  const metadata = { ...(data.metadata ?? {}) };
  if (typeof metadata.name === "string" && metadata.name) {
    metadata.name = cleanSessionName(metadata.name);
  }
  return insertInactiveSession({ ...data, metadata });
}

/** The shared body of the two creators above. */
function insertInactiveSession(data: {
  user_id?: number;
  id: string;
  agent_token: string | null;
  system_prompt?: string;
  identity_id?: number | null;
  bags?: string[];
  bounds?: Array<string | Bound | Record<string, unknown>>;
  bound?: Bound | Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}): SessionRecord {
  if (data.user_id !== undefined && (!Number.isSafeInteger(data.user_id) || data.user_id <= 0))
    throw new Error("Session user must be a positive actor ID");
  getSessionsSqlite()
    .prepare(
      `INSERT INTO sessions (
         id, active, state, agent_token, user_id, identity_id, status,
         system_prompt, summary, bags, bound, bounds, metadata,
         created_at, started_at
       ) VALUES (?,0,'open',?,?,?,'pending',?,NULL,?,?,?,?,?,NULL)`,
    )
    .run(
      data.id,
      data.agent_token,
      data.user_id ?? null,
      data.identity_id ?? null,
      data.system_prompt ?? null,
      toJson(data.bags ?? []),
      toJson(data.bound ?? null),
      toJson(data.bounds ?? []),
      toJson(data.metadata),
      nowIso(),
    );

  forgetSessionIdentity(data.id);
  const session = getSessionSqlite(data.id);
  // Reading back rather than constructing the record: the row is the truth,
  // and a hand-built return value would drift from whatever the columns
  // actually defaulted to.
  if (!session) throw new Error(`failed to create session ${data.id}`);
  return session;
}

/**
 * The highest sequence a session has used, or -1 when it has none: the next
 * sequence is this plus one, so a session's first message lands on 0.
 */
export function maxMessageSequenceSqlite(sessionId: string): number {
  const row = getSessionsSqlite()
    .prepare("SELECT MAX(sequence) AS seq FROM messages WHERE session_id = ?")
    .get(sessionId) as { seq: number | null };
  return row.seq ?? -1;
}

/**
 * Append one WS message to its session and answer the sequence it was stored
 * under, or null when nothing was stored (a repeat of a captured row, a
 * result folded into its call, a type that is not kept). The sequence is
 * assigned by the insert itself, so every process that appends to a session
 * gets the next one in order; a caller advertising the message (a WebSocket
 * send) uses the returned value.
 *
 * Reuses `persistOne` from `messages.ts` rather than reimplementing the
 * seven-case protocol switch; `getSessionsDb()` carries `jsonColumnPlugin()`
 * so the object values it binds reach SQLite as JSON text. `model_id` comes
 * from `resolveModelId`, whose `models`/`providers` join is local to this
 * store (migration 003). Gating is on `message.type` via MODEL_AUTHORED, not
 * on `message.role`, because the system rows set their role inside
 * persistOne's switch.
 */
const modelIds = new Map<string, Promise<number | null>>();

export async function appendMessageSqlite(
  sessionId: string,
  message: WsMessageInput,
  harnessSessionId?: string | null,
  origin?: { provider?: string | null; model?: string | null; channel?: string | null },
): Promise<number | null> {
  const m = message as { type?: string; role?: string };
  const modelId = !MODEL_AUTHORED.has(m.type as string) || m.role === "user"
    ? null
    : await (()=>{
      const key=JSON.stringify([getSessionsSqlite().name,sessionId,origin?.provider,origin?.model]);
      let pending=modelIds.get(key);
      if (!pending) {
        if (modelIds.size>=10_000) modelIds.delete(modelIds.keys().next().value!);
        pending=resolveModelId(origin?.provider,origin?.model);modelIds.set(key,pending);
        void pending.catch(()=>{if(modelIds.get(key)===pending)modelIds.delete(key);});
      }
      return pending;
    })();
  if (origin?.channel==="engine" && message.dedupeKey?.startsWith("engine:")) {
    return persistInThread(getSessionsSqlite().name,sessionId,message,harnessSessionId,modelId);
  }
  return persistOne(getSessionsDb(), sessionId, message, harnessSessionId, modelId, origin?.channel ?? null);
}

/** Re-exported for callers that need to read metadata off a written row. */
export { parseMetadata };

/** Delete expired messages in bounded batches with a bounded overall sweep.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
export function deleteMessagesOlderThanSqlite(
  cutoff: Date,
  options: {
    batchSize?: number;
    maxBatches?: number;
    timeBudgetMs?: number;
    sessionIds?: string[];
  } = {},
): { deletedRows: number; batches: number; budgetExhausted: boolean } {
  const batchSize = options.batchSize ?? TTL_DELETE_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? TTL_DELETE_MAX_BATCHES;
  const timeBudgetMs = options.timeBudgetMs ?? TTL_DELETE_TIME_BUDGET_MS;
  const sessionIds = options.sessionIds;

  // ISO-8601 text, because `created_at` is TEXT here and the comparison is a
  // string comparison. A Date bound would throw in better-sqlite3 anyway.
  const cutoffIso = cutoff.toISOString();

  const scope = sessionIds ? ` AND session_id IN (${sessionIds.map(() => "?").join(",")})` : "";
  const statement = getSessionsSqlite().prepare(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages WHERE created_at < ?${scope} LIMIT ?
     )`,
  );

  const startedAt = Date.now();
  let deletedRows = 0;
  let batches = 0;
  let budgetExhausted = false;

  for (;;) {
    if (batches >= maxBatches) {
      budgetExhausted = true;
      break;
    }
    if (Date.now() - startedAt >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }

    const params = sessionIds ? [cutoffIso, ...sessionIds, batchSize] : [cutoffIso, batchSize];
    const batchDeleted = statement.run(...params).changes;
    deletedRows += batchDeleted;
    batches += 1;

    // Fewer rows than the batch size means this batch cleared everything that
    // currently matches -- no point looping again to find zero more.
    if (batchDeleted < batchSize) break;
  }

  return { deletedRows, batches, budgetExhausted };
}

/**
 * The prompt delivery state machine, against SQLite.
 *
 * See `sessions-sqlite-reads.ts`'s prompt block for what a prompt IS (a
 * `messages` row with a metadata envelope, not its own table) and why every
 * `clientMessageId` comparison is cast to TEXT.
 *
 * A merge and a key removal are ONE `json_patch(...)` call, with the removal
 * expressed as a null in the patch.
 *
 * `json_patch` implements RFC 7386 merge-patch, where a null VALUE deletes the
 * key rather than storing a JSON null. That is exactly what the old
 * key-removal operator did, so the two compose into one call instead of two
 * operators -- verified
 * against SQLite directly (`json_patch('{"a":1,"deliveryError":"x"}',
 * '{"deliveryError":null}')` returns `{"a":1}`), not assumed from the docs.
 *
 * Getting this wrong is silent: storing a literal null instead of removing
 * the key leaves `deliveryError` present-but-null, and a UI that renders "an
 * error occurred" on key presence would show a stale failure on a prompt that
 * has since been accepted.
 */

/**
 * `CAST(... AS TEXT)` for the same native-type reason the read side casts --
 * see the prompt block in `sessions-sqlite-reads.ts`. Duplicated rather than
 * exported across modules because it is a SQL fragment, not behaviour; the
 * two are pinned together by `prompts-sqlite.test.ts`.
 */
const PROMPT_CLIENT_ID_W = `CAST(json_extract(metadata, '$.clientMessageId') AS TEXT)`;

/** Clears `deliveryError` when a patch does not set one, mirroring `- 'deliveryError'`. */
function promptPatchJson(patch: Record<string, unknown>, clearError: boolean): string {
  return JSON.stringify(clearError ? { ...patch, deliveryError: null } : patch);
}

/**
 * Insert a prompt row, idempotent on `clientMessageId`.
 *
 * THE DOUBLE CHECK IS DELIBERATE. The pre-insert lookup answers the common case; the post-conflict
 * lookup answers the race where two requests carrying the same
 * `clientMessageId` both miss the first check and one loses the unique index
 * `idx_messages_session_client_message_id`. Collapsing it to one check turns a
 * concurrent double-submit into a thrown 500 on a request the user should see
 * succeed idempotently.
 *
 * `INSERT OR IGNORE` is the `onConflict().doNothing()` translation. No row
 * comes back from `RETURNING` when the index rejected it, which is how the
 * conflict is detected without parsing an error message.
 *
 * SEQUENCE ALLOCATION happens inside the INSERT, the way every message is
 * numbered (`appendMessage`): the session's highest plus one, read under the
 * write lock the statement holds. Read beforehand, a message another process
 * appended in between would already hold that number.
 *
 * THE COUNTER TRIGGERS FIRE HERE, and that is correct. A prompt IS a message
 * -- it is the user's turn in the transcript -- so `sessions.message_count`
 * must include it and `last_message_at` must advance. `messages_session_counters_insert`
 * (migration 002) does both, once, on this single INSERT. Nothing in this
 * module touches those columns itself, so there is no double count; and
 * because the insert is `OR IGNORE`, a conflicting duplicate inserts no row
 * and so fires no trigger -- the count does not drift on a retried submit.
 */
function insertPromptSqlite(
  sessionId: string,
  content: string,
  options: {
    sequence?: number;
    clientMessageId?: string;
    source: "web_prompt" | "api_message" | "session";
    delivery: PromptDeliveryState;
    status?: string;
    error?: string;
    /** The sending session, when source is "session". Attribution only. */
    fromSession?: string;
  },
): PromptEnqueueResult {
  const { clientMessageId, source, delivery, status, error, fromSession } = options;
  const residentRow=getSessionsSqlite().prepare("SELECT metadata FROM sessions WHERE id=?").get(sessionId) as {metadata:string}|undefined;
  const residentMetadata=residentRow?JSON.parse(residentRow.metadata??"{}"):{};
  const residentPid=residentMetadata.hosted_runtime_pid;
  if(typeof residentPid==="number" && residentPid!==process.pid && classify({pid:residentPid,pid_started_at:residentMetadata.hosted_runtime_started_at,hostname:residentMetadata.hosted_runtime_hostname}).state!=="dead") {
    throw new Error("Session has a resident owner; enqueue this prompt through the sessions API");
  }


  if (clientMessageId) {
    const existing = reads.getMessageByClientMessageIdSqlite(sessionId, clientMessageId);
    if (existing) {
      return {
        id: existing.id,
        sequence: existing.sequence,
        state: existing.state,
        duplicate: true,
      };
    }
  }

  const eventId = generateId();

  const metadata = {
    source,
    status: status ?? defaultStatusForDelivery(delivery),
    delivery,
    ...(error ? { deliveryError: error } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(fromSession ? { fromSession } : {}),
  };

  // The sequence is the session's next, taken inside the INSERT under the
  // write lock, as `appendMessage` takes it: read beforehand, a message
  // another process appended in between would hold it.
  const inserted = getSessionsSqlite()
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, session_id, type, sequence, role, content, content_text, metadata, created_at)
       VALUES (?, ?, 'message', COALESCE(?, (SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE session_id = ?)), 'user', ?, ?, ?, ?)
       RETURNING sequence`,
    )
    .get(
      eventId,
      sessionId,
      options.sequence ?? null,
      sessionId,
      JSON.stringify([{ type: "text", text: content }]),
      // `content_text` is denormalized on insert the way the persist path does
      // it: the search index and `getFirstUserMessagesSqlite` both read this
      // column, and a prompt that never populated it would be invisible to
      // session naming and to search.
      content,
      JSON.stringify(metadata),
      nowIso(),
    ) as { sequence: number } | undefined;

  if (!inserted) {
    if (clientMessageId) {
      const existing = reads.getMessageByClientMessageIdSqlite(sessionId, clientMessageId);
      if (existing) {
        return {
          id: existing.id,
          sequence: existing.sequence,
          state: existing.state,
          duplicate: true,
        };
      }
    }
    throw new Error("Prompt insert conflicted without a matching clientMessageId");
  }

  return { id: eventId, sequence: inserted.sequence, state: delivery, duplicate: false };
}

/** The worker's inbox insert shares one write transaction with sequence repair. */
export function queuePromptOrderedSqlite(sessionId:string,content:string,options:Parameters<typeof queuePromptSqlite>[2]={}):PromptEnqueueResult {
  const sqlite=getSessionsSqlite();
  return sqlite.transaction(()=>{
    const next=(sqlite.prepare("SELECT COALESCE(MAX(sequence),-1)+1 AS sequence FROM messages WHERE session_id=?").get(sessionId) as {sequence:number}).sequence;
    return queuePromptSqlite(sessionId,content,{...options,...(options.sequence!==undefined?{sequence:Math.max(options.sequence,next)}:{})});
  }).immediate();
}

/** Queue a prompt for delivery. Idempotent on `clientMessageId`. */
export function queuePromptSqlite(
  sessionId: string,
  content: string,
  options: {
    sequence?: number;
    clientMessageId?: string;
    /** "session" marks a prompt queued by another session's send_prompt tool. */
    source?: "web_prompt" | "session";
    fromSession?: string;
  } = {},
): PromptEnqueueResult {
  const workflowDb = getSessionsSqlite();
  return workflowDb
    .transaction(() => {
      assertInteractiveSession(workflowDb, sessionId);
      return insertPromptSqlite(sessionId, content, {
        sequence: options.sequence,
        clientMessageId: options.clientMessageId,
        source: options.source ?? "web_prompt",
        delivery: "queued",
        status: "pending",
        fromSession: options.fromSession,
      });
    })
    .immediate();
}

/**
 * Record a prompt whose delivery was attempted directly (not queued).
 *
 * Defaults to `source: 'api_message'`: this is the path the message route
 * takes when it hands a prompt straight to a live session, and the
 * `uncertain` state it writes before the attempt is what makes a crash
 * mid-delivery recoverable rather than invisible.
 */
export function recordPromptDeliverySqlite(
  sessionId: string,
  content: string,
  options: {
    sequence?: number;
    clientMessageId?: string;
    delivery: PromptDeliveryState;
    source?: "web_prompt" | "api_message";
    status?: string;
    error?: string;
  },
): PromptEnqueueResult {
  return insertPromptSqlite(sessionId, content, {
    sequence: options.sequence,
    clientMessageId: options.clientMessageId,
    source: options.source ?? "api_message",
    delivery: options.delivery,
    status: options.status,
    error: options.error,
  });
}

/**
 * Move a prompt to a new delivery state.
 *
 * `deliveryError` is cleared for `accepted` and `queued` and RETAINED for
 * `failed` / `uncertain`. A prompt that
 * succeeded on retry must not keep showing the error from the attempt before
 * it, while one still in a failure state must keep the reason it failed.
 */
export function updatePromptDeliveryByClientMessageIdSqlite(
  sessionId: string,
  clientMessageId: string,
  delivery: PromptDeliveryState,
  options: { status?: string; error?: string; source?: "web_prompt" | "api_message" } = {},
): ClientMessageRecord | null {
  const patch = {
    delivery,
    status: options.status ?? defaultStatusForDelivery(delivery),
    ...(options.source ? { source: options.source } : {}),
    ...(options.error ? { deliveryError: options.error } : {}),
  };
  const clearError = delivery === "accepted" || delivery === "queued";

  getSessionsSqlite()
    .prepare(
      `UPDATE messages
          SET metadata = json_patch(COALESCE(metadata, '{}'), json(?))
        WHERE session_id = ?
          AND ${PROMPT_CLIENT_ID_W} = ?`,
    )
    .run(promptPatchJson(patch, clearError), sessionId, clientMessageId);

  return reads.getMessageByClientMessageIdSqlite(sessionId, clientMessageId);
}

/**
 * Claim a failed prompt for retry, moving it to `uncertain`.
 *
 * ALL THREE PREDICATES ARE LOAD-BEARING, and this is the subtlest function
 * here. It is a compare-and-swap: only a prompt that is currently `failed`,
 * carries this `clientMessageId`, AND whose stored text matches the content
 * being retried may be claimed. Returning a row means THIS caller owns the
 * retry; returning null means it does not.
 *
 * Dropping the `delivery = 'failed'` check lets two concurrent retries both
 * claim the same prompt and deliver it twice. Dropping the content check lets
 * a client reuse a `clientMessageId` with different text and silently
 * overwrite what the user actually sent.
 *
 * `content->0->>'text'` becomes `json_extract(content, '$[0].text')`, cast to
 * TEXT for the same native-type reason as the id comparison.
 *
 * SQLite's `UPDATE ... RETURNING` (3.35+) gives the claim its atomicity: the
 * matched rows and the state change happen in one statement, so there is no
 * window between "found a failed prompt" and "marked it uncertain" for a
 * second caller to slip through.
 */
export function claimFailedPromptRetrySqlite(
  sessionId: string,
  clientMessageId: string,
  content: string,
): ClientMessageRecord | null {
  const rows = getSessionsSqlite()
    .prepare(
      `UPDATE messages
          SET metadata = json_patch(COALESCE(metadata, '{}'),
                                    json('{"delivery":"uncertain","status":"uncertain","deliveryError":null}'))
        WHERE session_id = ?
          AND ${PROMPT_CLIENT_ID_W} = ?
          AND json_extract(metadata, '$.delivery') = 'failed'
          AND CAST(json_extract(content, '$[0].text') AS TEXT) = ?
        RETURNING id, sequence`,
    )
    .all(sessionId, clientMessageId, content) as Array<{ id: string; sequence: number }>;

  const row = rows[0];
  return row ? { id: row.id, sequence: row.sequence, state: "uncertain", content } : null;
}

/**
 * Drain a session's pending prompts, marking them consumed.
 *
 * READ-THEN-UPDATE, and the returned rows are the ones
 * read BEFORE the update -- a caller gets the prompt text, not the post-drain
 * state. The `check_prompts` MCP tool's contract is that a prompt is removed
 * from the queue once retrieved, so a prompt returned here must never be
 * returned again.
 *
 * WRAPPED IN A TRANSACTION. better-sqlite3 runs both statements on one
 * synchronous connection, so nothing can interleave
 * between them in-process; the transaction makes that a property of the
 * statement pair rather than of the driver, and means a failure to mark
 * consumed cannot leave prompts returned-but-still-pending -- which would
 * deliver them to the agent twice.
 *
 * The drain sets `delivery: 'accepted'` alongside `status: 'consumed'` and
 * clears `deliveryError`: a prompt the agent has actually read has been
 * delivered by definition.
 */
export function popPromptsSqlite(sessionId: string): PromptRecord[] {
  const sqlite = getSessionsSqlite();
  const drain = sqlite.transaction((id: string): PromptRecord[] => {
    const prompts = reads
      .getPromptsSqlite(id)
      .map((p) => ({ ...p, session_id: p.session_id || id }));
    if (prompts.length === 0) return prompts;

    const ids = prompts.map((p) => p.id);
    sqlite
      .prepare(
        `UPDATE messages
            SET metadata = json_patch(COALESCE(metadata, '{}'),
                                      json('{"status":"consumed","delivery":"accepted","deliveryError":null}'))
          WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(...ids);
    return prompts;
  });
  return drain(sessionId);
}
