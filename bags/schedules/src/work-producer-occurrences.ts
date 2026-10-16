/**
 * Durable schedule occurrences and their dispatch outbox (P4.3 preparation).
 *
 * The legacy scheduler persists `next_fire_at` and then dispatches; a crash in
 * between loses the fire, and a scheduled job's key is the dispatch time, not
 * the slot. This ledger records WHAT was due — the nominal slot, its timezone
 * and policy, the schedule context and the exact admission it will be
 * submitted as — in the same transaction that advances the due time. Delivery
 * is then at least once with that one key, and the owner makes at most one
 * logical run of it.
 *
 * Nothing here runs unless a Scheduler is composed with an occurrence ledger:
 * the default scheduler path does not write these tables.
 *
 * Rules the guarded UPDATEs (and the migration's triggers) enforce:
 * - An occurrence is immutable. Recovery resubmits the stored key, request id,
 *   payload and executor generation; it never re-derives them.
 * - `dispatching` and `unknown` mean admission may have happened. They can be
 *   observed (lookup the original key) or redelivered with the identical
 *   submission, never reset to `pending` or replaced by new work.
 * - `accepted` is terminal: after admission only the owner retries.
 */

import { createHash, randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { updateState, type ScheduleState } from "./store.js";
import type { ScheduleEntry } from "./registry.js";
import type { AtSchedule } from "./at-schedules.js";
import { scheduleJobRef } from "./job-fires.js";

export type OccurrenceKind = "slot" | "at" | "login" | "manual" | "one_off" | "queued";
export type ExecutorGeneration = "legacy" | "work.v2";
export type DispatchState = "pending" | "dispatching" | "accepted" | "unknown" | "refused" | "skipped" | "missed" | "coalesced";

/** A Work definition reference, or the inline action a legacy-only occurrence runs. */
export type OccurrenceDefinition =
  | { kind: "action"; reference: string; catalog_namespace: string }
  | { kind: "job"; reference: string }
  | { kind: "inline"; manifest_digest: string };

export interface OccurrencePolicy {
  catch_up: "none" | "once";
  overlap: "skip" | "queue";
  /** True when the slot ran later than the on-time grace (a catch-up). */
  late: boolean;
  /** Slots folded into this occurrence by `catch_up: once` (bounded count). */
  coalesced_slots: number;
  login_event_id?: string;
  manual_id?: string;
  /** Why a Work choice was recorded on the legacy generation instead. */
  generation_note?: string;
}

export interface OccurrenceContext {
  identity: string | null;
  identity_id: number | null;
  traits: string[];
  bounds: string[];
}

export interface ProducerOccurrence {
  occurrenceId: string;
  producerRef: string;
  scheduleId: string | null;
  oneOffId: string | null;
  kind: OccurrenceKind;
  slotAt: Date | null;
  timezone: string | null;
  triggerKey: string | null;
  policy: OccurrencePolicy;
  context: OccurrenceContext;
  definition: OccurrenceDefinition;
  inputs: Record<string, unknown>;
  idempotencyKey: string;
  requestId: string;
  executorGeneration: ExecutorGeneration;
  createdAt: Date;
}

export interface OccurrenceDispatch {
  occurrenceId: string;
  state: DispatchState;
  attempts: number;
  nextAttemptAt: Date;
  authorityRef: string | null;
  requestHash: string | null;
  workId: string | null;
  workflowId: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  outcome: "complete" | "failed" | null;
  dispatcherPid: number | null;
  dispatcherStartedAt: number | null;
  updatedAt: Date;
}

export type NewOccurrence = Omit<ProducerOccurrence, "idempotencyKey" | "requestId" | "createdAt"> & {
  /** Only for tests and one-off adoption; normally derived from occurrenceId. */
  idempotencyKey?: string;
  requestId?: string;
};

/** The same occurrence id was recorded with a different payload. */
export class OccurrenceConflictError extends Error {
  constructor(occurrenceId: string) {
    super(`occurrence ${occurrenceId} was already recorded with a different payload`);
    this.name = "OccurrenceConflictError";
  }
}

/** A dispatch binding (authority ref, request hash, work id) differs from the one already bound. */
export class DispatchBindingError extends Error {
  constructor(occurrenceId: string, what: string) {
    super(`occurrence ${occurrenceId} is already bound to a different ${what}; refusing to replace it`);
    this.name = "DispatchBindingError";
  }
}

/** Work admission keys and refs are at most 200 UTF-8 bytes. */
const MAX_REF_BYTES = 200;
/** How many missed slots a catch-up counts before reporting the bound instead. */
export const MAX_COUNTED_SLOTS = 1_000;

const iso = (d: Date) => d.toISOString();
const toDate = (v: string | null) => (v == null ? null : new Date(v));

/**
 * The stable id of a schedule occurrence. A calendar slot (and a one-off
 * `at`) is `<schedule>@<slot ISO>` — the same spelling `scheduleJobRun` has
 * always used for a job's key, so a legacy job one-off and its occurrence
 * agree. Login and manual occurrences carry their event or manual id.
 */
export function scheduleOccurrenceId(scheduleId: string, kind: OccurrenceKind, discriminator: Date | string): string {
  switch (kind) {
    case "slot":
    case "at":
    case "queued":
      if (!(discriminator instanceof Date)) throw new Error(`${kind} occurrences are identified by their slot time`);
      return `${scheduleId}@${iso(discriminator)}`;
    case "login":
      return `${scheduleId}@login:${String(discriminator)}`;
    case "manual":
      return `${scheduleId}@manual:${String(discriminator)}`;
    case "one_off":
      throw new Error("one-off occurrences are identified by oneOffOccurrenceId");
  }
}

/** The occurrence a one-off row becomes: one per row, whatever its retries. */
export function oneOffOccurrenceId(oneOffId: string): string {
  return `once:${oneOffId}`;
}

/** The admission key for an occurrence: its id, or a digest when the id is over the ref limit. */
export function occurrenceIdempotencyKey(occurrenceId: string): string {
  if (Buffer.byteLength(occurrenceId, "utf8") <= MAX_REF_BYTES) return occurrenceId;
  return `schedules:sha256:${createHash("sha256").update(occurrenceId).digest("hex")}`;
}

/** The producer reference Work admission records for a schedule. */
export function scheduleProducerRef(scheduleId: string): string {
  const ref = `schedules:${scheduleId}`;
  return Buffer.byteLength(ref, "utf8") <= MAX_REF_BYTES ? ref : `schedules:sha256:${createHash("sha256").update(scheduleId).digest("hex")}`;
}

/** What makes two recordings of one occurrence the same: everything but bookkeeping. */
function payloadHash(o: Omit<ProducerOccurrence, "createdAt">): string {
  return createHash("sha256").update(JSON.stringify([
    o.producerRef, o.scheduleId, o.oneOffId, o.kind, o.slotAt ? iso(o.slotAt) : null, o.timezone, o.triggerKey,
    o.context, o.definition, o.inputs, o.idempotencyKey, o.executorGeneration,
  ])).digest("hex");
}

interface OccurrenceRow {
  occurrence_id: string;
  producer_ref: string;
  schedule_id: string | null;
  one_off_id: string | null;
  kind: OccurrenceKind;
  slot_at: string | null;
  timezone: string | null;
  trigger_key: string | null;
  policy_json: string;
  context_json: string;
  definition_json: string;
  inputs_json: string;
  idempotency_key: string;
  request_id: string;
  executor_generation: ExecutorGeneration;
  created_at: string;
}

interface DispatchRow {
  occurrence_id: string;
  state: DispatchState;
  attempts: number;
  next_attempt_at: string;
  authority_ref: string | null;
  request_hash: string | null;
  work_id: string | null;
  workflow_id: string | null;
  last_error_code: string | null;
  last_error: string | null;
  outcome: "complete" | "failed" | null;
  dispatcher_pid: number | null;
  dispatcher_started_at: number | null;
  updated_at: string;
}

function toOccurrence(row: OccurrenceRow): ProducerOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    producerRef: row.producer_ref,
    scheduleId: row.schedule_id,
    oneOffId: row.one_off_id,
    kind: row.kind,
    slotAt: toDate(row.slot_at),
    timezone: row.timezone,
    triggerKey: row.trigger_key,
    policy: JSON.parse(row.policy_json) as OccurrencePolicy,
    context: JSON.parse(row.context_json) as OccurrenceContext,
    definition: JSON.parse(row.definition_json) as OccurrenceDefinition,
    inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    executorGeneration: row.executor_generation,
    createdAt: new Date(row.created_at),
  };
}

function toDispatch(row: DispatchRow): OccurrenceDispatch {
  return {
    occurrenceId: row.occurrence_id,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    authorityRef: row.authority_ref,
    requestHash: row.request_hash,
    workId: row.work_id,
    workflowId: row.workflow_id,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    outcome: row.outcome,
    dispatcherPid: row.dispatcher_pid,
    dispatcherStartedAt: row.dispatcher_started_at,
    updatedAt: new Date(row.updated_at),
  };
}

export function getOccurrence(occurrenceId: string): { occurrence: ProducerOccurrence; dispatch: OccurrenceDispatch } | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM work_producer_occurrence WHERE occurrence_id = ?").get(occurrenceId) as OccurrenceRow | undefined;
  if (!row) return null;
  const dispatch = db.prepare("SELECT * FROM work_producer_dispatch WHERE occurrence_id = ?").get(occurrenceId) as DispatchRow;
  return { occurrence: toOccurrence(row), dispatch: toDispatch(dispatch) };
}

/** Occurrences of one schedule, newest first. */
export function listOccurrences(scheduleId: string, limit = 50): Array<{ occurrence: ProducerOccurrence; dispatch: OccurrenceDispatch }> {
  const rows = getDb().prepare(
    `SELECT o.occurrence_id FROM work_producer_occurrence o WHERE o.schedule_id = ? ORDER BY o.created_at DESC, o.occurrence_id DESC LIMIT ?`,
  ).all(scheduleId, Math.min(Math.max(limit, 1), 500)) as Array<{ occurrence_id: string }>;
  return rows.map((r) => getOccurrence(r.occurrence_id)!);
}

/**
 * Record an occurrence and its dispatch intent, applying `statePatch` (the due
 * time it consumes) in the same transaction. Recording the same occurrence
 * again is a replay: the stored one is returned unchanged, and the patch still
 * applies, so a scheduler that crashed after recording re-advances the same
 * due time. A different payload under the same id throws.
 */
export function recordOccurrence(input: {
  occurrence: NewOccurrence;
  state: Extract<DispatchState, "pending" | "skipped" | "missed" | "coalesced">;
  statePatch?: Partial<Omit<ScheduleState, "schedule_id">>;
  /** Extra writes that must commit with the occurrence (a login claim, a skip counter). */
  alsoInTransaction?: () => void;
  /**
   * What a different payload under a recorded id means. `throw` (default)
   * refuses it; `keep-original` — the scheduler's choice — keeps the stored
   * occurrence as the slot's intent and still applies the due-time patch, so
   * a bag.yaml edit that re-derives an already recorded slot can neither
   * replace its intent nor wedge the schedule on a conflict every tick.
   */
  onConflict?: "throw" | "keep-original";
  now: Date;
}): { occurrence: ProducerOccurrence; dispatch: OccurrenceDispatch; created: boolean } {
  const db = getDb();
  const occurrence: Omit<ProducerOccurrence, "createdAt"> = {
    ...input.occurrence,
    idempotencyKey: input.occurrence.idempotencyKey ?? occurrenceIdempotencyKey(input.occurrence.occurrenceId),
    requestId: input.occurrence.requestId ?? randomUUID(),
  };
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM work_producer_occurrence WHERE occurrence_id = ? OR idempotency_key = ?")
      .get(occurrence.occurrenceId, occurrence.idempotencyKey) as OccurrenceRow | undefined;
    let created = false;
    if (existing) {
      const stored = toOccurrence(existing);
      if (stored.occurrenceId !== occurrence.occurrenceId) throw new OccurrenceConflictError(occurrence.occurrenceId);
      if (payloadHash(stored) !== payloadHash({ ...occurrence, requestId: stored.requestId }) && input.onConflict !== "keep-original") {
        throw new OccurrenceConflictError(occurrence.occurrenceId);
      }
    } else {
      db.prepare(
        `INSERT INTO work_producer_occurrence (occurrence_id, producer_ref, schedule_id, one_off_id, kind, slot_at, timezone, trigger_key,
           policy_json, context_json, definition_json, inputs_json, idempotency_key, request_id, executor_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        occurrence.occurrenceId, occurrence.producerRef, occurrence.scheduleId, occurrence.oneOffId, occurrence.kind,
        occurrence.slotAt ? iso(occurrence.slotAt) : null, occurrence.timezone, occurrence.triggerKey,
        JSON.stringify(occurrence.policy), JSON.stringify(occurrence.context), JSON.stringify(occurrence.definition),
        JSON.stringify(occurrence.inputs), occurrence.idempotencyKey, occurrence.requestId, occurrence.executorGeneration, iso(input.now),
      );
      db.prepare(
        "INSERT INTO work_producer_dispatch (occurrence_id, state, next_attempt_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(occurrence.occurrenceId, input.state, iso(input.now), iso(input.now));
      created = true;
      input.alsoInTransaction?.();
    }
    if (input.statePatch && occurrence.scheduleId) updateState(occurrence.scheduleId, input.statePatch);
    const recorded = getOccurrence(occurrence.occurrenceId)!;
    return { ...recorded, created };
  }).immediate();
}

/**
 * Move an occurrence to `dispatching` for this process, or null when it is not
 * dispatchable now (already accepted, refused, owned by another live
 * dispatcher, or not yet due). `pending` and `unknown` are dispatchable; for
 * `unknown`, the dispatcher must observe the original key before redelivering.
 */
export function beginDispatch(occurrenceId: string, runner: { pid: number; startedAt: number | null }, now: Date): OccurrenceDispatch | null {
  const db = getDb();
  return db.transaction(() => {
    const changed = db.prepare(
      `UPDATE work_producer_dispatch SET state = 'dispatching', attempts = attempts + 1, dispatcher_pid = ?, dispatcher_started_at = ?, updated_at = ?
        WHERE occurrence_id = ? AND state IN ('pending', 'unknown') AND next_attempt_at <= ?`,
    ).run(runner.pid, runner.startedAt, iso(now), occurrenceId, iso(now)).changes;
    if (changed !== 1) return null;
    return getOccurrence(occurrenceId)!.dispatch;
  }).immediate();
}

/**
 * Bind the authority reference and request hash an occurrence is submitted
 * under. Set once: a later preparation that returns a different binding is
 * refused, so one occurrence can never be presented as two intents.
 */
export function bindAuthority(occurrenceId: string, binding: { authorityRef: string; requestHash: string }, now: Date): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT authority_ref, request_hash FROM work_producer_dispatch WHERE occurrence_id = ?").get(occurrenceId) as
      | { authority_ref: string | null; request_hash: string | null }
      | undefined;
    if (!row) throw new Error(`occurrence ${occurrenceId} is not recorded`);
    if (row.authority_ref !== null && row.authority_ref !== binding.authorityRef) throw new DispatchBindingError(occurrenceId, "authority reference");
    if (row.request_hash !== null && row.request_hash !== binding.requestHash) throw new DispatchBindingError(occurrenceId, "request hash");
    if (row.authority_ref === null || row.request_hash === null) {
      db.prepare("UPDATE work_producer_dispatch SET authority_ref = ?, request_hash = ?, updated_at = ? WHERE occurrence_id = ?")
        .run(binding.authorityRef, binding.requestHash, iso(now), occurrenceId);
    }
  }).immediate();
}

/** The owner (or the legacy runner) accepted it. Idempotent for the same work id. */
export function markAccepted(occurrenceId: string, accepted: { workId: string; workflowId: string | null }, now: Date): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT state, work_id FROM work_producer_dispatch WHERE occurrence_id = ?").get(occurrenceId) as
      | { state: DispatchState; work_id: string | null }
      | undefined;
    if (!row) throw new Error(`occurrence ${occurrenceId} is not recorded`);
    if (row.work_id !== null && row.work_id !== accepted.workId) throw new DispatchBindingError(occurrenceId, "work id");
    if (row.state === "accepted") return;
    if (!["dispatching", "unknown"].includes(row.state)) throw new Error(`occurrence ${occurrenceId} is ${row.state}, not awaiting admission`);
    db.prepare(
      `UPDATE work_producer_dispatch SET state = 'accepted', work_id = ?, workflow_id = ?, last_error_code = NULL, last_error = NULL,
         dispatcher_pid = NULL, dispatcher_started_at = NULL, updated_at = ? WHERE occurrence_id = ?`,
    ).run(accepted.workId, accepted.workflowId, iso(now), occurrenceId);
  }).immediate();
}

/**
 * Admission may have happened and was not confirmed: keep the original key and
 * observe it again at `retryAt`. Never a reason to start replacement work.
 */
export function markUnknown(occurrenceId: string, error: { code: string; message: string }, retryAt: Date, now: Date): void {
  getDb().prepare(
    `UPDATE work_producer_dispatch SET state = 'unknown', last_error_code = ?, last_error = ?, next_attempt_at = ?,
       dispatcher_pid = NULL, dispatcher_started_at = NULL, updated_at = ?
      WHERE occurrence_id = ? AND state IN ('dispatching', 'unknown')`,
  ).run(error.code, error.message.slice(0, 2000), iso(retryAt), iso(now), occurrenceId);
}

/** The owner refused this exact intent. Terminal for the producer; a human decides what next. */
export function markRefused(occurrenceId: string, error: { code: string; message: string }, now: Date): void {
  getDb().prepare(
    `UPDATE work_producer_dispatch SET state = 'refused', last_error_code = ?, last_error = ?, dispatcher_pid = NULL, dispatcher_started_at = NULL, updated_at = ?
      WHERE occurrence_id = ? AND state IN ('pending', 'dispatching', 'unknown')`,
  ).run(error.code, error.message.slice(0, 2000), iso(now), occurrenceId);
}

/**
 * Occurrences due for (re)delivery, oldest first: `pending`, and `unknown`
 * whose retry time has come. `generation` narrows to one executor generation.
 */
export function dueOccurrences(now: Date, limit: number, generation?: ExecutorGeneration): ProducerOccurrence[] {
  if (limit <= 0) return [];
  const rows = getDb().prepare(
    `SELECT o.* FROM work_producer_occurrence o JOIN work_producer_dispatch d ON d.occurrence_id = o.occurrence_id
      WHERE d.state IN ('pending', 'unknown') AND d.next_attempt_at <= ?${generation ? " AND o.executor_generation = ?" : ""}
      ORDER BY o.created_at, o.occurrence_id LIMIT ?`,
  ).all(...(generation ? [iso(now), generation, limit] : [iso(now), limit])) as OccurrenceRow[];
  return rows.map(toOccurrence);
}

/** The queued re-run a schedule already owes, if any (overlap `queue`). */
export function owedQueuedOccurrence(scheduleId: string): ProducerOccurrence | null {
  const row = getDb().prepare(
    `SELECT o.* FROM work_producer_occurrence o JOIN work_producer_dispatch d ON d.occurrence_id = o.occurrence_id
      WHERE o.schedule_id = ? AND o.kind = 'queued' AND d.state = 'pending' ORDER BY o.created_at LIMIT 1`,
  ).get(scheduleId) as OccurrenceRow | undefined;
  return row ? toOccurrence(row) : null;
}

/**
 * `dispatching` rows a different process left behind. The caller decides,
 * per executor generation, whether the original intent can be observed and
 * redelivered (Work, or an idempotent legacy job) or must stay unknown.
 */
export function abandonedDispatches(self: { pid: number }): Array<{ occurrence: ProducerOccurrence; dispatch: OccurrenceDispatch }> {
  const rows = getDb().prepare(
    "SELECT occurrence_id FROM work_producer_dispatch WHERE state = 'dispatching' AND (dispatcher_pid IS NULL OR dispatcher_pid != ?) ORDER BY updated_at",
  ).all(self.pid) as Array<{ occurrence_id: string }>;
  return rows.map((r) => getOccurrence(r.occurrence_id)!);
}

/** Record how an accepted occurrence ended for its schedule (legacy runners report this). */
export function recordOutcome(occurrenceId: string, outcome: "complete" | "failed", now: Date): void {
  getDb().prepare("UPDATE work_producer_dispatch SET outcome = ?, updated_at = ? WHERE occurrence_id = ? AND outcome IS NULL")
    .run(outcome, iso(now), occurrenceId);
}

export interface PendingNotification {
  notificationKey: string;
  scheduleId: string;
  transition: "failure" | "recovery";
  occurrenceId: string;
  failures: number;
  lastSummary: string | null;
  attempts: number;
}

/**
 * Commit the notification a failure or recovery transition owes, separately
 * from the work. A failure opens a streak row keyed by its first failing
 * occurrence; later failures in the same streak update that row (grouped), so
 * a flapping schedule produces one failure notice and one recovery notice.
 */
export function recordNotificationIntent(input: {
  scheduleId: string;
  occurrenceId: string;
  outcome: "complete" | "failed";
  summary: string;
  now: Date;
}): PendingNotification | null {
  const db = getDb();
  return db.transaction(() => {
    const open = db.prepare(
      `SELECT * FROM work_producer_notification WHERE schedule_id = ? AND transition = 'failure'
         AND NOT EXISTS (SELECT 1 FROM work_producer_notification r WHERE r.schedule_id = work_producer_notification.schedule_id
                          AND r.transition = 'recovery' AND r.created_at >= work_producer_notification.created_at)
       ORDER BY created_at DESC LIMIT 1`,
    ).get(input.scheduleId) as NotificationRow | undefined;
    if (input.outcome === "failed") {
      if (open) {
        db.prepare("UPDATE work_producer_notification SET failures = failures + 1, last_summary = ?, updated_at = ? WHERE notification_key = ?")
          .run(input.summary.slice(0, 2000), iso(input.now), open.notification_key);
        return null;
      }
      const key = `${input.scheduleId}:failure:${input.occurrenceId}`;
      db.prepare(
        `INSERT INTO work_producer_notification (notification_key, schedule_id, transition, occurrence_id, failures, last_summary, created_at, updated_at)
         VALUES (?, ?, 'failure', ?, 1, ?, ?, ?) ON CONFLICT(notification_key) DO NOTHING`,
      ).run(key, input.scheduleId, input.occurrenceId, input.summary.slice(0, 2000), iso(input.now), iso(input.now));
      return toNotification(db.prepare("SELECT * FROM work_producer_notification WHERE notification_key = ?").get(key) as NotificationRow);
    }
    // Only a streak someone was told about gets a recovery notice.
    if (!open || open.delivered_at === null) {
      if (open) db.prepare("DELETE FROM work_producer_notification WHERE notification_key = ?").run(open.notification_key);
      return null;
    }
    const key = `${input.scheduleId}:recovery:${input.occurrenceId}`;
    db.prepare(
      `INSERT INTO work_producer_notification (notification_key, schedule_id, transition, occurrence_id, failures, last_summary, created_at, updated_at)
       VALUES (?, ?, 'recovery', ?, 0, ?, ?, ?) ON CONFLICT(notification_key) DO NOTHING`,
    ).run(key, input.scheduleId, input.occurrenceId, input.summary.slice(0, 2000), iso(input.now), iso(input.now));
    return toNotification(db.prepare("SELECT * FROM work_producer_notification WHERE notification_key = ?").get(key) as NotificationRow);
  }).immediate();
}

interface NotificationRow {
  notification_key: string;
  schedule_id: string;
  transition: "failure" | "recovery";
  occurrence_id: string;
  failures: number;
  last_summary: string | null;
  delivered_at: string | null;
  attempts: number;
  created_at: string;
}

function toNotification(row: NotificationRow): PendingNotification {
  return {
    notificationKey: row.notification_key,
    scheduleId: row.schedule_id,
    transition: row.transition,
    occurrenceId: row.occurrence_id,
    failures: row.failures,
    lastSummary: row.last_summary,
    attempts: row.attempts,
  };
}

/** Notifications not yet delivered, oldest first. */
export function pendingNotifications(limit = 50): PendingNotification[] {
  return (getDb().prepare("SELECT * FROM work_producer_notification WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?")
    .all(Math.min(Math.max(limit, 1), 500)) as NotificationRow[]).map(toNotification);
}

/** Record one delivery attempt; delivered notices are never sent again. */
export function settleNotification(notificationKey: string, delivered: boolean, now: Date): void {
  getDb().prepare(
    `UPDATE work_producer_notification SET attempts = attempts + 1, delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END, updated_at = ?
      WHERE notification_key = ? AND delivered_at IS NULL`,
  ).run(delivered ? 1 : 0, iso(now), iso(now), notificationKey);
}

/**
 * Bounded retention. Settled occurrences (accepted with an outcome, refused,
 * skipped, missed, coalesced) older than `before` go; anything that may still
 * be awaiting admission (`pending`, `dispatching`, `unknown`) and accepted
 * occurrences without an outcome are kept, however old — they are the
 * evidence recovery needs.
 */
export function pruneOccurrences(before: Date): number {
  const db = getDb();
  return db.transaction(() => {
    const old = (db.prepare(
      `SELECT d.occurrence_id FROM work_producer_dispatch d
        WHERE d.updated_at < ? AND (d.state IN ('refused', 'skipped', 'missed', 'coalesced') OR (d.state = 'accepted' AND d.outcome IS NOT NULL))`,
    ).all(iso(before)) as Array<{ occurrence_id: string }>).map((r) => r.occurrence_id);
    for (const id of old) {
      db.prepare("DELETE FROM work_producer_dispatch WHERE occurrence_id = ?").run(id);
      db.prepare("DELETE FROM work_producer_occurrence WHERE occurrence_id = ?").run(id);
    }
    db.prepare("DELETE FROM work_producer_notification WHERE delivered_at IS NOT NULL AND updated_at < ?").run(iso(before));
    return old.length;
  })();
}

/**
 * The definition a schedule's payload is, qualified the way its runners
 * qualify it. An inline action has no catalog reference; it is identified by
 * its manifest digest and can only run on the legacy generation.
 */
export function scheduleDefinition(entry: ScheduleEntry): OccurrenceDefinition {
  const { payload } = entry.schedule;
  switch (payload.kind) {
    case "ref": {
      const reference = payload.ref.includes(":") ? payload.ref : `${entry.bag}:${payload.ref}`;
      return { kind: "action", reference, catalog_namespace: reference.slice(0, reference.indexOf(":")) };
    }
    case "job":
      return { kind: "job", reference: scheduleJobRef(entry) };
    case "inline":
      return { kind: "inline", manifest_digest: createHash("sha256").update(JSON.stringify(payload.manifest)).digest("hex") };
  }
}

/**
 * Whether an occurrence of this schedule could be submitted to Work at all:
 * Work admits catalog actions and VERSIONED jobs. An inline action or an
 * unversioned job ref is a legacy-only occurrence until a contract for it
 * exists; the reason says which.
 */
export function workEligibility(entry: ScheduleEntry): { eligible: true } | { eligible: false; reason: string } {
  const definition = scheduleDefinition(entry);
  if (definition.kind === "inline") return { eligible: false, reason: "inline actions have no Work definition" };
  if (definition.kind === "job" && !/@[1-9][0-9]*$/.test(definition.reference)) return { eligible: false, reason: "Work admits versioned jobs only" };
  return { eligible: true };
}

/** The schedule context an occurrence records: what the schedule selected, never more. */
export function scheduleOccurrenceContext(entry: ScheduleEntry, identityId: number | null = null): OccurrenceContext {
  const bags = [...(entry.schedule.bags ?? (entry.schedule as { traits?: string[] }).traits ?? [])];
  return {
    identity: entry.schedule.identity ?? null,
    identity_id: identityId,
    traits: bags,
    bounds: [...(entry.schedule.bounds ?? [])],
  };
}

/** Build the occurrence a schedule owes for one slot, login event or manual run. */
export function newScheduleOccurrence(input: {
  entry: ScheduleEntry;
  kind: Exclude<OccurrenceKind, "one_off">;
  discriminator: Date | string;
  policy: Omit<OccurrencePolicy, "catch_up" | "overlap">;
  generation: ExecutorGeneration;
  identityId?: number | null;
}): NewOccurrence {
  const { entry } = input;
  const slotAt = input.discriminator instanceof Date ? input.discriminator : null;
  return {
    occurrenceId: scheduleOccurrenceId(entry.id, input.kind, input.discriminator),
    producerRef: scheduleProducerRef(entry.id),
    scheduleId: entry.id,
    oneOffId: null,
    kind: input.kind,
    slotAt,
    timezone: entry.schedule.trigger.kind === "cron" ? (entry.schedule.trigger.timezone ?? "UTC") : slotAt ? "UTC" : null,
    // scheduler.ts triggerKey's spelling (not imported: the scheduler imports this module).
    triggerKey: JSON.stringify(entry.schedule.trigger),
    policy: { catch_up: entry.schedule.catchUp, overlap: entry.schedule.overlap, ...input.policy },
    context: scheduleOccurrenceContext(entry, input.identityId ?? null),
    definition: scheduleDefinition(entry),
    inputs: entry.schedule.inputs ?? {},
    executorGeneration: input.generation,
  };
}

/**
 * Claim a login event for a schedule and record its occurrence in one
 * transaction, or null when the event was already claimed (by this path or
 * the legacy one). The claim and the occurrence cannot exist without each
 * other, so a crash after the claim no longer loses the run.
 */
export function claimLoginOccurrence(occurrence: NewOccurrence, eventId: string, now: Date): ReturnType<typeof recordOccurrence> | null {
  if (!occurrence.scheduleId || occurrence.kind !== "login") throw new Error("a login occurrence belongs to a schedule");
  const scheduleId = occurrence.scheduleId;
  const db = getDb();
  return db.transaction(() => {
    const claimed = db.prepare("INSERT INTO login_event_claims (schedule_id, event_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(scheduleId, eventId, now.toISOString()).changes === 1;
    if (!claimed) return null;
    return recordOccurrence({ occurrence, state: "pending", statePatch: { last_fired_at: now }, now });
  }).immediate();
}

/**
 * The occurrence an at-schedule row becomes (P4.4 preparation): one per row, keyed
 * by the creator's idempotency key when it gave one — so the key a caller
 * already retries with is the key Work sees — and by the row id otherwise.
 * The at-schedule's explicit failure-retry budget has no Work equivalent yet;
 * after admission the owner alone decides retries (see the P4 contract
 * requests), so adopting an at-schedule with `retryAttempts > 1` is refused
 * rather than silently dropping the budget.
 */
export function oneOffOccurrence(oneOff: AtSchedule, generation: ExecutorGeneration): NewOccurrence {
  if (generation === "work.v2" && oneOff.retryAttempts > 1) {
    throw new Error(`one-off ${oneOff.id} asks for ${oneOff.retryAttempts} attempts; Work admission has no producer retry budget yet`);
  }
  if (generation === "work.v2" && oneOff.callerSessionId !== null) {
    throw new Error(`one-off ${oneOff.id} was requested by session ${oneOff.callerSessionId}; its authority is the session's, not a producer's`);
  }
  const action = oneOff.action === null ? null : oneOff.action.includes(":") ? oneOff.action : `${oneOff.bag}:${oneOff.action}`;
  const definition: OccurrenceDefinition = oneOff.job
    ? { kind: "job", reference: oneOff.job }
    : action
      ? { kind: "action", reference: action, catalog_namespace: action.slice(0, action.indexOf(":")) }
      : { kind: "inline", manifest_digest: createHash("sha256").update(JSON.stringify(oneOff.inlineAction)).digest("hex") };
  const occurrenceId = oneOffOccurrenceId(oneOff.id);
  return {
    occurrenceId,
    producerRef: scheduleProducerRef(`once:${oneOff.bag}`),
    scheduleId: null,
    oneOffId: oneOff.id,
    kind: "one_off",
    slotAt: oneOff.dueAt,
    timezone: "UTC",
    triggerKey: null,
    policy: { catch_up: "once", overlap: "queue", late: false, coalesced_slots: 1 },
    context: {
      identity: oneOff.permissions.identity ?? null,
      identity_id: oneOff.permissions.identityId ?? null,
      traits: [...(oneOff.permissions.bags ?? oneOff.permissions.traits ?? [])],
      bounds: [...(oneOff.permissions.bounds ?? [])],
    },
    definition,
    inputs: oneOff.inputs,
    executorGeneration: generation,
    idempotencyKey: occurrenceIdempotencyKey(oneOff.idempotencyKey ? `once:${oneOff.bag}:${oneOff.idempotencyKey}` : occurrenceId),
  };
}
