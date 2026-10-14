/**
 * Schedule state, runtime schedules and the scheduler heartbeat.
 */

import { getDb } from "./db.js";

export interface ScheduleState {
  schedule_id: string;
  last_fired_at: Date | null;
  next_fire_at: Date | null;
  trigger_key: string | null;
  paused: boolean;
  last_run_id: string | null;
  last_status: string | null;
  last_summary: string | null;
  consecutive_failures: number;
  failure_announced: boolean;
  skipped_fires: number;
  missed_fires: number;
}

interface StateRow {
  schedule_id: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  trigger_key: string | null;
  paused: number;
  last_run_id: string | null;
  last_status: string | null;
  last_summary: string | null;
  consecutive_failures: number;
  failure_announced: number;
  skipped_fires: number;
  missed_fires: number;
}

const toDate = (v: string | null) => (v == null ? null : new Date(v));

function fromRow(row: StateRow): ScheduleState {
  return {
    schedule_id: row.schedule_id,
    last_fired_at: toDate(row.last_fired_at),
    next_fire_at: toDate(row.next_fire_at),
    trigger_key: row.trigger_key,
    paused: row.paused === 1,
    last_run_id: row.last_run_id,
    last_status: row.last_status,
    last_summary: row.last_summary,
    consecutive_failures: row.consecutive_failures,
    failure_announced: row.failure_announced === 1,
    skipped_fires: row.skipped_fires,
    missed_fires: row.missed_fires,
  };
}

export function getState(scheduleId: string): ScheduleState | null {
  const row = getDb().prepare("SELECT * FROM schedule_state WHERE schedule_id = ?").get(scheduleId) as StateRow | undefined;
  return row ? fromRow(row) : null;
}

export function listStates(): Map<string, ScheduleState> {
  const rows = getDb().prepare("SELECT * FROM schedule_state").all() as StateRow[];
  return new Map(rows.map((r) => [r.schedule_id, fromRow(r)]));
}

/**
 * Columns `updateState` is allowed to write. The patch keys are interpolated
 * into the UPDATE statement, so an unknown key is rejected rather than reaching
 * SQL — the only dynamic column construction in this store. Callers are internal
 * and typed today; this keeps a future caller from smuggling a column name.
 */
const UPDATABLE_COLUMNS: ReadonlySet<string> = new Set([
  "last_fired_at",
  "next_fire_at",
  "trigger_key",
  "paused",
  "last_run_id",
  "last_status",
  "last_summary",
  "consecutive_failures",
  "failure_announced",
  "skipped_fires",
  "missed_fires",
]);

/** Merge `patch` into a schedule's state, creating the row if needed. */
export function updateState(
  scheduleId: string,
  patch: Partial<Omit<ScheduleState, "schedule_id">>,
): ScheduleState {
  const db = getDb();
  db.prepare(
    "INSERT INTO schedule_state (schedule_id, updated_at) VALUES (?, ?) ON CONFLICT(schedule_id) DO NOTHING",
  ).run(scheduleId, new Date().toISOString());

  const columns: string[] = [];
  const params: Record<string, unknown> = { schedule_id: scheduleId, updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) {
    if (!UPDATABLE_COLUMNS.has(key)) {
      throw new Error(`updateState: refusing to write unknown column "${key}"`);
    }
    columns.push(`${key} = @${key}`);
    params[key] =
      value instanceof Date ? value.toISOString() : typeof value === "boolean" ? Number(value) : value;
  }
  columns.push("updated_at = @updated_at");
  db.prepare(`UPDATE schedule_state SET ${columns.join(", ")} WHERE schedule_id = @schedule_id`).run(params);
  return getState(scheduleId) as ScheduleState;
}

/** Count a fire that did not run, by why. */
export function countSkippedFire(scheduleId: string, why: "skipped" | "missed"): void {
  const column = why === "skipped" ? "skipped_fires" : "missed_fires";
  updateState(scheduleId, {});
  getDb().prepare(`UPDATE schedule_state SET ${column} = ${column} + 1 WHERE schedule_id = ?`).run(scheduleId);
}


export interface RuntimeScheduleRow {
  name: string;
  spec: Record<string, unknown>;
  created_at: Date;
  created_by: string | null;
  identity_id?: number | null;
}

export function listRuntimeSchedules(): RuntimeScheduleRow[] {
  const rows = getDb().prepare("SELECT * FROM runtime_schedules ORDER BY name").all() as Array<{
    name: string;
    spec: string;
    created_at: string;
    created_by: string | null;
    identity_id?: number | null;
  }>;
  return rows.map((r) => ({
    ...r,
    spec: JSON.parse(r.spec) as Record<string, unknown>,
    created_at: new Date(r.created_at),
    identity_id: r.identity_id ?? null,
  }));
}

/** Insert a runtime schedule. Throws if the name is taken — replacing one is a delete and a create. */
export function insertRuntimeSchedule(name: string, spec: Record<string, unknown>, createdBy: string | null, identityId?: number | null): void {
  getDb()
    .prepare("INSERT INTO runtime_schedules (name, spec, created_at, created_by, identity_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, JSON.stringify(spec), new Date().toISOString(), createdBy, identityId ?? null);
}

export function deleteRuntimeSchedule(name: string): boolean {
  const db = getDb();
  const removed = db.prepare("DELETE FROM runtime_schedules WHERE name = ?").run(name).changes > 0;
  // State goes with the definition: a recreated schedule of the same name is
  // a new schedule, not the old one resumed.
  if (removed) db.prepare("DELETE FROM schedule_state WHERE schedule_id = ?").run(`runtime/${name}`);
  return removed;
}


export interface Heartbeat {
  at: Date;
  pid: number;
  schedules: number;
  load_errors: string[];
}

export function writeHeartbeat(schedules: number, loadErrors: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO heartbeat (id, at, pid, schedules, load_errors) VALUES (1, @at, @pid, @schedules, @errors)
       ON CONFLICT(id) DO UPDATE SET at = @at, pid = @pid, schedules = @schedules, load_errors = @errors`,
    )
    .run({ at: new Date().toISOString(), pid: process.pid, schedules, errors: JSON.stringify(loadErrors) });
}

export function readHeartbeat(): Heartbeat | null {
  const row = getDb().prepare("SELECT * FROM heartbeat WHERE id = 1").get() as
    | { at: string; pid: number; schedules: number; load_errors: string }
    | undefined;
  return row
    ? { at: new Date(row.at), pid: row.pid, schedules: row.schedules, load_errors: JSON.parse(row.load_errors) as string[] }
    : null;
}

/** Persist the event claim and fire time together before handing work to a runner. */
export function claimLoginEvent(scheduleId: string, eventId: string | null, now: Date): boolean {
  if (!eventId) return false;
  return getDb().transaction(() => {
    const result = getDb().prepare("INSERT INTO login_event_claims (schedule_id, event_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(scheduleId, eventId, now.toISOString());
    if (!result.changes) return false;
    updateState(scheduleId, { last_fired_at: now });
    return true;
  })();
}
