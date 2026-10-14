import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openUsageDb, recordSessionUsage, recordToolInvocations, measuringSince, pruneUsage,
  recostStoredRows, type Db,
} from "./telemetry.js";

const NOW = 1_800_000_000;

describe("usage telemetry store", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-telemetry-"));
    db = openUsageDb(join(dir, "usage.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const usage = (over: Partial<Parameters<typeof recordSessionUsage>[1]> = {}) => ({
    id: "u1", sessionId: "s1", model: "claude-opus-5",
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 10,
    totalTokens: 150, costUsd: 0.0123, numTurns: 3, durationMs: 4200,
    status: "ok", createdAt: NOW, ...over,
  });

  it("round-trips a usage row including cost and cache tokens", () => {
    recordSessionUsage(db, usage());
    const row = db.prepare("SELECT * FROM session_usage WHERE id='u1'").get() as Record<string, number | string>;
    expect(row.cost_usd).toBeCloseTo(0.0123, 6);
    // Cache tokens are the point: they are usually the MAJORITY of input and are
    // priced far lower, so a cost figure computed without them is wrong by a
    // large factor rather than a small one.
    expect(row.cache_read_tokens).toBe(900);
    expect(row.cache_write_tokens).toBe(10);
  });

  // Result IDs provide retry idempotency; different resumed-session results remain distinct rows.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-117
  it("is idempotent on re-insert of the same id", () => {
    recordSessionUsage(db, usage());
    recordSessionUsage(db, usage({ costUsd: 0.02 }));
    const rows = db.prepare("SELECT cost_usd FROM session_usage").all() as Array<{ cost_usd: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeCloseTo(0.02, 6);
  });

  it("keeps separate turns of one session as separate rows", () => {
    recordSessionUsage(db, usage({ id: "u1", costUsd: 0.01 }));
    recordSessionUsage(db, usage({ id: "u2", costUsd: 0.02 }));
    const total = db.prepare("SELECT SUM(cost_usd) t FROM session_usage WHERE session_id='s1'")
      .get() as { t: number };
    expect(total.t).toBeCloseTo(0.03, 6);
  });

  it("writes a batch of tool invocations in one call", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`, sessionId: "s1", toolUseId: `toolu_${i}`,
      name: i % 2 ? "Bash" : "Read", durationMs: 100 + i,
      isError: i === 7, createdAt: NOW + i,
    }));
    expect(recordToolInvocations(db, rows)).toBe(50);

    const byTool = db.prepare(
      "SELECT name, count(*) n FROM tool_invocation GROUP BY name ORDER BY name",
    ).all() as Array<{ name: string; n: number }>;
    expect(byTool).toEqual([{ name: "Bash", n: 25 }, { name: "Read", n: 25 }]);
  });

  // Unknown error flags remain NULL rather than becoming inferred success from result text.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-118
  it("distinguishes a successful call from one with no error information", () => {
    recordToolInvocations(db, [
      { id: "a", sessionId: "s", name: "Bash", durationMs: 1, isError: false, createdAt: NOW },
      { id: "b", sessionId: "s", name: "Bash", durationMs: 1, createdAt: NOW },
    ]);
    const rows = db.prepare("SELECT id, is_error FROM tool_invocation ORDER BY id")
      .all() as Array<{ id: string; is_error: number | null }>;
    expect(rows[0].is_error).toBe(0);
    expect(rows[1].is_error).toBeNull();
  });

  it("writing an empty batch is a no-op, not an error", () => {
    expect(recordToolInvocations(db, [])).toBe(0);
  });

  // Before any usage row exists, report not measuring yet rather than a fabricated zero-cost history.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-119
  it("reports no measurement floor until the first row lands", () => {
    expect(measuringSince(db)).toBeUndefined();
    recordSessionUsage(db, usage({ createdAt: NOW }));
    recordSessionUsage(db, usage({ id: "u2", createdAt: NOW - 500 }));
    expect(measuringSince(db)).toBe(NOW - 500);
  });

  it("prunes both tables past the horizon", () => {
    recordSessionUsage(db, usage({ id: "old", createdAt: NOW - 10_000 }));
    recordSessionUsage(db, usage({ id: "new", createdAt: NOW }));
    recordToolInvocations(db, [
      { id: "told", sessionId: "s", name: "Bash", durationMs: 1, createdAt: NOW - 10_000 },
      { id: "tnew", sessionId: "s", name: "Bash", durationMs: 1, createdAt: NOW },
    ]);

    expect(pruneUsage(db, NOW - 5_000)).toBe(2);
    expect(measuringSince(db)).toBe(NOW);
  });

  // WAL and a bounded busy timeout protect concurrent API writes from dashboard readers.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-202
  it("is configured for a second concurrent writer", () => {
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(Number(db.pragma("busy_timeout", { simple: true }))).toBe(5000);
  });

  it("a second connection can read what the first wrote", () => {
    recordSessionUsage(db, usage());
    const reader = openUsageDb(join(dir, "usage.db"));
    try {
      const row = reader.prepare("SELECT cost_usd FROM session_usage WHERE id='u1'")
        .get() as { cost_usd: number };
      expect(row.cost_usd).toBeCloseTo(0.0123, 6);
    } finally {
      reader.close();
    }
  });

  // Reprice stored tokens so cost recovery still works after the vendor prunes a transcript.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-120
  describe("recostStoredRows", () => {
    it("prices a stale row from its stored tokens", () => {
      recordSessionUsage(db, usage({
        id: "stale", model: "claude-fable-5", costUsd: undefined,
        inputTokens: 1_000_000, outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
      }));
      expect(recostStoredRows(db)).toBe(1);
      const row = db.prepare("SELECT cost_usd FROM session_usage WHERE id='stale'")
        .get() as { cost_usd: number };
      expect(row.cost_usd).toBeCloseTo(73.5, 6);
    });

    // An unpriced cost is NULL, never a free-call measurement.
    // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-121
    it("leaves a still-unpriced model NULL rather than zeroing it", () => {
      recordSessionUsage(db, usage({ id: "synth", model: "<synthetic>", costUsd: undefined }));
      expect(recostStoredRows(db)).toBe(0);
      const row = db.prepare("SELECT cost_usd FROM session_usage WHERE id='synth'")
        .get() as { cost_usd: number | null };
      expect(row.cost_usd).toBeNull();
    });

    it("does not rewrite a row that already has a cost", () => {
      recordSessionUsage(db, usage({ id: "done", model: "claude-fable-5", costUsd: 0.5 }));
      expect(recostStoredRows(db)).toBe(0);
      const row = db.prepare("SELECT cost_usd FROM session_usage WHERE id='done'")
        .get() as { cost_usd: number };
      expect(row.cost_usd).toBeCloseTo(0.5, 6);
    });
  });
});
