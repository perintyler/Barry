/**
 * Event-driven work, durably (P4.4 preparation).
 *
 * Today an event's hooks are spawned in-process right after the insert, once:
 * a crash in between loses them, a second process's events never fire them,
 * and nothing records what was owed. This module is the producer half of the
 * target shape, opt-in and unused by the existing writer:
 *
 * - A consumer reads the event log by `seq` from its own checkpoint, in
 *   bounded batches. The work each event causes is recorded in an outbox in
 *   the same transaction that advances the checkpoint, so a restart neither
 *   skips an event nor records it twice, and a replayed batch is a no-op.
 * - Each occurrence is keyed `(consumer, event)`; a duplicate event delivery
 *   is the same key. Coalescing (opt-in, bounded) folds further events into
 *   an occurrence nobody has dispatched yet, when they would cause the same
 *   work with the same inputs.
 * - Delivery goes to the occurrence's executor generation, chosen at record
 *   time: canonical Work admission through an injected admission port (the
 *   shared producer adapter), or a legacy runner. After possible admission
 *   the original key is observed, never replaced; legacy work that may have
 *   started is never started again.
 */

import { createHash, randomUUID } from "node:crypto";
import type { WorkSubmission } from "@barry-rocks/sdk/internal/workflows";
import { getDb } from "./db.js";
import type { EventRecord } from "./store.js";

export type EventExecutorGeneration = "legacy" | "work.v2";
export type EventDispatchState = "pending" | "dispatching" | "accepted" | "unknown" | "refused";

/** What one event causes, as a subscription derives it. Pure: no reads of mutable state. */
export interface EventWorkIntent {
  definition: WorkSubmission["definition"];
  inputs: Record<string, unknown>;
  /** Events with the same key (and identical inputs) may share one pending occurrence. */
  coalesceKey?: string;
}

export interface EventWorkSubscription {
  /** Stable consumer name; part of every key it produces. Renaming it starts a new consumer. */
  consumer: string;
  intent(event: EventRecord): EventWorkIntent | null;
  generation: EventExecutorGeneration;
  /** Bound on how many events one occurrence may absorb. Omit to never coalesce. */
  coalesceMax?: number;
  /** Where a brand-new consumer starts: after the current newest event (default), or at the beginning. */
  startAt?: "now" | "beginning";
}

export interface EventOccurrence {
  occurrenceId: string;
  consumer: string;
  eventId: string;
  eventSeq: number;
  coalesceKey: string | null;
  coalescedEventIds: string[];
  coalescedCount: number;
  definition: WorkSubmission["definition"];
  inputs: Record<string, unknown>;
  idempotencyKey: string;
  requestId: string;
  executorGeneration: EventExecutorGeneration;
  state: EventDispatchState;
  attempts: number;
  nextAttemptAt: Date;
  authorityRef: string | null;
  requestHash: string | null;
  workId: string | null;
  workflowId: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  dispatcherPid: number | null;
  dispatcherStartedAt: number | null;
}

/** Event ids an occurrence lists as coalesced; the count keeps going past this. */
export const MAX_LISTED_COALESCED = 100;
export const DEFAULT_EVENT_BATCH = 200;
const MAX_REF_BYTES = 200;
/** A retry time that never comes: the occurrence waits for a human, visibly. */
const NEVER = new Date("9999-12-31T23:59:59.999Z");
const iso = (d: Date) => d.toISOString();

const bounded = (value: string, prefix: string) =>
  Buffer.byteLength(value, "utf8") <= MAX_REF_BYTES ? value : `${prefix}:sha256:${createHash("sha256").update(value).digest("hex")}`;

export function eventOccurrenceId(consumer: string, eventId: string): string {
  return bounded(`events:${consumer}:${eventId}`, "events");
}

export function eventProducerRef(consumer: string): string {
  return bounded(`events:${consumer}`, "events");
}

interface OutboxRow {
  occurrence_id: string;
  consumer: string;
  event_id: string;
  event_seq: number;
  coalesce_key: string | null;
  coalesced_event_ids: string;
  coalesced_count: number;
  definition_json: string;
  inputs_json: string;
  idempotency_key: string;
  request_id: string;
  executor_generation: EventExecutorGeneration;
  state: EventDispatchState;
  attempts: number;
  next_attempt_at: string;
  authority_ref: string | null;
  request_hash: string | null;
  work_id: string | null;
  workflow_id: string | null;
  last_error_code: string | null;
  last_error: string | null;
  dispatcher_pid: number | null;
  dispatcher_started_at: number | null;
}

function toOccurrence(row: OutboxRow): EventOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    consumer: row.consumer,
    eventId: row.event_id,
    eventSeq: row.event_seq,
    coalesceKey: row.coalesce_key,
    coalescedEventIds: JSON.parse(row.coalesced_event_ids) as string[],
    coalescedCount: row.coalesced_count,
    definition: JSON.parse(row.definition_json) as WorkSubmission["definition"],
    inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    executorGeneration: row.executor_generation,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    authorityRef: row.authority_ref,
    requestHash: row.request_hash,
    workId: row.work_id,
    workflowId: row.workflow_id,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    dispatcherPid: row.dispatcher_pid,
    dispatcherStartedAt: row.dispatcher_started_at,
  };
}

interface EventRow {
  id: string;
  seq: number;
  type: string;
  session_id: string | null;
  source: string;
  title: string;
  body: string | null;
  severity: string;
  data: string;
  metadata: string;
  delivered_via: string;
  read_at: string | null;
  created_at: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    session_id: row.session_id,
    source: row.source,
    title: row.title,
    body: row.body,
    severity: row.severity,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    delivered_via: parseJson<string[]>(row.delivered_via, []),
    read_at: row.read_at ? new Date(row.read_at) : null,
    created_at: new Date(row.created_at),
  };
}

export function getEventOccurrence(occurrenceId: string): EventOccurrence | null {
  const row = getDb().prepare("SELECT * FROM work_producer_event_outbox WHERE occurrence_id = ?").get(occurrenceId) as OutboxRow | undefined;
  return row ? toOccurrence(row) : null;
}

export function eventCheckpoint(consumer: string): number | null {
  const row = getDb().prepare("SELECT last_seq FROM work_producer_event_checkpoint WHERE consumer = ?").get(consumer) as { last_seq: number } | undefined;
  return row ? row.last_seq : null;
}

/**
 * Record the work one batch of new events causes, and advance the consumer's
 * checkpoint past them, in one transaction. Safe to call repeatedly and from
 * any process: a batch already recorded is skipped by the checkpoint, and an
 * occurrence already recorded is skipped by its key.
 */
export function recordEventOccurrences(subscription: EventWorkSubscription, options: { now: Date; batch?: number }): {
  scanned: number;
  recorded: number;
  coalesced: number;
  checkpoint: number;
} {
  if (!subscription.consumer) throw new Error("an event consumer needs a stable name");
  const db = getDb();
  const batch = Math.min(Math.max(options.batch ?? DEFAULT_EVENT_BATCH, 1), 1_000);
  return db.transaction(() => {
    let checkpoint = eventCheckpoint(subscription.consumer);
    if (checkpoint === null) {
      checkpoint = subscription.startAt === "beginning"
        ? 0
        : (db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
      db.prepare("INSERT INTO work_producer_event_checkpoint (consumer, last_seq, updated_at) VALUES (?, ?, ?)")
        .run(subscription.consumer, checkpoint, iso(options.now));
    }
    const events = (db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(checkpoint, batch) as EventRow[]).map(toEvent);
    let recorded = 0;
    let coalesced = 0;
    for (const event of events) {
      const intent = subscription.intent(event);
      if (!intent) continue;
      const inputsJson = JSON.stringify(intent.inputs);
      const definitionJson = JSON.stringify(intent.definition);
      if (intent.coalesceKey && subscription.coalesceMax && subscription.coalesceMax > 1) {
        const open = db.prepare(
          `SELECT * FROM work_producer_event_outbox WHERE consumer = ? AND coalesce_key = ? AND state = 'pending'
             AND definition_json = ? AND inputs_json = ? AND coalesced_count < ? ORDER BY event_seq LIMIT 1`,
        ).get(subscription.consumer, intent.coalesceKey, definitionJson, inputsJson, subscription.coalesceMax) as OutboxRow | undefined;
        if (open) {
          const listed = JSON.parse(open.coalesced_event_ids) as string[];
          if (!listed.includes(event.id) && open.event_id !== event.id) {
            if (listed.length < MAX_LISTED_COALESCED) listed.push(event.id);
            db.prepare("UPDATE work_producer_event_outbox SET coalesced_event_ids = ?, coalesced_count = coalesced_count + 1, updated_at = ? WHERE occurrence_id = ? AND state = 'pending'")
              .run(JSON.stringify(listed), iso(options.now), open.occurrence_id);
            coalesced += 1;
          }
          continue;
        }
      }
      const occurrenceId = eventOccurrenceId(subscription.consumer, event.id);
      const inserted = db.prepare(
        `INSERT INTO work_producer_event_outbox (occurrence_id, consumer, event_id, event_seq, coalesce_key, definition_json, inputs_json,
           idempotency_key, request_id, executor_generation, state, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(
        occurrenceId, subscription.consumer, event.id, event.seq, intent.coalesceKey ?? null, definitionJson, inputsJson,
        occurrenceId, randomUUID(), subscription.generation, iso(options.now), iso(options.now), iso(options.now),
      ).changes;
      recorded += inserted;
    }
    const last = events.at(-1)?.seq ?? checkpoint;
    db.prepare("UPDATE work_producer_event_checkpoint SET last_seq = ?, updated_at = ? WHERE consumer = ? AND last_seq <= ?")
      .run(last, iso(options.now), subscription.consumer, last);
    return { scanned: events.length, recorded, coalesced, checkpoint: last };
  }).immediate();
}

/** The outbox as the shared producer adapter's store port. */
export function eventOutboxDispatchPort(now: () => Date) {
  const db = () => getDb();
  return {
    bindAuthority(occurrenceId: string, binding: { authorityRef: string; requestHash: string }): void {
      db().transaction(() => {
        const row = db().prepare("SELECT authority_ref, request_hash FROM work_producer_event_outbox WHERE occurrence_id = ?").get(occurrenceId) as
          | { authority_ref: string | null; request_hash: string | null }
          | undefined;
        if (!row) throw new Error(`event occurrence ${occurrenceId} is not recorded`);
        if ((row.authority_ref !== null && row.authority_ref !== binding.authorityRef) || (row.request_hash !== null && row.request_hash !== binding.requestHash)) {
          throw new Error(`event occurrence ${occurrenceId} is already bound to a different authority or intent`);
        }
        db().prepare("UPDATE work_producer_event_outbox SET authority_ref = ?, request_hash = ?, updated_at = ? WHERE occurrence_id = ? AND authority_ref IS NULL")
          .run(binding.authorityRef, binding.requestHash, iso(now()), occurrenceId);
      }).immediate();
    },
    markAccepted(occurrenceId: string, accepted: { workId: string; workflowId: string | null }): void {
      const row = getEventOccurrence(occurrenceId);
      if (!row) throw new Error(`event occurrence ${occurrenceId} is not recorded`);
      if (row.workId !== null && row.workId !== accepted.workId) throw new Error(`event occurrence ${occurrenceId} is already accepted as ${row.workId}`);
      if (row.state === "accepted") return;
      db().prepare(
        `UPDATE work_producer_event_outbox SET state = 'accepted', work_id = ?, workflow_id = ?, last_error_code = NULL, last_error = NULL,
           dispatcher_pid = NULL, dispatcher_started_at = NULL, updated_at = ? WHERE occurrence_id = ? AND state IN ('dispatching', 'unknown')`,
      ).run(accepted.workId, accepted.workflowId, iso(now()), occurrenceId);
    },
    markUnknown(occurrenceId: string, error: { code: string; message: string }, retryAt: Date): void {
      db().prepare(
        `UPDATE work_producer_event_outbox SET state = 'unknown', last_error_code = ?, last_error = ?, next_attempt_at = ?,
           dispatcher_pid = NULL, dispatcher_started_at = NULL, updated_at = ? WHERE occurrence_id = ? AND state IN ('dispatching', 'unknown')`,
      ).run(error.code, error.message.slice(0, 2000), iso(retryAt), iso(now()), occurrenceId);
    },
    markRefused(occurrenceId: string, error: { code: string; message: string }): void {
      db().prepare(
        `UPDATE work_producer_event_outbox SET state = 'refused', last_error_code = ?, last_error = ?, dispatcher_pid = NULL, dispatcher_started_at = NULL, updated_at = ?
          WHERE occurrence_id = ? AND state IN ('pending', 'dispatching', 'unknown')`,
      ).run(error.code, error.message.slice(0, 2000), iso(now()), occurrenceId);
    },
  };
}

/** Structurally the shared producer adapter's admission result. */
export type EventAdmissionResult =
  | { state: "accepted"; workId: string; workflowId: string; recovered: boolean }
  | { state: "unknown"; code: string; message: string; retryAt: Date }
  | { state: "refused"; code: string; message: string };

/**
 * Structurally WorkProducerAdmission (bags/schedules work-producer-admission):
 * the composition root passes that adapter, built with
 * `eventOutboxDispatchPort` as its store and an event service authority.
 */
export interface EventAdmissionPort {
  admit(
    occurrence: {
      occurrenceId: string;
      executorGeneration: string;
      submission: Omit<WorkSubmission, "authority_ref"> & {
        origin: { entry_point: string; trigger: "event"; occurrence_id: string; producer_ref: string };
      };
      selection: { identity: string | null; identity_id: number | null; traits: string[]; bounds: string[] };
      possiblyAdmitted: boolean;
      boundAuthorityRef: string | null;
      boundRequestHash: string | null;
    },
    attempts: number,
  ): Promise<EventAdmissionResult>;
}

/** Runs a legacy-generation event occurrence (for bag hooks: runBarryHook). Resolves ok/failed; may throw. */
export type LegacyEventRunner = (occurrence: EventOccurrence) => Promise<{ ok: boolean; reason?: string }>;

export type EventDispatchResult =
  | { kind: "accepted"; workId: string; recovered: boolean }
  | { kind: "ran"; ok: boolean; reason?: string }
  | { kind: "unknown"; code: string; message: string }
  | { kind: "refused"; code: string; message: string }
  | { kind: "skipped"; state: EventDispatchState };

export class EventOutboxDispatcher {
  constructor(
    private readonly deps: {
      /** Null keeps work.v2 occurrences waiting, visible, until one is composed. */
      admission: EventAdmissionPort | null;
      legacy: LegacyEventRunner | null;
      runner: { pid: number; startedAt: number | null };
      probe: (pid: number, startedAt: number | null) => "alive" | "gone" | "unknown";
      now: () => Date;
      /** Events carry no identity selection; the event service authority decides. */
      selection?: { identity: string | null; identity_id: number | null; traits: string[]; bounds: string[] };
    },
  ) {}

  private begin(occurrenceId: string): EventOccurrence | null {
    const db = getDb();
    const now = this.deps.now();
    return db.transaction(() => {
      const changed = db.prepare(
        `UPDATE work_producer_event_outbox SET state = 'dispatching', attempts = attempts + 1, dispatcher_pid = ?, dispatcher_started_at = ?, updated_at = ?
          WHERE occurrence_id = ? AND state IN ('pending', 'unknown') AND next_attempt_at <= ?`,
      ).run(this.deps.runner.pid, this.deps.runner.startedAt, iso(now), occurrenceId, iso(now)).changes;
      return changed === 1 ? getEventOccurrence(occurrenceId) : null;
    }).immediate();
  }

  async dispatch(occurrenceId: string): Promise<EventDispatchResult> {
    const before = getEventOccurrence(occurrenceId);
    if (!before) throw new Error(`event occurrence ${occurrenceId} is not recorded`);
    // A legacy run that may have started is never started again.
    if (before.executorGeneration === "legacy" && before.state === "unknown") return { kind: "skipped", state: before.state };
    if (before.executorGeneration === "work.v2" && !this.deps.admission) return { kind: "skipped", state: before.state };
    if (before.executorGeneration === "legacy" && !this.deps.legacy) return { kind: "skipped", state: before.state };
    const possiblyAdmitted = before.state === "unknown";
    const claimed = this.begin(occurrenceId);
    if (!claimed) return { kind: "skipped", state: before.state };
    const port = eventOutboxDispatchPort(this.deps.now);

    if (claimed.executorGeneration === "work.v2") {
      const inputs: WorkSubmission["inputs"] = JSON.parse(JSON.stringify(claimed.inputs));
      const result = await this.deps.admission!.admit({
        occurrenceId: claimed.occurrenceId,
        executorGeneration: claimed.executorGeneration,
        submission: {
          version: 2,
          request_id: claimed.requestId,
          idempotency_key: claimed.idempotencyKey,
          definition: claimed.definition,
          inputs,
          origin: { entry_point: "events.consumer", trigger: "event", occurrence_id: claimed.occurrenceId, producer_ref: eventProducerRef(claimed.consumer) },
        },
        selection: this.deps.selection ?? { identity: null, identity_id: null, traits: [], bounds: [] },
        possiblyAdmitted,
        boundAuthorityRef: claimed.authorityRef,
        boundRequestHash: claimed.requestHash,
      }, claimed.attempts);
      if (result.state === "accepted") return { kind: "accepted", workId: result.workId, recovered: result.recovered };
      return result.state === "unknown" ? { kind: "unknown", code: result.code, message: result.message } : { kind: "refused", code: result.code, message: result.message };
    }

    let outcome: { ok: boolean; reason?: string };
    try {
      outcome = await this.deps.legacy!(claimed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      port.markUnknown(occurrenceId, { code: "legacy_start_error", message }, NEVER);
      return { kind: "unknown", code: "legacy_start_error", message };
    }
    port.markAccepted(occurrenceId, { workId: `legacy:${occurrenceId}`, workflowId: null });
    return { kind: "ran", ...outcome };
  }

  /** Pending (and unconfirmed Work) occurrences due now, oldest first. */
  due(limit = 32): EventOccurrence[] {
    return (getDb().prepare(
      `SELECT * FROM work_producer_event_outbox WHERE state IN ('pending', 'unknown') AND next_attempt_at <= ? ORDER BY event_seq LIMIT ?`,
    ).all(iso(this.deps.now()), Math.min(Math.max(limit, 1), 500)) as OutboxRow[]).map(toOccurrence);
  }

  /**
   * Settle `dispatching` rows a dead dispatcher left: each may have been
   * admitted or started. Work ones are observed by key on their next
   * dispatch; legacy ones wait for a human.
   */
  recoverAbandoned(): Array<{ occurrenceId: string; action: "left-alive" | "unknown" | "needs-attention" }> {
    const port = eventOutboxDispatchPort(this.deps.now);
    const rows = (getDb().prepare(
      "SELECT * FROM work_producer_event_outbox WHERE state = 'dispatching' AND (dispatcher_pid IS NULL OR dispatcher_pid != ?)",
    ).all(this.deps.runner.pid) as OutboxRow[]).map(toOccurrence);
    return rows.map((row) => {
      const state = row.dispatcherPid === null ? "gone" : this.deps.probe(row.dispatcherPid, row.dispatcherStartedAt);
      if (state !== "gone") return { occurrenceId: row.occurrenceId, action: "left-alive" as const };
      if (row.executorGeneration === "work.v2") {
        port.markUnknown(row.occurrenceId, { code: "dispatcher_died", message: "dispatcher stopped mid-dispatch; observing the original key" }, this.deps.now());
        return { occurrenceId: row.occurrenceId, action: "unknown" as const };
      }
      port.markUnknown(row.occurrenceId, { code: "legacy_outcome_unknown", message: "dispatcher stopped while the hook may have been running; not run again" }, NEVER);
      return { occurrenceId: row.occurrenceId, action: "needs-attention" as const };
    });
  }
}

/**
 * Bounded retention: settled occurrences (accepted, refused) older than
 * `before` go. Anything that may still await admission stays, as does each
 * consumer's checkpoint.
 */
export function pruneEventOccurrences(before: Date): number {
  return getDb().prepare("DELETE FROM work_producer_event_outbox WHERE state IN ('accepted', 'refused') AND updated_at < ?").run(iso(before)).changes;
}
