// Read bookkeeping output from durable action runs, independently of whether the process remains alive.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-009

import type { MetricPoint } from "./schema.js";
import { METRICS } from "./schema.js";
import { migratedStorePath } from "@barry-rocks/sdk/stores";
import { actionsDbPath as legacyActionsDbPath } from "./usage/stores.js";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";

const actionsDbPath = () => process.env.BARRY_ACTIONS_DB ?? migratedStorePath("actions", "actions", legacyActionsDbPath, "infrastructure");

/** The schedule whose summary line this reads. */
const SCHEDULE = "sessions/bookkeeping";

export interface BookkeepingSummary {
  written: number;
  failed: number;
  /** Sessions the per-tick write cap deferred. Absent in the line means 0. */
  deferred: number;
  /** Median seconds per model call, or null when the run made none. */
  p50Sec: number | null;
}

/** `key=123` anywhere in the line. Key-based because `skipped(...)` reorders. */
function intField(line: string, key: string): number | null {
  const m = new RegExp(`\\b${key}=(\\d+)\\b`).exec(line);
  return m ? Number(m[1]) : null;
}

// Only a recognized summary line is evidence of a completed bookkeeping result.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-010
export function parseBookkeeping(tail: string | null | undefined): BookkeepingSummary | null {
  if (!tail) return null;
  // The tail holds several lines; the summary is the one starting `done`.
  const line = tail
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.includes("done considered="));
  if (!line) return null;

  // `written` and `failed` are the load-bearing pair and are present on every
  // shape of the line, including a run that did nothing. If either is missing
  // the format has moved and guessing would be worse than reporting the break.
  const written = intField(line, "written");
  const failed = intField(line, "failed");
  if (written === null || failed === null) return null;

  // Absent means the cap never bound on this run, which is a real zero.
  const deferred = intField(line, "tick_write_cap") ?? 0;

  // Only present when the run made model calls. `19.9s` -> 19.9.
  const p50 = /\bp50=([\d.]+)s\b/.exec(line);
  const p50Sec = p50 ? Number(p50[1]) : null;

  return { written, failed, deferred, p50Sec: Number.isFinite(p50Sec ?? NaN) ? p50Sec : null };
}

/** Turn a parsed summary into points. Separated so tests need no database. */
export function summaryPoints(now: number, summary: BookkeepingSummary | null): MetricPoint[] {
  // The honesty point, on every path. Without it a changed upstream format
  // charts flat zeros for every counter below, which reads as a quiet job
  // rather than a parser that stopped working.
  const points: MetricPoint[] = [
    { ts: now, metric: METRICS.bookkeepingParseOk.name, value: summary ? 1 : 0 },
  ];
  if (!summary) return points;

  points.push(
    { ts: now, metric: METRICS.bookkeepingWritten.name, value: summary.written },
    { ts: now, metric: METRICS.bookkeepingFailed.name, value: summary.failed },
    { ts: now, metric: METRICS.bookkeepingDeferred.name, value: summary.deferred },
  );
  // Omitted rather than zeroed when the run made no calls: a p50 of 0s would be
  // a measurement, and there was none. The series is legitimately sparse.
  if (summary.p50Sec !== null) {
    points.push({ ts: now, metric: METRICS.ollamaInferenceP50Sec.name, value: summary.p50Sec });
  }
  return points;
}

// Use the most recent finished run; an in-flight run has no complete summary.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-011
export function collectBookkeeping(now: number, dbPath = actionsDbPath()): MetricPoint[] {
  // No actions.db at all is not a parse failure — nothing has run on this
  // machine. Reporting parse_ok=0 here would be an alert about a missing file.
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT output FROM action_runs
          WHERE schedule_id = ? AND status != 'started' AND output IS NOT NULL
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(SCHEDULE) as { output: string } | undefined;
    if (!row) return [];
    // The summary is the run's LAST line; the stored output is a stdout tail.
    const lastLine = row.output.trim().split("\n").pop() ?? "";
    return summaryPoints(now, parseBookkeeping(lastLine));
  } catch {
    // An unreadable store is this collector failing, not the job's format
    // changing, so it must not masquerade as parse_ok=0.
    return [];
  } finally {
    db?.close();
  }
}
