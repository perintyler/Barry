// Store all log levels with retention suited to their volume, separately from request telemetry.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-073

import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  getFileOffset,
  setFileOffset,
  resolveStartOffset,
  type IngestResult,
} from "./framework/tail.js";
// The format and the store come from the sub-bag. Parent -> child: this file
// COLLECTS, and collection is the one thing the sub-bag deliberately does not
// own. Re-exported below so existing importers of `src/logs.js` keep working.
import { LEVEL, parseLine, type LogRow } from "@barry-rocks/sdk/logging";
import { openLogsDb, logsDbPath, prune, RETENTION_DAYS, type Db } from "@barry-rocks/logs-bag/store";
import { serviceLogSources } from "./framework/log-sources.js";

export { LEVEL, parseLine, openLogsDb, logsDbPath, prune, RETENTION_DAYS };
export type { LogRow, Db };

/** `bag-<name>-stdout.log` -> `<name>`, plus core's in-repo log. */
export function defaultLogSources(logDir?: string): Array<{ service: string; file: string }> {
  return serviceLogSources(logDir);
}

// Advance offsets only through complete lines; failed parsing must not lose future writes.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-074
export async function ingestLog(db: Db, file: string, service: string): Promise<IngestResult> {
  if (!existsSync(file)) return { read: 0, inserted: 0 };

  const sizeBytes = statSync(file).size;
  const startOffset = resolveStartOffset(getFileOffset(db, file), sizeBytes);
  if (startOffset >= sizeBytes) return { read: 0, inserted: 0 };

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO log_event (id, ts, level, service, msg, ctx)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const batch: LogRow[] = [];
  // Returns rows ACTUALLY inserted. This store has no watermark filter, so
  // `INSERT OR IGNORE` is the ONLY thing deduping a re-read — which makes the
  // read/inserted split more load-bearing here than in the other two, not less.
  // Must stay synchronous: db.transaction() rejects a promise-returning fn.
  const flush = db.transaction((rows: LogRow[]) => {
    let count = 0;
    for (const r of rows) count += stmt.run(r.id, r.ts, r.level, r.service, r.msg, r.ctx).changes;
    return count;
  });

  let consumedBytes = startOffset;
  let read = 0;
  let inserted = 0;
  const rl = createInterface({
    input: createReadStream(file, { start: startOffset, encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    consumedBytes += Buffer.byteLength(line, "utf8") + 1;
    const row = parseLine(line, service);
    if (!row) continue;
    batch.push(row);
    if (batch.length >= 1000) {
      read += batch.length;
      inserted += flush(batch);
      batch.length = 0;
    }
  }
  if (batch.length) {
    read += batch.length;
    inserted += flush(batch);
  }

  // Never past the file's size: a final partial line would otherwise push the
  // offset beyond what was actually consumed.
  setFileOffset(db, file, Math.min(consumedBytes, sizeBytes));
  return { read, inserted };
}

export function coverage(db: Db): {
  events: number;
  oldest: number | null;
  newest: number | null;
  services: number;
} {
  return db
    .prepare(
      `SELECT COUNT(*) AS events, MIN(ts) AS oldest, MAX(ts) AS newest,
              COUNT(DISTINCT service) AS services FROM log_event`,
    )
    .get() as { events: number; oldest: number | null; newest: number | null; services: number };
}

export interface SearchOptions {
  sinceSec: number;
  service?: string;
  minLevel?: number;
  text?: string;
  limit?: number;
}

/** Free-text search, newest first. */
export function search(db: Db, opts: SearchOptions): LogRow[] {
  const where = ["ts >= ?"];
  const params: unknown[] = [opts.sinceSec];
  if (opts.service) {
    where.push("service = ?");
    params.push(opts.service);
  }
  if (opts.minLevel !== undefined) {
    where.push("level >= ?");
    params.push(opts.minLevel);
  }
  if (opts.text) {
    where.push("(msg LIKE ? OR ctx LIKE ?)");
    params.push(`%${opts.text}%`, `%${opts.text}%`);
  }
  params.push(Math.min(opts.limit ?? 100, 1000));

  return db
    .prepare(
      `SELECT id, ts, level, service, msg, ctx FROM log_event
        WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
    )
    .all(...params) as LogRow[];
}

/** Volume per bucket, split by level -- the shape a spike alert reads. */
export function volume(
  db: Db,
  sinceSec: number,
  bucketSec: number,
): Array<{ ts: number; level: number; events: number }> {
  return db
    .prepare(
      // GROUP BY the EXPRESSION, not the alias.
      //
      // The rule, stated precisely because the loose version is unusable:
      // **never give a computed alias the name of a column in scope.** SQLite
      // resolves a bare name in GROUP BY to the source column when one exists,
      // and to the alias when none does. So `... AS bucket ... GROUP BY bucket`
      // is correct (metric_point has no `bucket`), while `... AS ts ... GROUP
      // BY ts` silently groups by raw second -- which is what this did,
      // returning 2,067 rows for an hour that should have produced 26. Every
      // value in them was plausible; only the count gave it away.
      //
      // Verified against every GROUP BY in this bag: the others are ordinals,
      // real columns, or non-shadowing aliases (`bucket`, `day`), so this was
      // the only instance. The grep-checkable form of the rule is what makes
      // that audit possible at all.
      `SELECT CAST(ts / ? AS INTEGER) * ? AS ts, level, COUNT(*) AS events
         FROM log_event WHERE ts >= ?
        GROUP BY CAST(ts / ? AS INTEGER), level
        ORDER BY 1`,
    )
    .all(bucketSec, bucketSec, sinceSec, bucketSec) as Array<{ ts: number; level: number; events: number }>;
}

/** Which services are logging, and at what severity. */
export function services(
  db: Db,
  sinceSec: number,
): Array<{ service: string; events: number; errors: number }> {
  return db
    .prepare(
      `SELECT service, COUNT(*) AS events,
              SUM(CASE WHEN level >= ${LEVEL.error} THEN 1 ELSE 0 END) AS errors
         FROM log_event WHERE ts >= ? GROUP BY service ORDER BY events DESC`,
    )
    .all(sinceSec) as Array<{ service: string; events: number; errors: number }>;
}
