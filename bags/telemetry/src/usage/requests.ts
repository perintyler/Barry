import generatedMigrations from "../generated/requests-migrations.js";
import { migratedStorePath } from "@barry-rocks/sdk/stores";
// Store structured request telemetry separately from general warning/error logs.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-183

import Database from "better-sqlite3";
// Offset machinery lives in the framework so a second ingester cannot be
// written without it — see framework/tail.ts for why errors.ts lacked it.
import { getFileOffset, setFileOffset, resolveStartOffset, logSizeMb, type IngestResult } from "../framework/tail.js";
export { getFileOffset, setFileOffset, resolveStartOffset, logSizeMb };
import { openBagStore } from "../framework/store.js";
import {
  createReadStream, existsSync, statSync,
  openSync, fstatSync, readSync, closeSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { bagDataDir } from "@barry-rocks/sdk/services";
import { serviceLogSources } from "../framework/log-sources.js";

export type Db = Database.Database;

/** `~/.barry/requests.db`, beside the other local telemetry. */
export function requestsDbPath(): string {
  return process.env.BARRY_REQUESTS_DB || migratedStorePath("telemetry", "requests", () => join(bagDataDir("telemetry"), "requests.db"), "requests", "node");
}

export function openRequestsDb(path = requestsDbPath()): Db {
  // `busy_timeout` because more than one PROCESS writes this store —
  // requests.db is written by the ingest job and read by the web app and tools.
  // Unlike metrics.db, whose single writer means a timeout would hide
  // contention rather than survive it.
  return openBagStore({ path, ddl: STORE_DDL, migrations: MIGRATIONS, busyTimeoutMs: 5000 });
}

/** One parsed `request.end` line. */
export interface RequestRow {
  id: string;
  service: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ts: number;
}

// Collapse identifier path segments so route aggregation does not expose per-object URLs.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-184
export function templatePath(path: string): string {
  if (!path || path === "/") return path;
  return path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      if (seg.length < 16 || !/^[A-Za-z0-9_-]+$/.test(seg)) return seg;
      const hasDigit = /\d/.test(seg);
      const hasSeparator = /[-_]/.test(seg);
      const hasMixedCase = /[a-z]/.test(seg) && /[A-Z]/.test(seg);
      return hasDigit || hasSeparator || hasMixedCase ? ":id" : seg;
    })
    .join("/");
}

/** Parse one log line, or null if it is not a completed request. */
export function parseLine(line: string, service: string): RequestRow | null {
  if (!line.includes('"request.end"')) return null;
  let logEntry: Record<string, unknown>;
  try {
    logEntry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A partially written line at the tail of an active log. Skipping it is
    // correct — the next pass picks it up once complete.
    return null;
  }
  if (logEntry.msg !== "request.end") return null;

  const ts = typeof logEntry.time === "string" ? Date.parse(logEntry.time) : Number(logEntry.time ?? 0);
  const path = typeof logEntry.path === "string" ? logEntry.path : "";
  const method = typeof logEntry.method === "string" ? logEntry.method : "";
  const status = Number(logEntry.statusCode ?? 0);
  const durationMs = Number(logEntry.duration ?? 0);
  if (!Number.isFinite(ts) || ts <= 0 || !path || !method || !status) return null;

  // requestId makes the row idempotent across re-ingests of the same file.
  const requestId = typeof logEntry.requestId === "string" ? logEntry.requestId : `${ts}-${path}-${status}`;
  return {
    id: `${service}:${requestId}`,
    service,
    method,
    path: templatePath(path),
    status,
    durationMs,
    ts: Math.floor(ts / 1000),
  };
}

/** Newest timestamp already stored for a service, or 0. */
export function watermark(db: Db, service: string): number {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM request WHERE service = ?")
    .get(service) as { ts: number | null } | undefined;
  return row?.ts ?? 0;
}




// Resume by byte offset while excluding records at or before the watermark.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-185
export async function ingestLog(db: Db, file: string, service: string): Promise<IngestResult> {
  if (!existsSync(file)) return { read: 0, inserted: 0 };
  const since = watermark(db, service);

  const sizeBytes = statSync(file).size;
  const startOffset = resolveStartOffset(getFileOffset(db, file), sizeBytes);
  // Nothing new since the last pass — skip the read entirely rather than
  // opening a stream just to immediately hit EOF.
  if (startOffset >= sizeBytes) return { read: 0, inserted: 0 };

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO request (id, service, method, path, status, duration_ms, ts)
     VALUES (?,?,?,?,?,?,?)`,
  );

  const batch: RequestRow[] = [];
  // Returns rows ACTUALLY inserted. `INSERT OR IGNORE` skips a row whose id is
  // already stored, and `changes` is the only place that shows up. Must stay
  // synchronous: db.transaction() throws on a function returning a promise.
  const flush = db.transaction((rows: RequestRow[]) => {
    let count = 0;
    for (const r of rows) {
      count += stmt.run(r.id, r.service, r.method, r.path, r.status, r.durationMs, r.ts).changes;
    }
    return count;
  });

  // See framework/tail.ts's IngestResult: `read` proves the pass parsed lines,
  // `inserted` proves they were new, and after a truncation-driven re-read the
  // second is legitimately 0 while the first is not.
  let read = 0;
  let inserted = 0;
  // Bytes actually consumed as COMPLETE lines. Tracked separately from
  // `sizeBytes` because the file can still be growing: readline yields
  // whatever trails the last newline too, even if it is a partial write in
  // progress (parseLine's own catch already treats that as "not a request
  // yet" for exactly this reason). Advancing the offset past a partial line
  // would be worse than the old re-scan-everything behaviour: the next pass
  // would start reading AFTER it, and the rest of that record — once the
  // writer finishes it — would never be seen. So only lines confirmed to end
  // in a newline count toward the stored offset; a trailing partial line is
  // left for the next pass to pick up complete.
  let consumedBytes = startOffset;
  const rl = createInterface({
    input: createReadStream(file, { start: startOffset, encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  // readline strips the trailing newline from `file` itself, so whether the
  // stream ended ON one has to be checked directly rather than inferred from
  // the last yielded line.
  const endsWithNewline = sizeBytes > startOffset && lastByteIsNewline(file);

  let sawLine = false;
  let pendingBytes = 0;
  for await (const line of rl) {
    if (sawLine) consumedBytes += pendingBytes; // the PREVIOUS line, now confirmed complete
    pendingBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for the newline readline split on
    sawLine = true;

    const row = parseLine(line, service);
    // `>=` rather than `>`: several requests can share a second, and the id
    // dedupe handles the overlap.
    if (!row || row.ts < since) continue;
    batch.push(row);
    if (batch.length >= 500) {
      // Count the batch BEFORE splice empties it. This read `written += 500`,
      // which is right only while the threshold and the literal agree —
      // changing one would have silently miscounted.
      read += batch.length;
      inserted += flush(batch.splice(0, batch.length));
    }
  }
  // The final line counts only if the file actually ended with a newline
  // after it — otherwise it is (or might still be) an in-progress write.
  if (sawLine && endsWithNewline) consumedBytes += pendingBytes;

  if (batch.length > 0) {
    read += batch.length;
    inserted += flush(batch);
  }
  setFileOffset(db, file, consumedBytes);
  return { read, inserted };
}

/** Whether the last byte of `file` is a newline. Cheap: reads one byte. */
function lastByteIsNewline(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const lastByte = Buffer.alloc(1);
    readSync(fd, lastByte, 0, 1, size - 1);
    return lastByte[0] === 0x0a;
  } catch {
    // Cannot confirm — treat as "not confirmed complete", the same
    // conservative answer as any other partial-line case.
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Services whose logs this collector reads, and where they live. */
export function defaultLogSources(logDir?: string): Array<{ service: string; file: string }> {
  return serviceLogSources(logDir);
}


/** Drop rows past the horizon. */
export function pruneRequests(db: Db, olderThanSec: number): number {
  return db.prepare("DELETE FROM request WHERE ts < ?").run(olderThanSec).changes;
}

/** Requests per bucket, for the volume sparkline. */
export function requestVolume(db: Db, sinceSec: number, bucketSec: number): Array<{ ts: number; requests: number; errors: number }> {
  return db
    .prepare(
      // CAST to INTEGER is load-bearing. A bound parameter arrives as a float,
      // so `ts / ?` is float division and nothing truncates — every second
      // becomes its own bucket. That produced 2,406 "daily" buckets for a 30-day
      // window, each showing one request: a chart that renders plausibly and is
      // entirely wrong. The same query with a literal 86400 gives 9.
      `SELECT CAST(ts / CAST(:bucket AS INTEGER) AS INTEGER) * CAST(:bucket AS INTEGER) AS ts,
              COUNT(*)                                       AS requests,
              SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors
       FROM request
       WHERE ts >= :since
       GROUP BY CAST(ts / CAST(:bucket AS INTEGER) AS INTEGER)
       ORDER BY 1`,
    )
    .all({ bucket: bucketSec, since: sinceSec }) as Array<{ ts: number; requests: number; errors: number }>;
}

// Aggregate route latency and errors from measured requests, retaining the selected time window.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-186
export function routeLatency(
  db: Db,
  sinceSec: number,
  minSamples = 5,
): Array<{ path: string; service: string; requests: number; p50: number; p95: number; p99: number; errors: number; clientErrors: number }> {
  return db
    .prepare(
      `WITH ranked AS (
         SELECT path, service, duration_ms, status,
                ROW_NUMBER() OVER (PARTITION BY path ORDER BY duration_ms) AS rn,
                COUNT(*)    OVER (PARTITION BY path)                       AS n
         FROM request
         WHERE ts >= ?
       )
       SELECT path,
              MIN(service)                                                    AS service,
              MAX(n)                                                          AS requests,
              MAX(CASE WHEN rn = MAX(1, n / 2)          THEN duration_ms END) AS p50,
              MAX(CASE WHEN rn = MAX(1, (n * 95) / 100) THEN duration_ms END) AS p95,
              MAX(CASE WHEN rn = MAX(1, (n * 99) / 100) THEN duration_ms END) AS p99,
              SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END)                  AS errors,
              SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS clientErrors
       FROM ranked
       GROUP BY path
       HAVING MAX(n) >= ?
       ORDER BY p95 DESC`,
    )
    .all(sinceSec, minSamples) as never;
}

/** Status-code mix, so 429s and 500s are visible rather than averaged away. */
export function statusMix(db: Db, sinceSec: number): Array<{ status: number; requests: number }> {
  return db
    .prepare(
      `SELECT status, COUNT(*) AS requests
       FROM request WHERE ts >= ?
       GROUP BY status ORDER BY requests DESC`,
    )
    .all(sinceSec) as Array<{ status: number; requests: number }>;
}

/** Per-service totals, so one service's outage is not hidden in a global average. */
export function serviceMix(db: Db, sinceSec: number): Array<{ service: string; requests: number; errors: number; p95: number }> {
  return db
    .prepare(
      `WITH ranked AS (
         SELECT service, duration_ms, status,
                ROW_NUMBER() OVER (PARTITION BY service ORDER BY duration_ms) AS rn,
                COUNT(*)    OVER (PARTITION BY service)                       AS n
         FROM request WHERE ts >= ?
       )
       SELECT service,
              MAX(n)                                                          AS requests,
              SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END)                  AS errors,
              MAX(CASE WHEN rn = MAX(1, (n * 95) / 100) THEN duration_ms END) AS p95
       FROM ranked GROUP BY service ORDER BY requests DESC`,
    )
    .all(sinceSec) as never;
}

/** Oldest and newest request stored — the honest extent of the history. */
export function coverage(db: Db): { oldest?: number; newest?: number; total: number } {
  const row = db
    .prepare("SELECT MIN(ts) AS oldest, MAX(ts) AS newest, COUNT(*) AS total FROM request")
    .get() as { oldest: number | null; newest: number | null; total: number };
  return { oldest: row.oldest ?? undefined, newest: row.newest ?? undefined, total: row.total };
}

export const STORE_DDL = generatedMigrations[0].sql;
export const MIGRATIONS = generatedMigrations;
