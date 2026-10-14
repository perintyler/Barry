import generatedMigrations from "../generated/usage-migrations.js";
import { migratedStorePath } from "@barry-rocks/sdk/stores";
// Store measured tokens, costs and durations separately from inferred transcript data.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-203

import Database from "better-sqlite3";
import { openBagStore } from "../framework/store.js";
import { join } from "node:path";
import { costOf } from "./transcripts.js";
import { bagDataDir } from "@barry-rocks/sdk/services";

export type Db = Database.Database;

/** `~/.barry/usage.db` — beside metrics.db, the other local state Barry owns. */
export function usageDbPath(): string {
  return process.env.BARRY_USAGE_DB || migratedStorePath("telemetry", "usage", () => join(bagDataDir("telemetry"), "usage.db"), "usage", "node");
}

// Store opening and migration are idempotent for both writers and readers.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-204
export function openUsageDb(path = usageDbPath()): Db {
  // `busy_timeout` because more than one PROCESS writes this store —
  // usage.db is written by the API server and read by this bag.
  // Unlike metrics.db, whose single writer means a timeout would hide
  // contention rather than survive it.
  return openBagStore({ path, ddl: STORE_DDL, migrations: MIGRATIONS, busyTimeoutMs: 5000 });
}

// Record usage per turn so retries and later transcript recovery can be distinguished.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-205
export interface SessionUsage {
  id: string;
  sessionId: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  status: string;
  createdAt: number;
}

/** One completed tool call, with the wall time it actually took. */
export interface ToolInvocation {
  id: string;
  sessionId: string;
  toolUseId?: string;
  name: string;
  durationMs: number;
  isError?: boolean;
  createdAt: number;
}

export function recordSessionUsage(db: Db, row: SessionUsage): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_usage
       (id, session_id, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, cost_usd, num_turns, duration_ms, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.sessionId, row.model ?? null,
    row.inputTokens ?? null, row.outputTokens ?? null,
    row.cacheReadTokens ?? null, row.cacheWriteTokens ?? null,
    row.totalTokens ?? null, row.costUsd ?? null,
    row.numTurns ?? null, row.durationMs ?? null,
    row.status, row.createdAt,
  );
}

// Recompute costs from stored tokens without altering the underlying usage observations.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-206
export function recostStoredRows(db: Db): number {
  const pending = db
    .prepare(
      `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM session_usage
        WHERE cost_usd IS NULL AND model IS NOT NULL`,
    )
    .all() as Array<{
      id: string;
      model: string;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      cache_write_tokens: number | null;
    }>;

  const stmt = db.prepare(`UPDATE session_usage SET cost_usd = ? WHERE id = ?`);
  const apply = db.transaction((batch: typeof pending) => {
    let n = 0;
    for (const r of batch) {
      const cost = costOf({
        model: r.model,
        inputTokens: r.input_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        cacheReadTokens: r.cache_read_tokens ?? 0,
        cacheWriteTokens: r.cache_write_tokens ?? 0,
      });
      // Still unpriced (e.g. `<synthetic>`) — leave the NULL rather than
      // writing a zero that would read as "this was free".
      if (cost === undefined) continue;
      stmt.run(cost, r.id);
      n += 1;
    }
    return n;
  });
  return apply(pending);
}

// Insert each invocation batch atomically so partial telemetry cannot distort aggregates.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-207
export function recordToolInvocations(db: Db, rows: ToolInvocation[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO tool_invocation
       (id, session_id, tool_use_id, name, duration_ms, is_error, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const insertAll = db.transaction((batch: ToolInvocation[]) => {
    for (const r of batch) {
      stmt.run(
        r.id, r.sessionId, r.toolUseId ?? null, r.name, r.durationMs,
        r.isError === undefined ? null : r.isError ? 1 : 0,
        r.createdAt,
      );
    }
  });
  insertAll(rows);
  return rows.length;
}

// Absent measurement-start time means unavailable coverage rather than no usage.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-208
export function measuringSince(db: Db): number | undefined {
  const row = db
    .prepare("SELECT MIN(created_at) AS since FROM session_usage")
    .get() as { since: number | null } | undefined;
  return row?.since ?? undefined;
}

/** Rows older than the horizon, dropped. Telemetry must stay bounded. */
export function pruneUsage(db: Db, olderThanSec: number): number {
  const a = db.prepare("DELETE FROM session_usage WHERE created_at < ?").run(olderThanSec);
  const b = db.prepare("DELETE FROM tool_invocation WHERE created_at < ?").run(olderThanSec);
  return a.changes + b.changes;
}

/** Daily spend and token mix. */
export interface CostDay {
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

// Return spend in chronological order over the selected window.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-209
export function costByDay(db: Db, sinceSec: number): CostDay[] {
  return db
    .prepare(
      `SELECT date(created_at, 'unixepoch', 'localtime')  AS day,
              COALESCE(SUM(cost_usd), 0)                  AS costUsd,
              COALESCE(SUM(input_tokens), 0)              AS inputTokens,
              COALESCE(SUM(output_tokens), 0)             AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0)         AS cacheReadTokens,
              COALESCE(SUM(cache_write_tokens), 0)        AS cacheWriteTokens,
              COALESCE(SUM(num_turns), 0)                 AS turns
       FROM session_usage
       WHERE created_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(sinceSec) as CostDay[];
}

/** Spend grouped by model. */
export function costByModel(
  db: Db,
  sinceSec: number,
): Array<{ model: string; costUsd: number | null; turns: number; totalTokens: number; uncosted: number }> {
  return db
    .prepare(
      // cost_usd is deliberately NOT coalesced to zero. A model with no entry
      // in the price table has no cost, and rendering that as $0.00 says it was
      // FREE — a claim, and a false one. NULL renders as "not priced" instead.
      // The uncosted count says how much of the row is unaccounted for.
      `SELECT COALESCE(model, '(unrecorded)')                        AS model,
              SUM(cost_usd)                                          AS costUsd,
              COALESCE(SUM(num_turns), 0)                            AS turns,
              COALESCE(SUM(total_tokens), 0)                         AS totalTokens,
              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)      AS uncosted
       FROM session_usage
       WHERE created_at >= ?
       GROUP BY model
       ORDER BY costUsd DESC NULLS LAST`,
    )
    .all(sinceSec) as Array<{ model: string; costUsd: number | null; turns: number; totalTokens: number; uncosted: number }>;
}

// Use recorded tool durations for latency; message gaps are only an approximation.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-210
export function toolDurations(
  db: Db,
  sinceSec: number,
  minSamples = 5,
): Array<{ tool: string; calls: number; p50: number; p95: number; maxMs: number }> {
  // SQLite has no percentile_cont, so the percentile is picked by offset. Exact
  // for the sample, and cheap: one index scan per tool.
  return db
    .prepare(
      `WITH per_tool AS (
         SELECT name, duration_ms,
                ROW_NUMBER() OVER (PARTITION BY name ORDER BY duration_ms) AS rn,
                COUNT(*)    OVER (PARTITION BY name)                       AS n
         FROM tool_invocation
         WHERE created_at >= ?
       )
       SELECT name AS tool,
              MAX(n)                                                        AS calls,
              MAX(CASE WHEN rn = MAX(1, n / 2)          THEN duration_ms END) AS p50,
              MAX(CASE WHEN rn = MAX(1, (n * 95) / 100) THEN duration_ms END) AS p95,
              MAX(duration_ms)                                              AS maxMs
       FROM per_tool
       GROUP BY name
       HAVING MAX(n) >= ?
       ORDER BY p95 DESC`,
    )
    .all(sinceSec, minSamples) as Array<{ tool: string; calls: number; p50: number; p95: number; maxMs: number }>;
}

// Unknown tool error flags remain unknown rather than becoming successful calls.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-211
export function errorCoverage(db: Db, sinceSec: number): { known: number; total: number; errors: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*)                                   AS total,
              SUM(CASE WHEN is_error IS NOT NULL THEN 1 ELSE 0 END) AS known,
              SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END)         AS errors
       FROM tool_invocation
       WHERE created_at >= ?`,
    )
    .get(sinceSec) as { total: number; known: number | null; errors: number | null };
  return { total: row.total, known: row.known ?? 0, errors: row.errors ?? 0 };
}

export const STORE_DDL = generatedMigrations[0].sql;
export const MIGRATIONS = generatedMigrations;
