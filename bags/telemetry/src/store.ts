import generatedMigrations from "./generated/metrics-migrations.js";
import { migratedStorePath } from "@barry-rocks/sdk/stores";
// Keep metric writes transactional and retention bounded in the owning SQLite store.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-139

import Database from "better-sqlite3";
import { openBagStore } from "./framework/store.js";
import { join } from "node:path";
import { labelKey, RETENTION, type MetricPoint } from "./schema.js";
import { bagDataDir } from "@barry-rocks/sdk/services";

export type Db = Database.Database;

/** `~/.barry/metrics.db` — beside the other local state Barry owns. */
export function defaultDbPath(): string {
  return process.env.BARRY_METRICS_DB || migratedStorePath("telemetry", "metrics", () => join(bagDataDir("telemetry"), "metrics.db"), "metrics", "node");
}

/**
 * Open (creating if needed) and migrate.
 *
 * Idempotent: every statement is CREATE ... IF NOT EXISTS, so this runs on
 * every sampler tick and every web request without a migration framework.
 */
export function openDb(path = defaultDbPath()): Db {
  // No `busyTimeoutMs`, matching what this store always did — though note the
  // driver defaults it to 5000 anyway, so this has never actually run without
  // one (see framework/store.test.ts). The single-writer rule still holds:
  // `collect-ollama.ts:20` documents why a second writing process would lose
  // points to SQLITE_BUSY, which charts as a gap, which is indistinguishable
  // from idle.
  //
  // UNITS: every time column below is UNIX SECONDS, never milliseconds. The
  // failure is silent — a millisecond bound matches no rows and reads as "no
  // data" rather than "wrong units". The tell is `datetime(max(ts)/1000,
  // 'unixepoch')` resolving to 1970.
  //
  // The surrounding code is genuinely mixed, so do not generalize: the JSON
  // envelopes served to the dashboard carry `generatedAt` in MILLISECONDS (it
  // feeds `new Date(...)` directly), while `ts`, `bucket`, `since` and `oldest`
  // are seconds and the web layer multiplies by 1000 to convert.
  return openBagStore({ path, ddl: STORE_DDL, migrations: MIGRATIONS });
}

// Insert each point batch atomically so one sampler observation cannot be partly recorded.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-140
export function writePoints(db: Db, points: MetricPoint[]): number {
  if (points.length === 0) return 0;
  const stmt = db.prepare(
    "INSERT INTO metric_point (ts, metric, value, labels) VALUES (?, ?, ?, ?)",
  );
  const insertAll = db.transaction((rows: MetricPoint[]) => {
    for (const p of rows) {
      // Guard here rather than at every call site: a NaN from a failed parse
      // would otherwise poison avg() for a whole bucket, and SQLite stores it
      // as NULL, which then breaks comparisons silently.
      if (!Number.isFinite(p.value)) continue;
      stmt.run(p.ts, p.metric, p.value, labelKey(p.labels));
    }
  });
  insertAll(points);
  return points.length;
}

export interface QueryOptions {
  metric: string;
  /** Unix seconds, inclusive. Compared against `metric_point.ts` as-is. */
  since: number;
  /** Unix seconds, inclusive. */
  until?: number;
  /** Exact-match label filter; a point must carry all of these. */
  labels?: Record<string, string>;
  limit?: number;
}

export interface SeriesRow {
  /** Unix seconds, as stored. Multiply by 1000 before `new Date(...)`. */
  ts: number;
  value: number;
  labels: Record<string, string>;
}

/**
 * Read raw points.
 *
 * Label filtering is done in SQL with json_extract rather than in JS so a wide
 * window does not pull every series into memory to throw most of it away.
 */
export function queryPoints(db: Db, opts: QueryOptions): SeriesRow[] {
  const where: string[] = ["metric = ?", "ts >= ?"];
  const params: unknown[] = [opts.metric, opts.since];

  if (opts.until !== undefined) {
    where.push("ts <= ?");
    params.push(opts.until);
  }
  for (const [k, v] of Object.entries(opts.labels ?? {})) {
    where.push("json_extract(labels, ?) = ?");
    params.push(`$.${k}`, v);
  }

  const rows = db
    .prepare(
      `SELECT ts, value, labels FROM metric_point
       WHERE ${where.join(" AND ")}
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(...params, opts.limit ?? 10_000) as Array<{ ts: number; value: number; labels: string }>;

  return rows.map((r) => ({ ts: r.ts, value: r.value, labels: JSON.parse(r.labels) }));
}

// Return exactly one latest row per label set without a correlated aggregate for every candidate.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-141
export function latest(db: Db, metric: string): SeriesRow[] {
  const rows = db
    .prepare(
      `SELECT p.labels, p.ts, p.value
       FROM metric_point p
       JOIN (
         SELECT labels, max(ts) AS ts
         FROM metric_point
         WHERE metric = ?
         GROUP BY labels
       ) g ON p.labels = g.labels AND p.ts = g.ts
       WHERE p.metric = ?
       GROUP BY p.labels
       HAVING p.rowid = max(p.rowid)
       ORDER BY p.labels`,
    )
    .all(metric, metric) as Array<{ ts: number; value: number; labels: string }>;

  return rows.map((r) => ({ ts: r.ts, value: r.value, labels: JSON.parse(r.labels) }));
}

// Read hourly buckets oldest first so charts preserve chronological order.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-142
export function queryRollups(
  db: Db,
  opts: { metric: string; since: number; until?: number; labels?: Record<string, string> },
): SeriesRow[] {
  const where: string[] = ["metric = ?", "bucket >= ?"];
  const params: unknown[] = [opts.metric, opts.since];

  if (opts.until !== undefined) {
    where.push("bucket <= ?");
    params.push(opts.until);
  }
  for (const [k, v] of Object.entries(opts.labels ?? {})) {
    where.push("json_extract(labels, ?) = ?");
    params.push(`$.${k}`, v);
  }

  const rows = db
    .prepare(
      `SELECT bucket AS ts, avg AS value, labels FROM rollup_hourly
       WHERE ${where.join(" AND ")}
       ORDER BY bucket ASC`,
    )
    .all(...params) as Array<{ ts: number; value: number; labels: string }>;

  return rows.map((r) => ({ ts: r.ts, value: r.value, labels: JSON.parse(r.labels) }));
}

/** Truncate a unix timestamp to its hour bucket. */
export function hourBucket(ts: number): number {
  return Math.floor(ts / 3600) * 3600;
}

// Roll up before deleting raw points so retention never discards the only retained reading.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-143
export function rollup(db: Db, now = Math.floor(Date.now() / 1000)): { buckets: number; deleted: number } {
  const rawCutoff = hourBucket(now - RETENTION.rawDays * 86400);

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO rollup_hourly (bucket, metric, labels, min, max, avg, last, count)
         SELECT
           (ts / 3600) * 3600 AS bucket,
           metric,
           labels,
           MIN(value),
           MAX(value),
           AVG(value),
           -- "last" is the value at the greatest ts in the bucket. Needed for
           -- gauges where the average is meaningless (a monotonic run counter).
           (SELECT value FROM metric_point i
             WHERE i.metric = o.metric AND i.labels = o.labels
               AND (i.ts / 3600) * 3600 = (o.ts / 3600) * 3600
             ORDER BY i.ts DESC LIMIT 1),
           COUNT(*)
         FROM metric_point o
         WHERE ts < ?
         GROUP BY bucket, metric, labels
         ON CONFLICT(bucket, metric, labels) DO UPDATE SET
           min = MIN(min, excluded.min),
           max = MAX(max, excluded.max),
           -- Weighted so re-running over a partially-rolled bucket stays correct.
           avg = (avg * count + excluded.avg * excluded.count) / (count + excluded.count),
           last = excluded.last,
           count = count + excluded.count`,
      )
      .run(rawCutoff);

    const del = db.prepare("DELETE FROM metric_point WHERE ts < ?").run(rawCutoff);
    return { buckets: info.changes, deleted: del.changes };
  });

  return run();
}

/** Drop hourly buckets past the retention horizon. */
export function pruneRollups(db: Db, now = Math.floor(Date.now() / 1000)): number {
  return db
    .prepare("DELETE FROM rollup_hourly WHERE bucket < ?")
    .run(hourBucket(now - RETENTION.hourlyDays * 86400)).changes;
}

// Maintain rollups, pruning and reclamation together so bounded retention releases disk space.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-144
export function maintain(db: Db, now = Math.floor(Date.now() / 1000)) {
  const rolled = rollup(db, now);
  const pruned = pruneRollups(db, now);
  return { ...rolled, prunedBuckets: pruned };
}

export const STORE_DDL = generatedMigrations[0].sql;
export const MIGRATIONS = generatedMigrations;
