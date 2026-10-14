import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, writePoints, type Db } from "./store.js";
import { serviceSummaries, series, firingAlerts } from "./summary.js";
import { METRICS } from "./schema.js";

/**
 * Read models shared by the dashboard and the MCP tools.
 *
 * These had no tests, which is how `restartsLastHour: -2` reached a reader: a
 * negative restart count reads as healthy, so nothing about it looked wrong.
 */
const NOW = 1_800_000_000;

describe("serviceSummaries", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metrics-summary-"));
    db = openDb(join(dir, "t.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runs = (ts: number, service: string, value: number) => ({
    ts,
    metric: METRICS.serviceRuns.name,
    value,
    labels: { kind: "service", service },
  });

  // Retain service-versus-job kind so an idle periodic job is not reported as a dead service.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-145
  it("distinguishes a periodic job from a resident service", () => {
    writePoints(db, [
      { ts: NOW - 60, metric: METRICS.serviceUp.name, value: 1, labels: { kind: "service", service: "api" } },
      // Idle between runs — the normal state of a scheduled job.
      { ts: NOW - 60, metric: METRICS.serviceUp.name, value: 0, labels: { kind: "job", service: "job.backup" } },
    ]);

    const byName = new Map(serviceSummaries(db, NOW).map((s) => [s.name, s]));
    expect(byName.get("api")?.kind).toBe("service");
    expect(byName.get("api")?.up).toBe(true);
    expect(byName.get("job.backup")?.kind).toBe("job");
    // Still false — the fix is that the UI stops reading this as a fault for a
    // job, not that the liveness fact is rewritten.
    expect(byName.get("job.backup")?.up).toBe(false);
  });

  it("reports the run delta over the window", () => {
    writePoints(db, [runs(NOW - 3000, "api", 10), runs(NOW - 100, "api", 13)]);

    const [api] = serviceSummaries(db, NOW);
    expect(api.runsLastHour).toBe(3);
    expect(api.runsCounterReset).toBeUndefined();
  });

  // Detect supervisor counter resets instead of reporting negative restarts.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-146
  it("reports a counter reset instead of a negative delta", () => {
    writePoints(db, [
      runs(NOW - 3000, "mcp.barry", 42),
      // Reloaded here; the counter starts over.
      runs(NOW - 100, "mcp.barry", 2),
    ]);

    const [mcp] = serviceSummaries(db, NOW);
    expect(mcp.runsCounterReset).toBe(true);
    // Not 0, and not -40: both would be claims about a window we cannot measure.
    expect(mcp.runsLastHour).toBeUndefined();
  });

  it("leaves the delta undefined when the window has no samples", () => {
    // Only an old point, outside the 1h window used for the delta.
    writePoints(db, [runs(NOW - 99_999, "api", 5)]);

    const [api] = serviceSummaries(db, NOW);
    expect(api.runsLastHour).toBeUndefined();
  });

  // Scheduled starts are healthy job executions; they are not resident-service restarts.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-147
  it("counts interval-job firings without treating them as failures", () => {
    writePoints(db, [
      { ts: NOW - 3540, metric: METRICS.serviceRuns.name, value: 6_022, labels: { kind: "job", service: "bag.job.metrics.sample" } },
      { ts: NOW - 60, metric: METRICS.serviceRuns.name, value: 6_078, labels: { kind: "job", service: "bag.job.metrics.sample" } },
    ]);

    const [job] = serviceSummaries(db, NOW);
    expect(job.runsLastHour).toBe(56);
    expect(job.runsCounterReset).toBeUndefined();
  });
});

describe("series", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metrics-series-"));
    db = openDb(join(dir, "t.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Long windows must read both raw and hourly tiers rather than silently returning recent days only.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-148
  it("spans both storage tiers, not just the raw window", () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - 20 * 86_400;

    // Older than raw retention, so in the real store this hour is a rollup and
    // its raw rows are already deleted.
    db.prepare(
      "INSERT INTO rollup_hourly (bucket, metric, labels, min, max, avg, last, count) VALUES (?,?,?,?,?,?,?,?)",
    ).run(Math.floor(old / 3600) * 3600, "m", "{}", 1, 3, 2, 3, 60);

    writePoints(db, [{ ts: now - 3600, metric: "m", value: 9 }]);

    const points = series(db, "m", 30 * 86_400);

    // Two tiers, two points. Raw-only would return one and hide 20 days.
    expect(points).toHaveLength(2);
    expect(points[0].value).toBe(2);
    expect(points[1].value).toBe(9);
    // Oldest first, so a chart reads left to right without re-sorting.
    expect(points[0].ts).toBeLessThan(points[1].ts);
  });

  /**
   * rollup() folds a bucket and deletes its raw rows in ONE transaction, so a
   * timestamp is never both. If that ever changed, concatenating the tiers would
   * double-count the overlap and inflate every long-window chart.
   */
  it("does not double-count when both tiers are present", () => {
    const now = Math.floor(Date.now() / 1000);
    writePoints(db, [
      { ts: now - 7200, metric: "m", value: 4 },
      { ts: now - 3600, metric: "m", value: 6 },
    ]);

    const points = series(db, "m", 30 * 86_400);

    expect(points).toHaveLength(2);
    expect(points.map((p) => p.value)).toEqual([4, 6]);
  });

  it("returns nothing for a metric with no history in either tier", () => {
    expect(series(db, "absent", 30 * 86_400)).toEqual([]);
  });
});

describe("firingAlerts", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metrics-firing-"));
    db = openDb(join(dir, "t.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes since ISO timestamp and human duration from alert_state", () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_state (
        rule TEXT PRIMARY KEY,
        firing INTEGER NOT NULL,
        since INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        detail TEXT NOT NULL,
        last_notified INTEGER
      )
    `);
    const sinceTs = NOW - 300;
    db.prepare("INSERT INTO alert_state (rule, firing, since, last_seen, detail) VALUES (?, 1, ?, ?, ?)").run(
      "memory-pressure|{}",
      sinceTs,
      NOW,
      "test",
    );

    writePoints(db, [{ ts: NOW, metric: METRICS.hostMemCompressorPct.name, value: 50 }]);

    const alerts = firingAlerts(db, NOW);
    const mp = alerts.find((a) => a.id === "memory-pressure");
    expect(mp).toBeDefined();
    expect(mp?.since).toBe(new Date(sinceTs * 1000).toISOString());
    expect(mp?.duration).toBe("5m");
  });

  it("defaults since to now and duration to 0s when no prior alert_state exists", () => {
    const points = [0, 1, 2, 3, 4].map((i) => ({
      ts: NOW - (4 - i) * 60,
      metric: METRICS.hostMemCompressorPct.name,
      value: 50,
    }));
    writePoints(db, points);

    const alerts = firingAlerts(db, NOW);
    const mp = alerts.find((a) => a.id === "memory-pressure");
    expect(mp).toBeDefined();
    expect(mp?.since).toBe(new Date(NOW * 1000).toISOString());
    expect(mp?.duration).toBe("0s");
  });
});
