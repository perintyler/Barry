/**
 * One-off schedules: run an action once, later, with inputs.
 *
 * This is the programmatic half of Schedules — what a bag's code asks for
 * with `barry.schedules.schedule(when, {...})` ("check again in ten
 * minutes"), and what `create_schedule` stores for an `at:` trigger. It
 * replaced the services bag's scheduled-work store and keeps every guarantee
 * that store made:
 *
 * - **At least once.** Accepted work is persisted before the caller is
 *   answered. If the runner dies mid-attempt the outcome is unknown and the
 *   work runs again (up to MAX_RECOVERIES); handlers dedupe on
 *   BARRY_SCHEDULE_ID.
 * - **Idempotent creation.** A key is unique per bag; repeating a request
 *   returns the schedule it made, and reusing a key for a different request
 *   is refused.
 * - **No retry of a failure unless asked.** `retry_attempts` opts in, with
 *   exponential backoff and jitter, counted in the store so a restart does not
 *   reset it.
 * - **Identity, not hope.** Whether a dead runner's attempt is still going is
 *   decided by process identity (pid + start time). When that cannot be told,
 *   the schedule ends `uncertain` rather than risk a second copy running.
 *
 * Every state change is one guarded UPDATE, so a stale writer cannot record an
 * outcome over the one that replaced it.
 *
 * A one-off runs one of three things: an action by name, an inline action, or
 * a job (`bag:name`). Job one-offs are how a job runs locally — the SDK's
 * `jobs.run`, a schedule's `job:` — and they draw on their own concurrency
 * budget (`kind`), so a burst of SDK calls cannot starve a schedule's
 * one-offs or the other way round.
 */

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { killGroup } from "./process.js";

export const MAX_RECOVERIES = 3;
export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 3_600;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_RETRY_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 30_000;
/** How long past its timeout an attempt may still be going before it is presumed stuck. */
export const hardCeilingMs = (timeoutS: number) => timeoutS * 1000 + 120_000;

export type AtScheduleStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain";
export type AttemptOutcome = "running" | "succeeded" | "failed" | "timed_out" | "abandoned";

export interface AtScheduleAttempt {
  id: string;
  number: number;
  runId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: AttemptOutcome;
  exitCode: number | null;
}

export interface SchedulePermissions {
  identity?: string;
  identityId?: number;
  bags?: string[];
  bounds?: string[];
  traits?: string[];
}
export interface AtSchedule {
  permissions: SchedulePermissions;
  id: string;
  bag: string;
  action: string | null;
  inlineAction: Record<string, unknown> | null;
  /** `bag:name[@version]` of a job, or null for an action schedule. */
  job: string | null;
  /**
   * The session that asked for this run, when one did. Its presence is what
   * withholds bag authority: a session-started job gets no declared secrets.
   */
  callerSessionId: string | null;
  /** Set when a cancel arrived while an attempt was running. */
  cancelRequestedAt: Date | null;
  inputs: Record<string, unknown>;
  dueAt: Date;
  createdAt: Date;
  updatedAt: Date;
  status: AtScheduleStatus;
  reason: string | null;
  idempotencyKey: string | null;
  timeoutS: number;
  retryAttempts: number;
  failures: number;
  recoveries: number;
  createdBy: string | null;
  attempts?: AtScheduleAttempt[];
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/** Inputs over MAX_INPUT_BYTES of JSON: refused before anything is stored. */
export class InputTooLargeError extends Error {
  constructor(bytes: number) {
    super(`inputs are ${bytes} bytes of JSON, over the ${MAX_INPUT_BYTES}-byte limit`);
    this.name = "InputTooLargeError";
  }
}

/** Which concurrency budget an at-schedule draws on. */
export type AtScheduleKind = "action" | "job";

export interface CreateAtScheduleInput {
  permissions?: SchedulePermissions;
  bag: string;
  /** `bag:name`, or null with `inlineAction` or `job`. */
  action: string | null;
  inlineAction?: Record<string, unknown> | null;
  /** `bag:name[@version]` of the job to run, instead of an action. */
  job?: string | null;
  callerSessionId?: string | null;
  inputs?: Record<string, unknown>;
  dueAt: Date;
  idempotencyKey?: string;
  timeoutS?: number;
  retryAttempts?: number;
  createdBy?: string | null;
}

interface AtScheduleRow {
  permissions_json: string;
  id: string;
  bag: string;
  action: string | null;
  inline_action: string | null;
  job: string | null;
  caller_session_id: string | null;
  cancel_requested_at: string | null;
  inputs_json: string;
  due_at: string;
  created_at: string;
  updated_at: string;
  status: AtScheduleStatus;
  reason: string | null;
  idempotency_key: string | null;
  request_hash: string;
  timeout_s: number;
  retry_attempts: number;
  failures: number;
  recoveries: number;
  created_by: string | null;
}

interface AttemptRow {
  id: string;
  one_off_id: string;
  number: number;
  run_id: string | null;
  started_at: string;
  finished_at: string | null;
  outcome: AttemptOutcome;
  exit_code: number | null;
  runner_pid: number;
  runner_started_at: number | null;
  process_group: number | null;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const iso = (d: Date) => d.toISOString();

function toAttempt(row: AttemptRow): AtScheduleAttempt {
  return {
    id: row.id,
    number: row.number,
    runId: row.run_id,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    outcome: row.outcome,
    exitCode: row.exit_code,
  };
}

function normalizePermissions(raw: SchedulePermissions): SchedulePermissions {
  if (raw.bags === undefined && Array.isArray(raw.traits)) {
    const bags: string[] = [];
    const bounds: string[] = [...(raw.bounds ?? [])];
    for (const entry of raw.traits) {
      if (entry.endsWith(":read") && entry.length > ":read".length) {
        const bag = entry.slice(0, -":read".length);
        if (!bags.includes(bag)) bags.push(bag);
        if (!bounds.includes(entry)) bounds.push(entry);
      } else if (entry && !bags.includes(entry)) {
        bags.push(entry);
      }
    }
    const { traits: _traits, ...rest } = raw;
    return {
      ...rest,
      bags,
      ...(bounds.length > 0 || raw.bounds !== undefined ? { bounds } : {}),
    };
  }
  return raw;
}

function toAtSchedule(row: AtScheduleRow, attempts?: AttemptRow[]): AtSchedule {
  return {
    id: row.id,
    bag: row.bag,
    action: row.action,
    inlineAction: row.inline_action ? (JSON.parse(row.inline_action) as Record<string, unknown>) : null,
    job: row.job,
    callerSessionId: row.caller_session_id,
    cancelRequestedAt: row.cancel_requested_at ? new Date(row.cancel_requested_at) : null,
    permissions: normalizePermissions(JSON.parse(row.permissions_json) as SchedulePermissions),
    inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
    dueAt: new Date(row.due_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    status: row.status,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    timeoutS: row.timeout_s,
    retryAttempts: row.retry_attempts,
    failures: row.failures,
    recoveries: row.recoveries,
    createdBy: row.created_by,
    ...(attempts ? { attempts: attempts.map(toAttempt) } : {}),
  };
}

function requestHash(i: CreateAtScheduleInput & { timeoutS: number; retryAttempts: number }): string {
  // A job run is asked for "now", so its due time is when the request
  // arrived, not part of what was requested: a retried request must replay.
  const fields: unknown[] = [i.bag, i.action, i.inlineAction ?? null, i.inputs ?? {}, i.job ? null : iso(i.dueAt), i.timeoutS, i.retryAttempts, i.permissions ?? {}];
  // Appended only when present, so an action schedule stored before jobs
  // existed still hashes the way it did and its key still replays.
  if (i.job || i.callerSessionId) fields.push({ job: i.job ?? null, caller: i.callerSessionId ?? null });
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/**
 * Accept an at-schedule. With an idempotency key, repeating the same request
 * returns the one it created (`created: false`); the same key for a different
 * request throws IdempotencyConflictError.
 */
export function createAtSchedule(input: CreateAtScheduleInput, now = new Date()): { schedule: AtSchedule; oneOff: AtSchedule; created: boolean } {
  const payloads = [input.action, input.inlineAction, input.job].filter((p) => p !== null && p !== undefined).length;
  if (payloads !== 1) throw new Error("a one-off runs exactly one of an action, an inline action or a job");
  // Here rather than only in the API: every creator — the API, a schedule's
  // `job:`, a test — stores inputs through this function.
  const inputBytes = Buffer.byteLength(JSON.stringify(input.inputs ?? {}));
  if (inputBytes > MAX_INPUT_BYTES) throw new InputTooLargeError(inputBytes);
  const db = getDb();
  const timeoutS = input.timeoutS ?? DEFAULT_TIMEOUT_S;
  const retryAttempts = input.retryAttempts ?? 1;
  const hash = requestHash({ ...input, timeoutS, retryAttempts });

  const existing = () =>
    input.idempotencyKey
      ? (db.prepare("SELECT * FROM one_off WHERE bag = ? AND idempotency_key = ?").get(input.bag, input.idempotencyKey) as AtScheduleRow | undefined)
      : undefined;
  const replay = (row: AtScheduleRow) => {
    if (row.request_hash !== hash) {
      throw new IdempotencyConflictError(
        `idempotency key "${input.idempotencyKey}" was already used for a different request in bag "${input.bag}"`,
      );
    }
    const schedule = getAtSchedule(row.id) as AtSchedule;
    return { schedule, oneOff: schedule, created: false };
  };

  const found = existing();
  if (found) return replay(found);

  const id = newId("sch");
  try {
    db.prepare(
      `INSERT INTO one_off (id, bag, action, inline_action, job, caller_session_id, inputs_json, due_at, created_at, updated_at, status,
         idempotency_key, request_hash, timeout_s, retry_attempts, created_by, permissions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.bag, input.action, input.inlineAction ? JSON.stringify(input.inlineAction) : null,
      input.job ?? null, input.callerSessionId ?? null,
      JSON.stringify(input.inputs ?? {}), iso(input.dueAt), iso(now), iso(now),
      input.idempotencyKey ?? null, hash, timeoutS, retryAttempts, input.createdBy ?? null, JSON.stringify(input.permissions ?? {}),
    );
  } catch (error) {
    // Two creators racing on one key: the loser reads the winner's row.
    const raced = String((error as { code?: string }).code ?? "").startsWith("SQLITE_CONSTRAINT") ? existing() : undefined;
    if (raced) return replay(raced);
    throw error;
  }
  const schedule = getAtSchedule(id) as AtSchedule;
  return { schedule, oneOff: schedule, created: true };
}

export function getAtSchedule(id: string): AtSchedule | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM one_off WHERE id = ?").get(id) as AtScheduleRow | undefined;
  if (!row) return null;
  const attempts = db.prepare("SELECT * FROM one_off_attempt WHERE one_off_id = ? ORDER BY number").all(id) as AttemptRow[];
  return toAtSchedule(row, attempts);
}

export function listAtSchedules(options: { bag?: string; status?: AtScheduleStatus; limit?: number } = {}): AtSchedule[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (options.bag) { where.push("bag = ?"); args.push(options.bag); }
  if (options.status) { where.push("status = ?"); args.push(options.status); }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = getDb()
    .prepare(`SELECT * FROM one_off ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit) as AtScheduleRow[];
  return rows.map((r) => toAtSchedule(r));
}

/**
 * Stop an at-schedule. One that has not started is cancelled outright. One that is
 * running is marked, and its script's process group is handed to `kill`: the
 * attempt then closes `cancelled` when its runner records it, rather than
 * failed or retried. An agent attempt has no group here; it is marked, and
 * ends cancelled whenever it finishes. Anything else is reported, not changed.
 */
export function cancelAtSchedule(
  id: string,
  now = new Date(),
  kill: (processGroup: number | null) => void = (group) => killGroup(group, 5_000),
): { cancelled: boolean; status: AtScheduleStatus; cancelRequested?: boolean } | null {
  const db = getDb();
  const changed = db
    .prepare("UPDATE one_off SET status = 'cancelled', reason = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(iso(now), id).changes;
  if (changed === 0) {
    const marked = db
      .prepare("UPDATE one_off SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ? WHERE id = ? AND status = 'running'")
      .run(iso(now), iso(now), id).changes === 1;
    if (marked) {
      const attempt = db
        .prepare("SELECT process_group FROM one_off_attempt WHERE one_off_id = ? AND outcome = 'running' ORDER BY number DESC LIMIT 1")
        .get(id) as { process_group: number | null } | undefined;
      kill(attempt?.process_group ?? null);
      return { cancelled: false, status: "running", cancelRequested: true };
    }
  }
  const row = db.prepare("SELECT status FROM one_off WHERE id = ?").get(id) as { status: AtScheduleStatus } | undefined;
  return row ? { cancelled: changed === 1, status: row.status } : null;
}

/** The SQL that selects one budget's schedules. */
const kindClause = (kind: AtScheduleKind | undefined) => kind === "job" ? " AND job IS NOT NULL" : kind === "action" ? " AND job IS NULL" : "";

export function countRunning(kind?: AtScheduleKind): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM one_off WHERE status = 'running'${kindClause(kind)}`).get() as { n: number }).n;
}

interface Runner {
  now: Date;
  runnerPid: number;
  runnerStartedAt: number | null;
}

/**
 * Claim one schedule for this runner, or null. A guarded `pending → running`:
 * the SELECT that found it due proves nothing by itself, since a cancel can
 * land between the two — whichever write lands first wins, never both.
 */
export interface Claim {
  schedule: AtSchedule;
  oneOff: AtSchedule;
  attemptId: string;
  /** 1 for the first attempt; a retry or a recovery counts up. */
  attempt: number;
}

export function claimOne(id: string, runner: Runner): Claim | null {
  const db = getDb();
  return db.transaction(() => {
    const won = db
      .prepare("UPDATE one_off SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(iso(runner.now), id).changes === 1;
    if (!won) return null;
    const row = db.prepare("SELECT * FROM one_off WHERE id = ?").get(id) as AtScheduleRow;
    const attemptId = newId("att");
    const attempt = row.failures + row.recoveries + 1;
    db.prepare(
      `INSERT INTO one_off_attempt (id, one_off_id, number, started_at, outcome, runner_pid, runner_started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    ).run(attemptId, id, attempt, iso(runner.now), runner.runnerPid, runner.runnerStartedAt);
    const schedule = toAtSchedule(row);
    return { schedule, oneOff: schedule, attemptId, attempt };
  }).immediate();
}

/** Ids of pending schedules that are due, oldest first; `kind` limits them to one budget. */
export function dueIds(now: Date, limit: number, kind?: AtScheduleKind): string[] {
  if (limit <= 0) return [];
  return (getDb()
    .prepare(`SELECT id FROM one_off WHERE status = 'pending' AND due_at <= ?${kindClause(kind)} ORDER BY due_at, id LIMIT ?`)
    .all(iso(now), limit) as Array<{ id: string }>).map((r) => r.id);
}

/** Claim what is due for this runner, up to `limit`, from one budget when `kind` is given. */
export function claimDue(options: Runner & { limit: number; kind?: AtScheduleKind }): Claim[] {
  return dueIds(options.now, options.limit, options.kind)
    .map((id) => claimOne(id, options))
    .filter((c): c is Claim => c !== null);
}

/** What an attempt is running as: its action run, and the script's process group. */
export function recordAttempt(attemptId: string, fields: { runId?: string; processGroup?: number }): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.runId !== undefined) { sets.push("run_id = ?"); args.push(fields.runId); }
  if (fields.processGroup !== undefined) { sets.push("process_group = ?"); args.push(fields.processGroup); }
  if (!sets.length) return;
  getDb().prepare(`UPDATE one_off_attempt SET ${sets.join(", ")} WHERE id = ? AND outcome = 'running'`).run(...args, attemptId);
}

/** Exponential from 30 s, ±20% jitter so retries of many schedules do not align. */
export function backoffMs(failures: number, random = Math.random): number {
  return Math.round(BACKOFF_BASE_MS * 2 ** (failures - 1) * (0.8 + 0.4 * random()));
}

export type FinishOutcome = "succeeded" | "failed" | "timed_out" | "unavailable" | "validation_failed";

/**
 * Record how an attempt ended. `unavailable` (the action is gone, or refuses
 * the inputs) and `validation_failed` (the work ran, but its output or its
 * `validate:` check says it did not do the job) fail without retry: running
 * it again cannot change the answer. An attempt that ends after a cancel was
 * requested ends the one-off `cancelled`, whatever it reported.
 * Returns false, changing nothing, when the attempt was already closed.
 */
export function finishAttempt(options: {
  scheduleId?: string;
  oneOffId?: string;
  attemptId: string;
  outcome: FinishOutcome;
  exitCode?: number | null;
  runId?: string | null;
  reason?: string;
  now?: Date;
  random?: () => number;
}): boolean {
  const db = getDb();
  const now = options.now ?? new Date();
  const scheduleId = options.scheduleId ?? options.oneOffId ?? "";
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM one_off WHERE id = ? AND status = 'running'").get(scheduleId) as AtScheduleRow | undefined;
    if (!row) return false;
    const attemptOutcome: AttemptOutcome = options.outcome === "unavailable" || options.outcome === "validation_failed" ? "failed" : options.outcome;
    const closed = db
      .prepare(
        `UPDATE one_off_attempt SET outcome = ?, exit_code = ?, finished_at = ?, run_id = COALESCE(?, run_id)
         WHERE id = ? AND outcome = 'running'`,
      )
      .run(attemptOutcome, options.exitCode ?? null, iso(now), options.runId ?? null, options.attemptId).changes;
    if (closed !== 1) return false;

    if (row.cancel_requested_at) {
      db.prepare("UPDATE one_off SET status = 'cancelled', reason = 'cancelled while running', updated_at = ? WHERE id = ?").run(iso(now), row.id);
      return true;
    }
    if (options.outcome === "succeeded") {
      db.prepare("UPDATE one_off SET status = 'succeeded', reason = NULL, updated_at = ? WHERE id = ?").run(iso(now), row.id);
      return true;
    }
    const failures = row.failures + 1;
    const why = options.reason ?? (options.outcome === "timed_out" ? `timed out after ${row.timeout_s}s` : `exited ${options.exitCode}`);
    const final = options.outcome === "unavailable" || options.outcome === "validation_failed";
    if (!final && failures < row.retry_attempts) {
      const next = new Date(now.getTime() + backoffMs(failures, options.random));
      db.prepare("UPDATE one_off SET status = 'pending', failures = ?, reason = ?, due_at = ?, updated_at = ? WHERE id = ?")
        .run(failures, `attempt ${failures} ${why}; retrying`, iso(next), iso(now), row.id);
    } else {
      db.prepare("UPDATE one_off SET status = 'failed', failures = ?, reason = ?, updated_at = ? WHERE id = ?")
        .run(failures, why, iso(now), row.id);
    }
    return true;
  }).immediate();
}

export type RecoveryAction = "left-alive" | "requeued" | "uncertain" | "finalized";

export interface RecoveryDeps {
  /** This runner's pid: its own running attempts are in memory, not orphans. */
  selfPid: number;
  probe: (pid: number, startedAt: number | null) => "alive" | "gone" | "unknown";
  kill: (processGroup: number | null) => void;
  /**
   * The closed outcome of the attempt's action run, if it finished anyway —
   * an agent run keeps going in the API after the runner that asked for it
   * died. Null while that run is open or does not exist.
   */
  closedRun: (oneOffId: string, attempt: { runId: string | null; startedAt: Date }) => { runId: string; succeeded: boolean; exitCode: number | null; summary: string | null } | null;
  /** Whether the attempt's action run exists and is still open. */
  openRun: (oneOffId: string, attempt: { runId: string | null; startedAt: Date }) => boolean;
  now?: Date;
}

/**
 * Settle running schedules whose runner is not this process — a scheduler that
 * died, or was restarted, mid-attempt.
 *
 * In order: a run that finished anyway is recorded as its outcome. A runner
 * still alive is left alone (two schedulers must not both act). A dead
 * runner's script group is killed — so re-running cannot overlap it — and the
 * work is re-queued within the recovery budget, or marked `uncertain`. When
 * identity cannot be read, or an agent run is still open past the ceiling,
 * the answer is `uncertain`: starting a second copy of work that may be
 * running is the one thing this never does knowingly.
 */
export function recoverOrphans(deps: RecoveryDeps): Array<{ id: string; action: RecoveryAction }> {
  const db = getDb();
  const now = deps.now ?? new Date();
  const rows = db.prepare(
    `SELECT o.*, a.id AS attempt_id, a.runner_pid, a.runner_started_at, a.process_group, a.run_id, a.started_at AS attempt_started
       FROM one_off o JOIN one_off_attempt a ON a.one_off_id = o.id AND a.outcome = 'running'
      WHERE o.status = 'running' AND a.runner_pid != ?`,
  ).all(deps.selfPid) as Array<AtScheduleRow & { attempt_id: string; runner_pid: number; runner_started_at: number | null; process_group: number | null; run_id: string | null; attempt_started: string }>;

  const actions: Array<{ id: string; action: RecoveryAction }> = [];
  for (const row of rows) {
    const attempt = { runId: row.run_id, startedAt: new Date(row.attempt_started) };
    const done = deps.closedRun(row.id, attempt);
    if (done) {
      finishAttempt({
        oneOffId: row.id,
        attemptId: row.attempt_id,
        outcome: done.succeeded ? "succeeded" : "failed",
        exitCode: done.exitCode,
        runId: done.runId,
        ...(done.summary ? { reason: done.summary } : {}),
        now,
      });
      actions.push({ id: row.id, action: "finalized" });
      continue;
    }

    const state = deps.probe(row.runner_pid, row.runner_started_at);
    if (state === "alive") {
      actions.push({ id: row.id, action: "left-alive" });
      continue;
    }
    // A script attempt runs in a process group the runner recorded; its open
    // run just means nobody was left to close it. An agent attempt has no
    // group — it runs inside the API — and an open run there may still
    // finish, so it is waited out to its ceiling before anything is decided.
    const isScript = row.process_group != null;
    const agentStillOpen = !isScript && deps.openRun(row.id, attempt);
    if (agentStillOpen && state === "gone" && now.getTime() - attempt.startedAt.getTime() < hardCeilingMs(row.timeout_s)) {
      actions.push({ id: row.id, action: "left-alive" });
      continue;
    }
    // Kill a dead runner's script before re-running it, so the two cannot overlap.
    if (state === "gone" && isScript) deps.kill(row.process_group);

    const stillOpen = agentStillOpen;
    const uncertain = state === "unknown" || stillOpen || row.recoveries + 1 > MAX_RECOVERIES;
    // Someone asked for this to stop: a dead runner is not a reason to start it again.
    const cancelled = state === "gone" && !stillOpen && row.cancel_requested_at !== null;
    db.transaction(() => {
      db.prepare("UPDATE one_off_attempt SET outcome = 'abandoned', finished_at = ? WHERE id = ? AND outcome = 'running'").run(iso(now), row.attempt_id);
      if (cancelled) {
        db.prepare("UPDATE one_off SET status = 'cancelled', reason = 'cancelled while running', updated_at = ? WHERE id = ? AND status = 'running'")
          .run(iso(now), row.id);
      } else if (uncertain) {
        const reason = state === "unknown"
          ? "could not tell whether the previous attempt is still running"
          : stillOpen
            ? "the previous attempt's run never finished"
            : `attempts died ${row.recoveries + 1} times; not trying again`;
        db.prepare("UPDATE one_off SET status = 'uncertain', recoveries = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'running'")
          .run(row.recoveries + (state === "gone" ? 1 : 0), reason, iso(now), row.id);
      } else {
        db.prepare(
          "UPDATE one_off SET status = 'pending', recoveries = ?, due_at = ?, reason = 'previous attempt died; running again', updated_at = ? WHERE id = ? AND status = 'running'",
        ).run(row.recoveries + 1, iso(now), iso(now), row.id);
      }
    }).immediate();
    actions.push({ id: row.id, action: cancelled ? "finalized" : uncertain ? "uncertain" : "requeued" });
  }
  return actions;
}

/**
 * Terminal schedules and their attempts older than `before`; succeeded ones
 * from `succeededBefore` (default: the same), since a schedule firing a job
 * every minute makes a row a minute and failures are what get read.
 */
export function pruneAtSchedules(before: Date, succeededBefore: Date = before): number {
  const db = getDb();
  return db.transaction(() => {
    const old = (db
      .prepare("SELECT id FROM one_off WHERE (status IN ('failed','cancelled','uncertain') AND updated_at < ?) OR (status = 'succeeded' AND updated_at < ?)")
      .all(iso(before), iso(succeededBefore)) as Array<{ id: string }>).map((r) => r.id);
    for (const id of old) {
      db.prepare("DELETE FROM one_off_attempt WHERE one_off_id = ?").run(id);
      db.prepare("DELETE FROM one_off WHERE id = ?").run(id);
    }
    return old.length;
  })();
}
