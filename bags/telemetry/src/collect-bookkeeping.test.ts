import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBookkeeping, summaryPoints, collectBookkeeping } from "./collect-bookkeeping.js";
import { METRICS } from "./schema.js";

const NOW = 1_800_000_000;

/** Copied verbatim from ~/.barry/jobs.db — a run that wrote and hit the cap. */
const WROTE =
  "[bookkeeping] done considered=19 written=8 named=2 drifted=0 failed=0 " +
  "model(n=8 p50=19.9s max=29.6s) skipped(no_new_messages=5 below_message_floor=6 tick_write_cap=131)";

// Quiet bookkeeping output omits the model group because no model call occurred.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-002
const QUIET =
  "[bookkeeping] done considered=150 written=0 named=0 drifted=0 failed=0 " +
  "skipped(below_message_floor=120 no_new_messages=24 insufficient_history=6)";

const valueOf = (points: { metric: string; value: number }[], metric: string) =>
  points.find((p) => p.metric === metric)?.value;

describe("parseBookkeeping", () => {
  it("reads a run that wrote entries", () => {
    expect(parseBookkeeping(WROTE)).toEqual({ written: 8, failed: 0, deferred: 131, p50Sec: 19.9 });
  });

  // A quiet run has absent latency rather than a zero measurement or parse failure.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-003
  it("reads a quiet run as valid with no latency", () => {
    expect(parseBookkeeping(QUIET)).toEqual({ written: 0, failed: 0, deferred: 0, p50Sec: null });
  });

  /** `skipped(...)` keys are emitted in different orders run to run. */
  it("does not depend on field order", () => {
    const reordered =
      "[bookkeeping] done considered=150 failed=2 written=4 drifted=1 named=1 " +
      "skipped(insufficient_history=5 tick_write_cap=7 no_new_messages=28) model(n=4 p50=18.2s max=22.9s)";
    expect(parseBookkeeping(reordered)).toEqual({ written: 4, failed: 2, deferred: 7, p50Sec: 18.2 });
  });

  it("picks the summary out of a multi-line tail", () => {
    const tail = `[bookkeeping] abc123 +13msg tags=10 (qwen3:4b)\n${WROTE}\n`;
    expect(parseBookkeeping(tail)?.written).toBe(8);
  });

  // Unrecognized summary formats return null so collector health exposes upstream drift.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-004
  it("rejects lines that are not a bookkeeping summary", () => {
    expect(parseBookkeeping(null)).toBeNull();
    expect(parseBookkeeping("")).toBeNull();
    expect(parseBookkeeping("[bookkeeping] starting up")).toBeNull();
    // Renamed the field — the exact drift this guards against.
    expect(parseBookkeeping("[bookkeeping] done considered=19 entries=8 failed=0")).toBeNull();
  });
});

describe("summaryPoints", () => {
  it("emits parse_ok=0 and nothing else when the format broke", () => {
    const points = summaryPoints(NOW, null);
    expect(points).toHaveLength(1);
    expect(valueOf(points, METRICS.bookkeepingParseOk.name)).toBe(0);
  });

  it("emits parse_ok=1 alongside the counters", () => {
    const points = summaryPoints(NOW, parseBookkeeping(WROTE));
    expect(valueOf(points, METRICS.bookkeepingParseOk.name)).toBe(1);
    expect(valueOf(points, METRICS.bookkeepingWritten.name)).toBe(8);
    expect(valueOf(points, METRICS.bookkeepingDeferred.name)).toBe(131);
    expect(valueOf(points, METRICS.ollamaInferenceP50Sec.name)).toBe(19.9);
  });

  // Do not invent zero latency for a quiet run that made no model call.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-005
  it("omits latency rather than zeroing it on a quiet run", () => {
    const points = summaryPoints(NOW, parseBookkeeping(QUIET));
    expect(valueOf(points, METRICS.bookkeepingWritten.name)).toBe(0);
    expect(valueOf(points, METRICS.ollamaInferenceP50Sec.name)).toBeUndefined();
  });
});

describe("collectBookkeeping", () => {
  // A missing action store means unavailable history rather than a changed summary format.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-006
  it("stays silent when there is no run store", () => {
    expect(collectBookkeeping(NOW, "/nonexistent/actions.db")).toEqual([]);
  });

  it("reads the last line of the newest finished sessions/bookkeeping run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bookkeeping-runs-"));
    const path = join(dir, "actions.db");
    const db = new Database(path);
    db.exec("CREATE TABLE action_runs (schedule_id TEXT, status TEXT, output TEXT, started_at TEXT)");
    const record = (output: string, status: "complete" | "started", startedAt: string) =>
      db.prepare("INSERT INTO action_runs VALUES (?, ?, ?, ?)").run("sessions/bookkeeping", status, output, startedAt);
    record(`[bookkeeping] loading\n${QUIET}`, "complete", "2026-10-01T00:00:00Z");
    record(`[bookkeeping] loading\n${WROTE}`, "complete", "2026-10-01T00:00:01Z");
    record("", "started", "2026-10-01T00:00:02Z");
    db.close();

    const points = collectBookkeeping(NOW, path);
    expect(valueOf(points, METRICS.bookkeepingWritten.name)).toBe(8);
    expect(valueOf(points, METRICS.bookkeepingParseOk.name)).toBe(1);
    const previous = process.env.BARRY_ACTIONS_DB;
    process.env.BARRY_ACTIONS_DB = path;
    try {
      expect(collectBookkeeping(NOW)).toEqual(points);
    } finally {
      if (previous === undefined) delete process.env.BARRY_ACTIONS_DB;
      else process.env.BARRY_ACTIONS_DB = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
