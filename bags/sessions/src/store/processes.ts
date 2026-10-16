import { z } from "zod";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";

import { getSessionsSqlite } from "./sessions-db.js";
import { assertInteractiveSession } from "./workflow-ownership.js";

function getProcessesSqlite() {
  return withStoreContext({}, () => getSessionsSqlite());
}

interface ProcessRow {
  id: number;
  session_id: string;
  pid: number | null;
  pid_started_at: number | null;
  hostname: string | null;
  process_name: string | null;
  command: string | null;
  app_name: string | null;
  parent_pid: number | null;
  source: string | null;
  started_at: string;
  ended_at: string | null;
  last_checked_at: string | null;
  liveness: "alive" | "dead" | "unknown" | null;
  liveness_reason: string | null;
}

export interface ProcessRecord {
  id: number;
  sessionId: string;
  pid: number | null;
  pidStartedAt: number | null;
  hostname: string | null;
  processName: string | null;
  command: string | null;
  appName: string | null;
  parentPid: number | null;
  source: string | null;
  startedAt: string;
  endedAt: string | null;
  lastCheckedAt: string | null;
  liveness: "alive" | "dead" | "unknown" | null;
  livenessReason: string | null;
}

function toRecord(row: ProcessRow): ProcessRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    pid: row.pid,
    pidStartedAt: row.pid_started_at,
    hostname: row.hostname,
    processName: row.process_name,
    command: row.command,
    appName: row.app_name,
    parentPid: row.parent_pid,
    source: row.source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastCheckedAt: row.last_checked_at,
    liveness: row.liveness,
    livenessReason: row.liveness_reason,
  };
}

export interface RecordProcessInput {
  sessionId: string;
  pid?: number | null;
  pidStartedAt?: number | null;
  hostname?: string | null;
  processName?: string | null;
  command?: string | null;
  appName?: string | null;
  parentPid?: number | null;
  source?: string | null;
}

export interface ProcessLivenessStamp {
  id: number;
  liveness: "alive" | "dead" | "unknown";
  livenessReason?: string | null;
}

export class ProcessSessionUnavailable extends Error {
  constructor() { super("Session is unavailable for process adoption"); this.name = "ProcessSessionUnavailable"; }
}

/**
 * Preserve the previous instance when PID, start time or host changes.
 * Metadata updates for the same instance keep its stable history ID.
 */
export function recordProcessStart(input: RecordProcessInput): ProcessRecord {
  const identity = sessionIdentity(input.sessionId);
  const parent = withStoreContext(identity ? { identity } : {}, () => getSessionsSqlite());
  const sqlite = getProcessesSqlite();
  // Hold the Session writer lock until control history commits. Ending or
  // deleting the Session must see this instance when capturing cleanup.
  return parent.transaction(() => {
    assertInteractiveSession(parent, input.sessionId);
    const session = parent.prepare("SELECT state,ended_at FROM sessions WHERE id=?").get(input.sessionId) as { state: string; ended_at: string | null } | undefined;
    if (!session || session.state !== "open" || session.ended_at !== null) throw new ProcessSessionUnavailable();
    return sqlite.transaction(() => {
      const existing = getLiveProcess(input.sessionId);
      if (existing && (existing.pid !== (input.pid ?? null) || existing.pidStartedAt !== (input.pidStartedAt ?? null)
        || existing.hostname !== (input.hostname ?? null))) {
        sqlite.prepare("UPDATE processes SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),liveness_reason='process-replaced' WHERE id=? AND ended_at IS NULL").run(existing.id);
      }
      sqlite
        .prepare(
          `INSERT INTO processes (
             session_id, pid, pid_started_at, hostname, process_name,
             command, app_name, parent_pid, source
           ) VALUES (
             @sessionId, @pid, @pidStartedAt, @hostname, @processName,
             @command, @appName, @parentPid, @source
           )
           ON CONFLICT(session_id) WHERE ended_at IS NULL DO UPDATE SET
             pid = excluded.pid,
             pid_started_at = excluded.pid_started_at,
             hostname = excluded.hostname,
             process_name = excluded.process_name,
             command = excluded.command,
             app_name = excluded.app_name,
             parent_pid = excluded.parent_pid,
             source = excluded.source`,
        )
        .run({
          sessionId: input.sessionId,
          pid: input.pid ?? null,
          pidStartedAt: input.pidStartedAt ?? null,
          hostname: input.hostname ?? null,
          processName: input.processName ?? null,
          command: input.command ?? null,
          appName: input.appName ?? null,
          parentPid: input.parentPid ?? null,
          source: input.source ?? null,
        });

      const saved = getLiveProcess(input.sessionId);
      if (!saved) {
        throw new Error(`process row for session ${input.sessionId} missing immediately after write`);
      }
      return saved;
    }).immediate();
  }).immediate();
}

/** Close the active process row for a session. */
export function markProcessEnded(sessionId: string, reason?: string | null): void {
  getProcessesSqlite()
    .prepare(
      `UPDATE processes
          SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              liveness_reason = COALESCE(?, liveness_reason)
        WHERE session_id = ? AND ended_at IS NULL`,
    )
    .run(reason ?? null, sessionId);
}

/**
 * Batch stamp liveness and last_checked_at in a single transaction.
 * Stamp occurs before session reaping so trigger-driven close preserves the verdict.
 */
export function stampLiveness(stamps: readonly ProcessLivenessStamp[]): void {
  if (stamps.length === 0) return;
  const sqlite = getProcessesSqlite();
  const statement = sqlite.prepare(
    `UPDATE processes
        SET last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            liveness = @liveness,
            liveness_reason = @livenessReason
      WHERE id = @id`,
  );

  const apply = sqlite.transaction((rows: readonly ProcessLivenessStamp[]) => {
    for (const row of rows) {
      statement.run({
        id: row.id,
        liveness: row.liveness,
        livenessReason: row.livenessReason ?? null,
      });
    }
  });

  apply(stamps);
}

/** Current active process row for a session, or null if ended or not recorded. */
export function getLiveProcess(sessionId: string): ProcessRecord | null {
  const row = getProcessesSqlite()
    .prepare("SELECT * FROM processes WHERE session_id = ? AND ended_at IS NULL")
    .get(sessionId) as ProcessRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * The live process row of each session named, keyed by session id; a session
 * with none is absent. Where a session somehow holds two, the latest wins.
 */
export function getLiveProcessesBySessions(sessionIds: readonly string[]): Map<string, ProcessRecord> {
  const live = new Map<string, ProcessRecord>();
  // Chunked for builds whose SQLITE_MAX_VARIABLE_NUMBER is 999.
  const CHUNK = 900;
  const sqlite = getProcessesSqlite();
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const rows = sqlite
      .prepare(`SELECT * FROM processes WHERE ended_at IS NULL AND session_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`)
      .all(...chunk) as ProcessRow[];
    for (const row of rows) live.set(row.session_id, toRecord(row));
  }
  return live;
}

/** Every process row currently active across all sessions. */
export function listLiveProcesses(): ProcessRecord[] {
  const rows = getProcessesSqlite()
    .prepare("SELECT * FROM processes WHERE ended_at IS NULL ORDER BY started_at ASC")
    .all() as ProcessRow[];
  return rows.map(toRecord);
}

/** Full process history for a session, oldest first. */
export function listProcesses(sessionId: string): ProcessRecord[] {
  const rows = getProcessesSqlite()
    .prepare("SELECT * FROM processes WHERE session_id = ? ORDER BY started_at ASC")
    .all(sessionId) as ProcessRow[];
  return rows.map(toRecord);
}

/**
 * Candidates for reaper inspection: live processes belonging to active sessions,
 * ordered round-robin with unprobed rows first to prevent starvation.
 */
export function listReapCandidates(limit: number): ProcessRecord[] {
  const rows = getProcessesSqlite()
    .prepare(
      `SELECT p.*
         FROM processes p
         JOIN sessions s ON s.id = p.session_id
        WHERE p.ended_at IS NULL
          AND s.active = 1
        ORDER BY p.last_checked_at IS NOT NULL, p.last_checked_at ASC, p.id ASC
        LIMIT ?`,
    )
    .all(limit) as ProcessRow[];
  return rows.map(toRecord);
}

export const ProcessInstanceSchema = z.strictObject({
  id: z.number().int().positive(), sessionId: z.string().min(1).max(500),
  pid: z.number().int().positive().nullable(), pidStartedAt: z.number().finite().nonnegative().nullable(),
  hostname: z.string().max(500).nullable(), startedAt: z.string().min(1).max(100),
});
export type ProcessInstance = Readonly<z.infer<typeof ProcessInstanceSchema>>;

export function markProcessInstanceEnded(instance: ProcessInstance, reason?: string | null): boolean {
  const binding = ProcessInstanceSchema.parse({ id: instance.id, sessionId: instance.sessionId, pid: instance.pid,
    pidStartedAt: instance.pidStartedAt, hostname: instance.hostname, startedAt: instance.startedAt });
  return getProcessesSqlite().prepare(`UPDATE processes
    SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),liveness_reason=COALESCE(?,liveness_reason)
    WHERE id=? AND session_id=? AND pid IS ? AND pid_started_at IS ? AND hostname IS ?
      AND started_at=? AND ended_at IS NULL`)
    .run(reason ?? null, binding.id, binding.sessionId, binding.pid, binding.pidStartedAt, binding.hostname, binding.startedAt).changes === 1;
}
