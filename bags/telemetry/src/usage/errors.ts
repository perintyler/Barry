import generatedMigrations from "../generated/errors-migrations.js";
import { migratedStorePath } from "@barry-rocks/sdk/stores";
// Ingest structured warning/error events independently of request timing telemetry.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-159

import Database from "better-sqlite3";
// Shared with requests.ts, which tails the same files for a different question.
// The offset machinery lives in the framework so a second ingester cannot be
// written without it — see ingestLog below.
import {
  getFileOffset,
  setFileOffset,
  resolveStartOffset,
  logSizeMb,
  type IngestResult,
} from "../framework/tail.js";
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

/** pino numeric levels this store keeps. Below `warn` is not an incident. */
export const WARN_LEVEL = 40;
export const ERROR_LEVEL = 50;

/** `~/.barry/errors.db`, beside the other local telemetry. */
export function errorsDbPath(): string {
  return process.env.BARRY_ERRORS_DB || migratedStorePath("telemetry", "errors", () => join(bagDataDir("telemetry"), "errors.db"), "errors", "node");
}

export function openErrorsDb(path = errorsDbPath()): Db {
  // `busy_timeout` because more than one PROCESS writes this store —
  // errors.db is written by the ingest job and read by the web app and tools.
  // Unlike metrics.db, whose single writer means a timeout would hide
  // contention rather than survive it.
  return openBagStore({ path, ddl: STORE_DDL, migrations: MIGRATIONS, busyTimeoutMs: 5000 });
}

/** One parsed warn/error line. */
export interface ErrorRow {
  id: string;
  ts: number;
  level: number;
  service: string;
  msg: string;
  /** The error text, when the event carried one. */
  detail: string;
  /** Remaining structured fields as JSON — the varying part, kept out of columns. */
  ctx: string;
}

/**
 * Fields that are either already columns or pure noise in every line.
 *
 * `name` duplicates `service`; `time`/`level`/`msg` are columns; `hostname`
 * and `pid` never varied usefully in practice.
 */
const CTX_OMIT = new Set(["level", "time", "msg", "service", "name", "hostname", "pid", "err", "error"]);

// Normalize volatile identifiers so equal error shapes group together without losing event evidence.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-160
export function signature(msg: string): string {
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(msg)) return msg;
  return msg
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .slice(0, 200);
}

/** Parse one log line, or null if it is not a warn/error event. */
export function parseLine(line: string, service: string): ErrorRow | null {
  // Cheap pre-filter: the overwhelming majority of lines are level 30, and
  // JSON.parse on ~88k of them per pass is the whole cost of this collector.
  if (!line.includes('"level":4') && !line.includes('"level":5')) return null;

  let logEntry: Record<string, unknown>;
  try {
    logEntry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A partially written line at the tail of an active log. The next pass
    // picks it up once complete.
    return null;
  }

  const level = Number(logEntry.level ?? 0);
  if (!Number.isFinite(level) || level < WARN_LEVEL) return null;

  const ts = typeof logEntry.time === "string" ? Date.parse(logEntry.time) : Number(logEntry.time ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return null;

  const msg = typeof logEntry.msg === "string" ? logEntry.msg : "";
  if (!msg) return null;

  // `request.end` is logged at error level for any 5xx, so it arrives here as
  // one event per failed request — 120 of the first 212 ingested, all of them
  // restating a failure whose cause is logged separately on its own line. The
  // requests store already owns status codes and per-route error rates; keeping
  // these too would make "top errors" a list of HTTP envelopes with the actual
  // faults pushed below them.
  if (msg === "request.end") return null;

  // The error text lives under `error` in Barry's events and `err` in pino's
  // own serializer. Keep whichever is present as its own column so search does
  // not have to reach into JSON.
  const rawError = logEntry.error ?? logEntry.err;
  const detail =
    typeof rawError === "string"
      ? rawError
      : rawError && typeof rawError === "object"
        ? String((rawError as Record<string, unknown>).message ?? JSON.stringify(rawError))
        : "";

  const ctx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(logEntry)) {
    if (!CTX_OMIT.has(k)) ctx[k] = v;
  }

  const svc = typeof logEntry.service === "string" ? logEntry.service : service;

  // Deterministic id so re-reading a file after truncation cannot duplicate
  // rows. requestId/sessionId disambiguate events sharing a millisecond.
  const disambiguator =
    (typeof logEntry.requestId === "string" ? logEntry.requestId : "") ||
    (typeof logEntry.sessionId === "string" ? logEntry.sessionId : "") ||
    "";
  return {
    id: `${service}:${ts}:${msg}:${disambiguator}`,
    ts: Math.floor(ts / 1000),
    level,
    service: svc,
    msg,
    detail,
    ctx: JSON.stringify(ctx),
  };
}

/** Newest timestamp already stored for a service, or 0. */
export function watermark(db: Db, service: string): number {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM error_event WHERE service = ?")
    .get(service) as { ts: number | null } | undefined;
  return row?.ts ?? 0;
}

// Resume at byte offsets and apply the watermark without rereading the whole file each pass.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-161
export async function ingestLog(db: Db, file: string, service: string): Promise<IngestResult> {
  if (!existsSync(file)) return { read: 0, inserted: 0 };
  const since = watermark(db, service);

  const sizeBytes = statSync(file).size;
  const startOffset = resolveStartOffset(getFileOffset(db, file), sizeBytes);
  // Nothing new since the last pass — skip the read entirely rather than
  // opening a stream just to immediately hit EOF.
  if (startOffset >= sizeBytes) return { read: 0, inserted: 0 };

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO error_event (id, ts, level, service, msg, detail, ctx)
     VALUES (?,?,?,?,?,?,?)`,
  );

  // Returns rows ACTUALLY inserted, not rows offered. `INSERT OR IGNORE`
  // silently skips a row whose deterministic id is already stored, and
  // `changes` is the only place that shows up — better-sqlite3 reports it per
  // statement, and the transaction wrapper is a thin BEGIN/COMMIT bracket that
  // does not aggregate or reset it.
  //
  // Must stay synchronous: db.transaction() throws on a function returning a
  // promise.
  const flush = db.transaction((rows: ErrorRow[]) => {
    let inserted = 0;
    for (const r of rows) {
      inserted += stmt.run(r.id, r.ts, r.level, r.service, r.msg, r.detail, r.ctx).changes;
    }
    return inserted;
  });

  const batch: ErrorRow[] = [];
  // Two numbers, because one cannot answer both questions. `read` is what the
  // pass parsed out of the file; `inserted` is what was new. They diverge
  // legitimately after a truncation — the offset resets, the retained tail is
  // re-read, and every row is already stored — so reporting only `inserted`
  // would print 0 for a perfectly healthy pass and make it indistinguishable
  // from a collector that read nothing at all. That is the failure this bag
  // exists to catch, so it must not be introduced by the fix for the opposite
  // one.
  let read = 0;
  let inserted = 0;
  // Bytes actually consumed as COMPLETE lines. Tracked separately from
  // `sizeBytes` because the file can still be growing: readline yields
  // whatever trails the last newline too, even if it is a partial write in
  // progress (parseLine's own catch already treats that as "not an event yet"
  // for exactly this reason). Advancing the offset past a partial line would
  // be worse than the old re-scan-everything behaviour: the next pass would
  // start reading AFTER it, and the rest of that record — once the writer
  // finishes it — would never be seen. So only lines confirmed to end in a
  // newline count toward the stored offset; a trailing partial line is left
  // for the next pass to pick up complete.
  let consumedBytes = startOffset;
  const rl = createInterface({
    input: createReadStream(file, { start: startOffset, encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  // readline strips the trailing newline from the final line itself, so whether
  // the stream ended ON one has to be checked directly rather than inferred
  // from the last yielded line.
  const endsWithNewline = sizeBytes > startOffset && lastByteIsNewline(file);

  let sawLine = false;
  let pendingBytes = 0;
  for await (const line of rl) {
    if (sawLine) consumedBytes += pendingBytes; // the PREVIOUS line, now confirmed complete
    pendingBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for the newline readline split on
    sawLine = true;

    const row = parseLine(line, service);
    // `<` rather than `<=`: several events can share a second, and the id
    // dedupe handles the overlap.
    if (!row || row.ts < since) continue;
    batch.push(row);
    if (batch.length >= 500) {
      read += batch.length;
      inserted += flush(batch.splice(0, batch.length));
    }
  }
  // The final line counts only if the file actually ended with a newline after
  // it — otherwise it is (or might still be) an in-progress write.
  if (sawLine && endsWithNewline) consumedBytes += pendingBytes;

  if (batch.length > 0) {
    read += batch.length;
    inserted += flush(batch);
  }
  setFileOffset(db, file, consumedBytes);
  return { read, inserted };
}

// A terminating newline confirms the last log record is complete.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-162
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

// Discover supervised service logs dynamically rather than maintaining a stale name list.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-163
export function defaultLogSources(logDir?: string): Array<{ service: string; file: string }> {
  return serviceLogSources(logDir);
}


/** Drop rows past the horizon. */
export function pruneErrors(db: Db, olderThanSec: number): number {
  return db.prepare("DELETE FROM error_event WHERE ts < ?").run(olderThanSec).changes;
}

/**
 * What the store actually holds.
 *
 * Reported before any window-scoped number so a short history reads as a short
 * history rather than as a quiet period.
 */
export function coverage(db: Db): { events: number; oldest: number | null; newest: number | null; services: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS events, MIN(ts) AS oldest, MAX(ts) AS newest,
              COUNT(DISTINCT service) AS services
       FROM error_event`,
    )
    .get() as { events: number; oldest: number | null; newest: number | null; services: number };
  return row;
}

/** Events per bucket, split by level — the shape an error-spike alert reads. */
export function errorVolume(
  db: Db,
  sinceSec: number,
  bucketSec: number,
): Array<{ ts: number; errors: number; warnings: number }> {
  return db
    .prepare(
      // CAST to INTEGER is load-bearing: a bound parameter arrives as a float,
      // so `ts / ?` is float division and every second becomes its own bucket.
      // The requests store learned this the hard way — 2,406 "daily" buckets
      // for a 30-day window, a chart that renders plausibly and is wrong.
      `SELECT CAST(ts / CAST(:bucket AS INTEGER) AS INTEGER) * CAST(:bucket AS INTEGER) AS ts,
              SUM(CASE WHEN level >= 50 THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN level  = 40 THEN 1 ELSE 0 END) AS warnings
       FROM error_event
       WHERE ts >= :since
       GROUP BY CAST(ts / CAST(:bucket AS INTEGER) AS INTEGER)
       ORDER BY 1`,
    )
    .all({ bucket: bucketSec, since: sinceSec }) as Array<{ ts: number; errors: number; warnings: number }>;
}

/** Distinct failures by frequency — the "what is broken right now" list. */
export function topErrors(
  db: Db,
  sinceSec: number,
  limit = 20,
): Array<{ msg: string; service: string; level: number; count: number; lastSeen: number; sample: string }> {
  return db
    .prepare(
      `SELECT msg,
              MIN(service)  AS service,
              MAX(level)    AS level,
              COUNT(*)      AS count,
              MAX(ts)       AS lastSeen,
              -- The detail from the most recent occurrence, not an arbitrary
              -- one: when an error changes shape, the newest text is the one
              -- that describes what is happening now.
              (SELECT detail FROM error_event e2
                WHERE e2.msg = e1.msg AND e2.ts >= :since
                ORDER BY e2.ts DESC LIMIT 1) AS sample
       FROM error_event e1
       WHERE ts >= :since
       GROUP BY msg
       ORDER BY count DESC, lastSeen DESC
       LIMIT :limit`,
    )
    .all({ since: sinceSec, limit }) as never;
}

/** Per-service totals, so one service's outage is not averaged into calm. */
export function serviceMix(db: Db, sinceSec: number): Array<{ service: string; errors: number; warnings: number }> {
  return db
    .prepare(
      `SELECT service,
              SUM(CASE WHEN level >= 50 THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN level  = 40 THEN 1 ELSE 0 END) AS warnings
       FROM error_event
       WHERE ts >= ?
       GROUP BY service
       ORDER BY errors DESC, warnings DESC`,
    )
    .all(sinceSec) as Array<{ service: string; errors: number; warnings: number }>;
}

/**
 * Individual events, newest first — the thing Axiom was actually good for.
 *
 * `text` matches message OR detail: during an incident you have a fragment and
 * do not know which field it came from.
 */
export function searchErrors(
  db: Db,
  opts: { sinceSec: number; service?: string; level?: number; text?: string; limit?: number },
): Array<{ ts: number; level: number; service: string; msg: string; detail: string; ctx: string }> {
  const clauses = ["ts >= :since"];
  const params: Record<string, unknown> = { since: opts.sinceSec, limit: opts.limit ?? 50 };
  if (opts.service) {
    clauses.push("service = :service");
    params.service = opts.service;
  }
  if (opts.level !== undefined) {
    clauses.push("level >= :level");
    params.level = opts.level;
  }
  if (opts.text) {
    clauses.push("(msg LIKE :text OR detail LIKE :text)");
    params.text = `%${opts.text}%`;
  }
  return db
    .prepare(
      `SELECT ts, level, service, msg, detail, ctx
       FROM error_event
       WHERE ${clauses.join(" AND ")}
       ORDER BY ts DESC
       LIMIT :limit`,
    )
    .all(params) as never;
}

// Emit cumulative per-service severity counts so subsequent samples can measure ingestion progress.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-164
export function errorCounters(db: Db): Array<{ service: string; level: string; count: number }> {
  return db
    .prepare(
      `SELECT service,
              CASE WHEN level >= 50 THEN 'error' ELSE 'warn' END AS level,
              COUNT(*) AS count
       FROM error_event
       GROUP BY service, CASE WHEN level >= 50 THEN 'error' ELSE 'warn' END
       ORDER BY service, level`,
    )
    .all() as Array<{ service: string; level: string; count: number }>;
}

export const STORE_DDL = generatedMigrations[0].sql;
export const MIGRATIONS = generatedMigrations;
