import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRequestsDb, ingestLog, parseLine, templatePath, requestVolume,
  routeLatency, coverage, watermark, defaultLogSources,
  getFileOffset, setFileOffset, resolveStartOffset, type Db,
} from "./requests.js";

const NOW = 1_800_000_000;

describe("request ingest", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "requests-"));
    db = openRequestsDb(join(dir, "r.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const line = (over: Record<string, unknown> = {}) => JSON.stringify({
    level: 30, time: new Date(NOW * 1000).toISOString(), msg: "request.end",
    requestId: "req-1", method: "GET", path: "/api/v1/sessions",
    statusCode: 200, duration: 42, ...over,
  });

  it("parses a request.end line", () => {
    const row = parseLine(line(), "api");
    expect(row).toMatchObject({ service: "api", method: "GET", status: 200, durationMs: 42 });
  });

  it("ignores lines that are not completed requests", () => {
    expect(parseLine(JSON.stringify({ msg: "request.start", path: "/x" }), "api")).toBeNull();
    expect(parseLine("not json at all", "api")).toBeNull();
    // A half-written line at the tail of a live log; the next pass gets it.
    expect(parseLine('{"msg":"request.end","path":"/x"', "api")).toBeNull();
  });

  // Normalize legacy raw request IDs at ingest so one handler does not fragment into many routes.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-109
  it("templates identifier segments as it ingests", () => {
    const row = parseLine(line({ path: "/api/v1/sessions/F_1aL9OLQsKGNCZNxxyC9/messages" }), "web");
    expect(row?.path).toBe("/api/v1/sessions/:id/messages");
  });

  it("leaves real route segments intact", () => {
    for (const p of ["/health", "/config.json", "/api/v1/sessions", "/bags/available"]) {
      expect(templatePath(p)).toBe(p);
    }
  });

  it("ingests a log file and is idempotent on re-run", async () => {
    const file = join(dir, "stdout.log");
    writeFileSync(file, [line({ requestId: "a" }), line({ requestId: "b" }), ""].join("\n"));

    expect(await ingestLog(db, file, "api")).toEqual({ read: 2, inserted: 2 });
    expect(coverage(db).total).toBe(2);

    // Re-reading the same file must not duplicate: after a truncation the
    // collector re-reads from the start.
    await ingestLog(db, file, "api");
    expect(coverage(db).total).toBe(2);
  });

  it("tracks a watermark per service", async () => {
    const file = join(dir, "s.log");
    writeFileSync(file, line({ requestId: "a" }) + "\n");
    await ingestLog(db, file, "api");
    expect(watermark(db, "api")).toBe(NOW);
    // A service with no rows starts from the beginning, not from another's mark.
    expect(watermark(db, "web")).toBe(0);
  });

  // Latency bucket boundaries must agree with stored units and exclude unavailable durations.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-180
  it("buckets by whole days, not by second", async () => {
    const file = join(dir, "v.log");
    const rows: string[] = [];
    // Three requests spread across one day, at different seconds.
    for (const offset of [0, 3_600, 7_200]) {
      rows.push(line({ requestId: `r${offset}`, time: new Date((NOW + offset) * 1000).toISOString() }));
    }
    // One on the next day.
    rows.push(line({ requestId: "next", time: new Date((NOW + 90_000) * 1000).toISOString() }));
    writeFileSync(file, rows.join("\n") + "\n");
    await ingestLog(db, file, "api");

    const buckets = requestVolume(db, NOW - 86_400, 86_400);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].requests).toBe(3);
    expect(buckets[1].requests).toBe(1);
  });

  it("counts server errors separately from client errors", async () => {
    const file = join(dir, "e.log");
    writeFileSync(file, [
      line({ requestId: "ok", statusCode: 200, duration: 10 }),
      line({ requestId: "client", statusCode: 404, duration: 10 }),
      line({ requestId: "server", statusCode: 500, duration: 10 }),
      line({ requestId: "limited", statusCode: 429, duration: 10 }),
    ].join("\n") + "\n");
    await ingestLog(db, file, "api");

    const [route] = routeLatency(db, NOW - 86_400, 1);
    expect(route.requests).toBe(4);
    // 5xx is the service failing; 4xx is the caller being told no. A single
    // "errors" number would hide a rate-limit storm inside an outage.
    expect(route.errors).toBe(1);
    expect(route.clientErrors).toBe(2);
  });

  it("reports the real extent of stored history", async () => {
    const file = join(dir, "c.log");
    writeFileSync(file, [
      line({ requestId: "old", time: new Date((NOW - 5_000) * 1000).toISOString() }),
      line({ requestId: "new", time: new Date(NOW * 1000).toISOString() }),
    ].join("\n") + "\n");
    await ingestLog(db, file, "api");

    const c = coverage(db);
    expect(c.oldest).toBe(NOW - 5_000);
    expect(c.newest).toBe(NOW);
  });

  it("returns no coverage for an empty store", () => {
    expect(coverage(db)).toEqual({ oldest: undefined, newest: undefined, total: 0 });
  });

  it("ingesting a missing file is a no-op", async () => {
    expect(await ingestLog(db, join(dir, "nope.log"), "api")).toEqual({ read: 0, inserted: 0 });
  });


});

// Resume request-log ingestion by byte offset, including multibyte input and truncation.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-181
describe("resolveStartOffset", () => {
  it("resumes from the stored offset when it still fits inside the file", () => {
    expect(resolveStartOffset(500, 1000)).toBe(500);
  });

  it("resets to 0 when the stored offset is past the current file size — rotation/truncation", () => {
    // The exact defect the review called out: offset stored at 10000, file
    // now sized 500 (rotated or truncated out from under the ingester).
    expect(resolveStartOffset(10000, 500)).toBe(0);
  });

  it("treats an offset equal to the file size as caught up, not as needing a reset", () => {
    expect(resolveStartOffset(1000, 1000)).toBe(1000);
  });

  // Invalid saved offsets reset to zero rather than crashing or seeking outside meaningful input.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-110
  it("resets to 0 for a corrupt stored offset instead of crashing or reading garbage", () => {
    expect(resolveStartOffset(-1, 1000)).toBe(0);
    expect(resolveStartOffset(-500000, 1000)).toBe(0);
    expect(resolveStartOffset(NaN, 1000)).toBe(0);
    expect(resolveStartOffset(Infinity, 1000)).toBe(0);
    expect(resolveStartOffset(1.5, 1000)).toBe(0);
  });
});

describe("ingestLog byte-offset resumption", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "requests-offset-"));
    db = openRequestsDb(join(dir, "r.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const line = (over: Record<string, unknown> = {}) => JSON.stringify({
    level: 30, time: new Date(NOW * 1000).toISOString(), msg: "request.end",
    requestId: "req-1", method: "GET", path: "/api/v1/sessions",
    statusCode: 200, duration: 42, ...over,
  });

  it("persists a byte offset after ingesting, and resumes from it rather than 0", async () => {
    const file = join(dir, "a.log");
    writeFileSync(file, line({ requestId: "a" }) + "\n");
    await ingestLog(db, file, "api");

    const afterFirst = getFileOffset(db, file);
    expect(afterFirst).toBeGreaterThan(0);

    // Append more without touching the earlier bytes, then ingest again.
    appendFileSync(file, line({ requestId: "b", time: new Date((NOW + 1) * 1000).toISOString() }) + "\n");
    const written = await ingestLog(db, file, "api");

    expect(written).toEqual({ read: 1, inserted: 1 }); // only the newly appended row
    expect(coverage(db).total).toBe(2);
    expect(getFileOffset(db, file)).toBeGreaterThan(afterFirst);
  });

  it("does not re-read anything when called again with no new bytes appended", async () => {
    const file = join(dir, "b.log");
    writeFileSync(file, line({ requestId: "a" }) + "\n");
    await ingestLog(db, file, "api");
    const offset = getFileOffset(db, file);

    expect(await ingestLog(db, file, "api")).toEqual({ read: 0, inserted: 0 });
    expect(getFileOffset(db, file)).toBe(offset);
  });

  // An offset beyond current EOF indicates rotation and requires replay from zero.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-111
  it("detects a truncated file and re-reads from the start", async () => {
    const file = join(dir, "c.log");
    writeFileSync(file, [
      line({ requestId: "old1" }),
      line({ requestId: "old2", time: new Date((NOW + 1) * 1000).toISOString() }),
    ].join("\n") + "\n");
    await ingestLog(db, file, "api");
    expect(coverage(db).total).toBe(2);

    // Simulate the stored offset surviving a rotation: force it far past what
    // the new (shorter) file will actually contain.
    setFileOffset(db, file, 10000);

    // The file is now rotated: shorter, with new content that legitimately
    // overlaps the old byte range.
    writeFileSync(file, line({ requestId: "new1", time: new Date((NOW + 2) * 1000).toISOString() }) + "\n");
    expect(getFileOffset(db, file)).toBeGreaterThan(statSync(file).size);

    const written = await ingestLog(db, file, "api");
    // Re-read from 0: the new row is captured. (The watermark filter, not the
    // offset, is what would additionally suppress old1/old2 if they somehow
    // reappeared — they do not here because the file was truly replaced.)
    expect(written).toEqual({ read: 1, inserted: 1 });
    expect(coverage(db).total).toBe(3);
    expect(getFileOffset(db, file)).toBeLessThanOrEqual(statSync(file).size);
  });

  // A corrupt negative offset resets ingestion exactly like truncation rather than seeking invalid input.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-182
  it("recovers from a corrupt (negative) stored offset instead of crashing", async () => {
    const file = join(dir, "d.log");
    writeFileSync(file, line({ requestId: "x" }) + "\n");

    setFileOffset(db, file, -12345);

    await expect(ingestLog(db, file, "api")).resolves.toEqual({ read: 1, inserted: 1 });
    expect(coverage(db).total).toBe(1);
    expect(getFileOffset(db, file)).toBeGreaterThanOrEqual(0);
  });

  // Do not advance the saved offset through a partial trailing record.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-112
  it("does not advance the offset past an incomplete trailing line", async () => {
    const file = join(dir, "e.log");
    const complete = line({ requestId: "a" });
    writeFileSync(file, complete + "\n" + '{"msg":"request.end","path":"/still-being-wri');

    const written = await ingestLog(db, file, "api");
    expect(written).toEqual({ read: 1, inserted: 1 }); // only the complete line
    // The offset must stop at the end of the complete line, not at EOF —
    // otherwise the partial line's remainder would be skipped once finished.
    expect(getFileOffset(db, file)).toBe(Buffer.byteLength(complete + "\n", "utf8"));

    // The writer finishes the line.
    appendFileSync(file, 'tten"}\n');
    const second = await ingestLog(db, file, "api");
    expect(second).toEqual({ read: 0, inserted: 0 }); // not a request.end message, but it must have been RE-READ, not skipped
    expect(getFileOffset(db, file)).toBe(statSync(file).size);
  });

  it("truncateSync fixture also triggers a reset (file shrunk in place, not replaced)", async () => {
    const file = join(dir, "f.log");
    writeFileSync(file, [
      line({ requestId: "a" }),
      line({ requestId: "b", time: new Date((NOW + 1) * 1000).toISOString() }),
    ].join("\n") + "\n");
    await ingestLog(db, file, "api");
    const bigOffset = getFileOffset(db, file);

    truncateSync(file, 5); // shrink well below the stored offset
    expect(bigOffset).toBeGreaterThan(5);

    // Must not throw, and must not seek past the new EOF.
    await expect(ingestLog(db, file, "api")).resolves.not.toThrow();
  });
});

describe("defaultLogSources", () => {
  it("discovers every supervised service's output log instead of naming paths that can rot", () => {
    const dir = mkdtempSync(join(tmpdir(), "reqsrc-"));
    mkdirSync(join(dir, "gateway"));
    writeFileSync(join(dir, "gateway", "gateway.out.log"), "");
    writeFileSync(join(dir, "gateway", "gateway.err.log"), "");
    const found = defaultLogSources(dir);
    // stderr is not a source. A hardcoded list once pointed at a log that had
    // stopped existing, and ingested nothing for a week while reporting success.
    expect(found.map((s) => s.service)).toEqual(["gateway.gateway"]);
  });

  it("returns an empty list rather than throwing when the log dir is absent", () => {
    expect(defaultLogSources("/nonexistent-logs")).toEqual([]);
  });
});
