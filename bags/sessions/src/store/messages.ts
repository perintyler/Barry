/**
 * The message persistence core. The queries live in `sessions-sqlite-reads.ts`
 * and `sessions-sqlite-writes.ts`; what is here is not tied to any engine:
 *
 * 1. **`persistOne`** -- the seven-case switch over the WS protocol. It takes
 *    its executor as a parameter, and the SQLite write path hands it the
 *    sessions store's Kysely client (which carries `jsonColumnPlugin()`, so
 *    object values reach SQLite as JSON text). It is NOT copied there on
 *    purpose: the tool-call correlation state below is module-level, so a
 *    second implementation would get its own maps and a `tool_result`
 *    arriving through one path could never be claimed by a `tool_start`
 *    recorded through the other.
 *
 * 2. **The in-memory tool-call correlation state** -- `pendingToolCalls`,
 *    `orphanedToolResults`. Never in any database, bounded, and dropped for a
 *    session by `forgetSession`. Sequences are not here: the insert assigns
 *    each row its own (`nextSequence`).
 *
 * The pure row/text/name helpers live in `session-helpers.ts`, which imports
 * no store at all. They are re-exported from here so the existing import
 * sites keep working.
 *
 * `findPendingToolCallRow` uses `metadata->>'toolUseId'`, which looks
 * engine-specific but is standard SQL/JSON and has been supported by SQLite
 * since 3.38 (this store runs 3.53). Verified against the driver rather than
 * assumed, because a silent fallback here would mis-attach tool results.
 */

import { sql, type Kysely } from "kysely";
import { generateId } from "@barry-rocks/sdk/ids";
import type { SessionsStoreDatabase, SessionsStoreMessagesTable } from "./sessions-types.js";
import type { WsMessageInput } from "./session-records.js";

// Re-exported because `sessions-sqlite-*.ts` and several tests import them
// from here, and splitting a module should not be a breaking change for its
// callers.
export {
  extractTextFromContent,
  readDeliveryState,
  defaultStatusForDelivery,
  formatSessionHistory,
  collectHistoryEntries,
  rowToWireMessage,
  HISTORY_PAGE_SIZE,
  TTL_DELETE_BATCH_SIZE,
  TTL_DELETE_MAX_BATCHES,
  TTL_DELETE_TIME_BUDGET_MS,
} from "./session-helpers.js";
export type { HistoryEntry, HistoryRow } from "./session-helpers.js";


// Pending tool calls: sessionId -> (toolUseId -> eventId)
const pendingToolCalls = new Map<string, Map<string, string>>();

/**
 * Results that arrived before their `tool_call` row existed:
 * sessionId -> (toolUseId -> result text).
 *
 * A caller that appends without awaiting the previous append lets a fast
 * `tool_result` reach the `tool_result` case while its `tool_start` is still
 * awaiting model resolution or its INSERT. That result matched neither
 * the in-process pending map nor a committed row, and the old code simply
 * `break`ed — returning success while saving nothing, so the live client
 * showed a result that vanished on reload.
 *
 * Retaining it here lets the `tool_start` that lands moments later attach it
 * on insert. Bounded per session (`MAX_ORPHANED_RESULTS`) so a stream of
 * results whose calls never arrive cannot grow without limit, and dropped
 * with the rest of a session's correlation state by `forgetSession`.
 */
const orphanedToolResults = new Map<string, Map<string, string>>();

/** Per-session cap on retained unmatched results — see `orphanedToolResults`. */
const MAX_ORPHANED_RESULTS = 256;

/**
 * Per-session cap on calls still waiting for their result. A call evicted
 * past it is still found by its `toolUseId` in the store
 * (`findPendingToolCallRow`); only an untagged result loses its fallback.
 */
const MAX_PENDING_CALLS = 256;

/**
 * How many sessions keep correlation state. Most sessions end through a path
 * that calls `forgetSession`, but a process also writes for sessions it never
 * sees end (a hook-driven session's messages arrive at the API, its end does
 * not), so the least recently written session is dropped past this.
 */
const MAX_CORRELATED_SESSIONS = 1024;

/** Insert `key`, dropping the oldest entry when the map is full. Map order is insertion order. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (!map.has(key) && map.size >= cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** A session's correlation entry, created if absent and made the most recently written. */
function correlationOf(state: Map<string, Map<string, string>>, sessionId: string): Map<string, string> {
  const entry = state.get(sessionId) ?? new Map<string, string>();
  state.delete(sessionId);
  setBounded(state, sessionId, entry, MAX_CORRELATED_SESSIONS);
  return entry;
}

function retainOrphanedResult(sessionId: string, toolUseId: string, result: string): void {
  // Oldest-first eviction: the first key is the longest-waiting result and
  // the least likely to still find its call.
  setBounded(correlationOf(orphanedToolResults, sessionId), toolUseId, result, MAX_ORPHANED_RESULTS);
}

function takeOrphanedResult(sessionId: string, toolUseId: string | undefined): string | undefined {
  if (!toolUseId) return undefined;
  const orphans = orphanedToolResults.get(sessionId);
  if (!orphans) return undefined;
  const result = orphans.get(toolUseId);
  if (result === undefined) return undefined;
  orphans.delete(toolUseId);
  return result;
}


/**
 * Message types worth persisting.
 *
 * `shouldPersist` is a pure Set lookup -- `session-client` always calls it
 * directly rather than over the transport for exactly that reason.
 */
const PERSISTABLE_TYPES = new Set(["text", "tool_start", "tool_result", "error", "init", "result", "summary"]);

/**
 * Drop a session's correlation state: its calls still waiting for a result and
 * the results still waiting for their call. Called when a session ends or is
 * removed in this process. A result that arrives later still finds its call
 * row by `toolUseId` in the store.
 */
export function forgetSession(sessionId: string): void {
  pendingToolCalls.delete(sessionId);
  orphanedToolResults.delete(sessionId);
}

export function shouldPersist(messageType: string): boolean {
  return PERSISTABLE_TYPES.has(messageType);
}


/**
 * The subset of Kysely `persistOne` needs, over the SQLITE store's schema.
 *
 * The only caller is `sessions-sqlite-writes.ts`, which hands in
 * `getSessionsDb()`, a `Kysely<SessionsStoreDatabase>`.
 *
 * WHY THE JSON COLUMNS ARE WIDENED. `SessionsStoreMessagesTable` types
 * `content`, `metadata`, `input` and `result` as the TEXT they are AT REST,
 * which is correct for every reader. `persistOne` binds JS objects and arrays
 * to them and lets `jsonColumnPlugin()` (sessions-json-plugin.ts) serialise at
 * the driver boundary -- that indirection is deliberate, so one persist
 * implementation can serve both stores. The insert types are widened here,
 * at the one seam where objects are legal, rather than in the store's schema,
 * where it would tell every READER a parsed object might come back when only
 * text ever does.
 */
type JsonBindable = Omit<
  SessionsStoreMessagesTable,
  "content" | "metadata" | "input" | "result"
> & {
  content: unknown;
  metadata: unknown;
  input: unknown;
  result: unknown;
};

type MessageExecutor = Pick<
  Kysely<Omit<SessionsStoreDatabase, "messages"> & { messages: JsonBindable }>,
  "selectFrom" | "insertInto" | "updateTable"
>;

// Match metadata.toolUseId exactly; substring matching can attach a parent result to a child invocation.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-026
async function findPendingToolCallRow(
  exec: MessageExecutor,
  sessionId: string,
  toolUseId: string,
): Promise<{ id: string } | undefined> {
  return exec
    .selectFrom("messages")
    .select("id")
    .where("session_id", "=", sessionId)
    .where("type", "=", "tool_call")
    .where("result", "is", null)
    .where(sql<boolean>`messages.metadata->>'toolUseId' = ${toolUseId}`)
    .orderBy("sequence", "desc")
    .limit(1)
    .executeTakeFirst();
}

/**
 * Has this session already stored a row under this key?
 *
 * The question behind idempotent capture: a transcript reader that restarts,
 * or a backfill overlapping a live stream, presents rows that are already
 * there — and without this each pass inserts them again until the transcript
 * has silently doubled.
 */
/**
 * Has this session already stored a row under this dedupe key?
 *
 * Exported because a caller needs to distinguish "stored" from "already
 * there" for its COUNTERS, and `persistOne` returns void — it treats a repeat
 * as a no-op, which is right for the write and useless for reporting. A sweep
 * that counted every re-read as a write would look busy while doing nothing.
 */
export async function alreadyCaptured(
  exec: MessageExecutor,
  sessionId: string,
  dedupeKey: string,
): Promise<boolean> {
  const existing = await exec
    .selectFrom("messages")
    .select("id")
    .where("session_id", "=", sessionId)
    .where("dedupe_key", "=", dedupeKey)
    .limit(1)
    .executeTakeFirst();
  return existing !== undefined;
}

/**
 * Persist one WS-protocol message: the core of `appendMessageSqlite`, which
 * calls it with the sessions store's Kysely client and a pre-resolved model id.
 *
 * EXPORTED for the SQLite path (`sessions-sqlite-writes.ts`). Deliberately NOT
 * copied there: the tool-call correlation state below (`pendingToolCalls`,
 * `orphanedToolResults`) is module-level, so a second implementation would get
 * its own maps and a result arriving through one path could never be claimed
 * by a call recorded through the other.
 */
export async function persistOne(
  exec: MessageExecutor,
  sessionId: string,
  message: WsMessageInput,
  providerSessionId: string | null | undefined,
  modelId: number | null,
  /**
   * Which of the five capture routes produced this row.
   *
   * Optional because a caller that genuinely does not know must not invent
   * one: NULL reads as "unknown", which is true, while a defaulted value
   * would make "captured before provenance existed" indistinguishable from
   * "captured over the engine" — the exact confusion the column exists to
   * remove (migration 006).
   */
  channel?: string | null,
): Promise<number | null> {
  const eventId = generateId();
  // The insert takes the next sequence in the session itself, under the write
  // lock, so every process that appends to a session agrees on the order.
  const at = nextSequence(sessionId);
  // Recorded on every persisted row so subagent output stays distinguishable
  // from the main thread once it is in the transcript.
  const provenance = message.parentToolUseId ? { parentToolUseId: message.parentToolUseId } : {};

  // Already stored? Then this is a re-read, and re-reading must be a no-op.
  //
  // Checked here rather than left to the unique index so the common case (a
  // reader restarting over a file it has partly consumed) is an ordinary
  // answer rather than a constraint error. The index is still the real
  // guarantee against two writers racing.
  if (message.dedupeKey && (await alreadyCaptured(exec, sessionId, message.dedupeKey))) return null;

  // Stamped on every insert below. `channel` says which of the five capture
  // routes this arrived on; `dedupe_key` is how it is recognised again.
  const capture = {
    channel: message.channel ?? channel ?? null,
    dedupe_key: message.dedupeKey ?? null,
  };

  let stored: number | null = null;
  switch (message.type) {
    case "text": {
      stored = (await exec
        .insertInto("messages")
        .values({
          ...capture,
          id: eventId,
          session_id: sessionId,
          provider_session_id: providerSessionId ?? null,
          model_id: modelId,
          type: "message",
          sequence: at,
          role: message.role ?? "assistant",
          content: [{ type: "text", text: message.content ?? "" }],
          metadata: { ws_type: "text", ...(message.metadata ?? {}), ...provenance },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow()).sequence;
      break;
    }

    case "tool_start": {
      // A result for this call may already have arrived and been retained
      // (see `orphanedToolResults`) when the two persists overlap. Claim it
      // now so the row is inserted complete.
      const earlyResult = takeOrphanedResult(sessionId, message.toolUseId);

      stored = (await exec
        .insertInto("messages")
        .values({
          ...capture,
          id: eventId,
          session_id: sessionId,
          provider_session_id: providerSessionId ?? null,
          model_id: modelId,
          type: "tool_call",
          sequence: at,
          name: message.name ?? "unknown",
          input: message.input ?? {},
          result: earlyResult ?? null,
          metadata: { toolUseId: message.toolUseId, ...provenance },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow()).sequence;

      const pending = correlationOf(pendingToolCalls, sessionId);
      const key = message.toolUseId || eventId;
      // A call whose result is already attached must NOT stay pending: leaving
      // it there would let the untagged "exactly one pending call" fallback
      // hand an unrelated later result to this finished row.
      if (earlyResult === undefined) {
        setBounded(pending, key, eventId, MAX_PENDING_CALLS);
      } else {
        pending.delete(key);
      }

      // The result can also land DURING the insert above, after the claim.
      // Re-check once the row exists so that arrival is written rather than
      // left waiting for a `tool_start` that has already happened.
      if (earlyResult === undefined) {
        const lateResult = takeOrphanedResult(sessionId, message.toolUseId);
        if (lateResult !== undefined) {
          pending.delete(key);
          await exec
            .updateTable("messages")
            .set({ result: lateResult })
            .where("id", "=", eventId)
            .execute();
        }
      }
      break;
    }

    case "tool_result": {
      const pending = pendingToolCalls.get(sessionId) ?? new Map<string, string>();
      let pendingEventId: string | undefined;

      if (message.toolUseId && pending.has(message.toolUseId)) {
        pendingEventId = pending.get(message.toolUseId);
        pending.delete(message.toolUseId);
      } else if (!message.toolUseId && pending.size === 1) {
        // No id to match on. Falling back to "first pending" is only safe when
        // exactly one call is outstanding — with several in flight (parallel
        // tool calls, subagents) it would attach the result to whichever call
        // happened to be first, silently mis-recording both.
        const first = pending.entries().next();
        if (!first.done) {
          pendingEventId = first.value[1];
          pending.delete(first.value[0]);
        }
      }

      if (!pendingEventId && message.toolUseId) {
        const row = await findPendingToolCallRow(exec, sessionId, message.toolUseId);
        if (row) pendingEventId = row.id;
      }

      if (pendingEventId) {
        await exec
          .updateTable("messages")
          .set({ result: message.result ?? null })
          .where("id", "=", pendingEventId)
          .execute();
      } else if (message.toolUseId) {
        // Nothing to update yet: the `tool_start` is still being persisted
        // concurrently or has not arrived. Dropping the result here is what
        // lost it — retain it so the call's own insert picks it up.
        retainOrphanedResult(sessionId, message.toolUseId, message.result ?? "");
      }
      break;
    }

    case "error": {
      stored = (await exec
        .insertInto("messages")
        .values({
          ...capture,
          id: eventId,
          session_id: sessionId,
          provider_session_id: providerSessionId ?? null,
          model_id: modelId,
          type: "message",
          sequence: at,
          role: "system",
          content: [{ type: "text", text: message.error ?? message.content ?? "" }],
          metadata: { ws_type: "error", ...provenance },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow()).sequence;
      break;
    }

    case "init": {
      stored = (await exec
        .insertInto("messages")
        .values({
          ...capture,
          id: eventId,
          session_id: sessionId,
          provider_session_id: providerSessionId ?? null,
          model_id: modelId,
          type: "message",
          sequence: at,
          role: "system",
          content: [{ type: "text", text: message.content ?? "" }],
          metadata: { ws_type: "init", ...provenance },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow()).sequence;
      break;
    }

    case "result": {
      stored = (await exec
        .insertInto("messages")
        .values({
          ...capture,
          id: eventId,
          session_id: sessionId,
          provider_session_id: providerSessionId ?? null,
          model_id: modelId,
          type: "message",
          sequence: at,
          role: "system",
          content: [{ type: "text", text: message.result ?? message.error ?? "" }],
          metadata: { ...(message.metadata ?? {}), ws_type: "result", status: message.status, ...provenance },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow()).sequence;
      break;
    }

    case "summary": {
      stored = (await exec
        .insertInto("messages")
        .values({
          ...capture,
          id: eventId,
          session_id: sessionId,
          provider_session_id: providerSessionId ?? null,
          model_id: modelId,
          type: "message",
          sequence: at,
          role: "system",
          content: [{ type: "text", text: message.content ?? "" }],
          metadata: { ws_type: "summary", taskStatus: message.status, ...provenance },
        })
        .returning("sequence")
        .executeTakeFirstOrThrow()).sequence;
      break;
    }
  }
  return stored;
}

/**
 * The next sequence in a session, as the insert computes it: one past the
 * highest stored, 0 for the first. Evaluated inside the INSERT, which holds
 * the store's write lock from its first step, so two processes appending to
 * one session cannot take the same number (the unique index on
 * `(session_id, sequence)` is the guarantee behind that).
 */
function nextSequence(sessionId: string) {
  return sql<number>`(SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE session_id = ${sessionId})`;
}

// Only these types are ever authored by the model — a user turn and the
// system notices this module synthesizes (init/error/result/summary) were
// not produced by a model, so stamping the session's model onto them would
// make "which model wrote this" unanswerable for the rows where it matters.
/**
 * Message types whose rows carry a model attribution.
 *
 * Exported alongside `persistOne` so the SQLite path applies the same rule.
 * Gated on TYPE, not role: the system rows (error/init/result/summary) set
 * their role inside persistOne's switch, so checking role here let them
 * through and stamped them with a model that did not author them.
 */
export const MODEL_AUTHORED = new Set(["text", "tool_start"]);
