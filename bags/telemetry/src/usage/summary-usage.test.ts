import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runPanel, windowStart, type Panel, type Row } from "./summary-usage.js";
import type { StoreHandle } from "./stores.js";
import * as Q from "./queries.js";

// A missing store returns unavailable; it must not look like a successful empty report.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-191

const QUERY = { text: "SELECT 1", params: [] };

/** Minimal stand-in for better-sqlite3: only prepare().all() is exercised. */
function fakeStore(behaviour: () => unknown): StoreHandle {
  return {
    name: "test",
    path: "/unused",
    db: {
      prepare: () => ({ all: () => behaviour() }),
    } as never,
  };
}

/** A store whose file could not be opened — the "missing store" branch. */
function missingStore(problem: string): StoreHandle {
  return { name: "test", path: "/unused", db: null, problem };
}

describe("runPanel", () => {
  it("returns ok with rows and a timing when the query succeeds", async () => {
    const panel = await runPanel(fakeStore(() => [{ a: "1" }]), QUERY, "nothing");
    expect(panel.state).toBe("ok");
    if (panel.state !== "ok") throw new Error("unreachable");
    expect(panel.data).toEqual([{ a: "1" }]);
    expect(panel.ms).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes a genuinely empty result from a broken source", async () => {
    const empty = await runPanel(fakeStore(() => []), QUERY, "No sessions in the last 7 days.");
    const broken = await runPanel(
      fakeStore(() => { throw Object.assign(new Error("nope"), { code: "SQLITE_BUSY" }); }),
      QUERY,
      "No sessions in the last 7 days.",
    );

    // THE test. If these two ever collapse to the same state, the dashboard is
    // free to render an unreadable store as "no activity".
    expect(empty.state).toBe("empty");
    expect(broken.state).toBe("unavailable");
    expect(empty.state).not.toBe(broken.state);
  });

  it("explains an empty result instead of leaving a blank panel", async () => {
    const panel = await runPanel(fakeStore(() => []), QUERY, "No sessions in the last 7 days.");
    if (panel.state !== "empty") throw new Error("expected empty");
    expect(panel.explanation).toBe("No sessions in the last 7 days.");
  });

  it("carries no data when unavailable, so nothing can be charted", async () => {
    const panel = await runPanel(
      fakeStore(() => { throw new Error("boom"); }),
      QUERY,
      "nothing",
    );
    // Narrowing is the point: there is no `.data` to reach for on this branch,
    // so a caller cannot accidentally plot an error as a series.
    expect(panel.state).toBe("unavailable");
    expect("data" in panel).toBe(false);
  });

  it("reports a busy store distinctly from a query failure", async () => {
    const panel = await runPanel(
      fakeStore(() => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }),
      QUERY,
      "nothing",
    );
    if (panel.state !== "unavailable") throw new Error("expected unavailable");
    // A writer holding the lock is transient; corruption is not. Different
    // remedies, so different words.
    expect(panel.reason).toContain("busy");
  });

  it("names schema drift when a table is missing", async () => {
    const panel = await runPanel(
      fakeStore(() => { throw new Error("no such table: sessions"); }),
      QUERY,
      "nothing",
    );
    if (panel.state !== "unavailable") throw new Error("expected unavailable");
    expect(panel.reason).toContain("schema drift");
  });

  it("says which store is missing rather than a generic failure", async () => {
    const panel = await runPanel(missingStore("actions store not found at /x"), QUERY, "nothing");
    if (panel.state !== "unavailable") throw new Error("expected unavailable");
    // Misconfiguration and unreachability need different fixes, and "which
    // file" is the difference.
    expect(panel.reason).toContain("actions store not found");
  });

  it("keeps a multi-line driver error to its first line", async () => {
    const panel = await runPanel(
      fakeStore(() => { throw new Error("headline\n  detail\n  hint"); }),
      QUERY,
      "nothing",
    );
    if (panel.state !== "unavailable") throw new Error("expected unavailable");
    // The reason renders inside a card; a stack trace would push the numbers
    // off the page.
    expect(panel.reason).toBe("headline");
  });
});

describe("windowStart", () => {
  it("returns an ISO timestamp the given number of days back", () => {
    const days = 7;
    const delta = Date.now() - Date.parse(windowStart(days));
    expect(delta).toBeGreaterThan(days * 86_400_000 - 5_000);
    expect(delta).toBeLessThan(days * 86_400_000 + 5_000);
  });
});

describe("partitioned store queries", () => {
  it("merges actionOutcomes across multiple partitions and computes avg_s", async () => {
    const p1 = new Database(":memory:");
    p1.exec(`
      CREATE TABLE action_runs (bag TEXT, action TEXT, status TEXT, started_at TEXT, completed_at TEXT);
      INSERT INTO action_runs VALUES ('test', 'build', 'completed', '2026-08-01T00:00:00Z', '2026-08-01T00:00:10Z');
    `);
    const p2 = new Database(":memory:");
    p2.exec(`
      CREATE TABLE action_runs (bag TEXT, action TEXT, status TEXT, started_at TEXT, completed_at TEXT);
      INSERT INTO action_runs VALUES ('test', 'build', 'completed', '2026-08-01T00:00:00Z', '2026-08-01T00:00:20Z');
    `);

    const handle: StoreHandle = {
      name: "actions",
      path: "/unused",
      db: p1,
      partitions: [
        { path: "/p1", db: p1 },
        { path: "/p2", db: p2 },
      ],
    };

    const panel = await runPanel(handle, Q.actionOutcomes("2026-08-01T00:00:00Z"), "empty");
    expect(panel.state).toBe("ok");
    if (panel.state !== "ok") throw new Error("expected ok");
    expect(panel.data).toEqual([
      { bag: "test", action: "build", status: "completed", runs: "2", avg_s: "15", last_run: "2026-08-01T00:00:00Z" },
    ]);
  });

  it("filters stuckRuns after merging partitions", async () => {
    const p1 = new Database(":memory:");
    p1.exec(`
      CREATE TABLE action_runs (bag TEXT, action TEXT, status TEXT, started_at TEXT, completed_at TEXT);
      INSERT INTO action_runs VALUES ('test', 'sync', 'running', datetime('now', '-3 hours'), NULL);
    `);
    const p2 = new Database(":memory:");
    p2.exec(`
      CREATE TABLE action_runs (bag TEXT, action TEXT, status TEXT, started_at TEXT, completed_at TEXT);
      INSERT INTO action_runs VALUES ('test', 'sync', 'running', datetime('now', '-30 minutes'), NULL);
    `);

    const handle: StoreHandle = {
      name: "actions",
      path: "/unused",
      db: p1,
      partitions: [
        { path: "/p1", db: p1 },
        { path: "/p2", db: p2 },
      ],
    };

    const panel = await runPanel(handle, Q.stuckRuns(1), "empty");
    expect(panel.state).toBe("ok");
    if (panel.state !== "ok") throw new Error("expected ok");
    expect(panel.data).toHaveLength(1);
    const rows = panel.data as Record<string, unknown>[];
    expect(rows[0].open).toBe("2");
    expect(Number(rows[0].oldest_hours)).toBeGreaterThanOrEqual(2.9);
  });

  it("averages actionOutcomes over the runs that recorded a duration, as avg() did", async () => {
    const runs = (rows: string) => {
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE action_runs (bag TEXT, action TEXT, status TEXT, started_at TEXT, completed_at TEXT); ${rows}`);
      return db;
    };
    const p1 = runs(`
      INSERT INTO action_runs VALUES ('test', 'build', 'complete', '2026-08-01T00:00:00Z', '2026-08-01T00:00:10Z');
      INSERT INTO action_runs VALUES ('test', 'build', 'complete', '2026-08-01T01:00:00Z', NULL);
      INSERT INTO action_runs VALUES ('test', 'sync', 'running', '2026-08-01T02:00:00Z', NULL);
    `);
    const p2 = runs(`INSERT INTO action_runs VALUES ('test', 'build', 'complete', '2026-08-01T03:00:00Z', '2026-08-01T03:00:20Z');`);
    const handle: StoreHandle = { name: "actions", path: "/p1", db: p1, partitions: [{ path: "/p1", db: p1 }, { path: "/p2", db: p2 }] };

    const panel = await runPanel(handle, Q.actionOutcomes("2026-08-01T00:00:00Z"), "empty");
    if (panel.state !== "ok") throw new Error(`expected ok, got ${panel.state}`);
    const rows = panel.data as Record<string, unknown>[];
    expect(rows.find((r) => r.action === "build")).toMatchObject({ runs: "3", avg_s: "15" });
    expect(rows.find((r) => r.action === "sync")).toMatchObject({ runs: "1", avg_s: null });
  });

  /** One identity's sessions store, its rows named with `prefix` so partitions stay disjoint. */
  function sessionsPartition(prefix: string): Database.Database {
    const db = new Database(":memory:");
    db.function("repo_of", (path: unknown) => String(path));
    db.function("bag_of", (name: unknown) => String(name).split("__")[1] ?? null);
    db.exec(`
      CREATE TABLE sessions (id TEXT, identity_id INTEGER, status TEXT, created_at TEXT, metadata TEXT);
      CREATE TABLE messages (id TEXT, session_id TEXT, sequence INTEGER, type TEXT, role TEXT, name TEXT, model_id INTEGER, created_at TEXT);
      CREATE TABLE models (id INTEGER, model_id TEXT, label TEXT);
      INSERT INTO models VALUES (1, 'opus', 'Opus');
    `);
    const session = db.prepare("INSERT INTO sessions VALUES (?, 3, ?, ?, ?)");
    const message = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, 1, ?)");
    for (const [n, status] of [[1, "completed"], [2, "failed"]] as const) {
      const id = `${prefix}-s${n}`;
      session.run(id, status, `2026-09-0${n}T00:00:00Z`, JSON.stringify({ source: "cli", working_directory: "/repos/barry" }));
      for (let i = 0; i < 4; i++) {
        const name = i % 2 ? "mcp__notes__save" : "Bash";
        message.run(`${id}-m${i}`, id, i, "tool_call", "assistant", name, `2026-09-0${n}T00:00:0${i}Z`);
      }
    }
    return db;
  }

  it.each([
    ["activity", Q.activity("2026-09-01T00:00:00Z", "day")],
    ["sessionsBySource", Q.sessionsBySource("2026-09-01T00:00:00Z")],
    ["sessionCountsByIdentity", Q.sessionCountsByIdentity("2026-09-01T00:00:00Z")],
    ["workByRepo", Q.workByRepo("2026-09-01T00:00:00Z")],
    ["sessionOutcomes", Q.sessionOutcomes("2026-09-01T00:00:00Z")],
    ["modelMix", Q.modelMix("2026-09-01T00:00:00Z")],
    ["toolLeaderboard", Q.toolLeaderboard("2026-09-01T00:00:00Z")],
    ["bagUsage", Q.bagUsage("2026-09-01T00:00:00Z")],
    ["turnGaps", Q.turnGaps("2026-09-01T00:00:00Z", 1)],
  ])("%s merges partitions into one row per group", async (_name, query) => {
    const one = sessionsPartition("a");
    const single: StoreHandle = { name: "sessions", path: "/a", db: one, partitions: [{ path: "/a", db: one }] };
    const two = sessionsPartition("b");
    const merged: StoreHandle = { name: "sessions", path: "/a", db: one, partitions: [{ path: "/a", db: one }, { path: "/b", db: two }] };

    const alone = await runPanel(single, query, "empty");
    const both = await runPanel(merged, query, "empty");
    if (alone.state !== "ok" || both.state !== "ok") throw new Error(`expected ok, got ${alone.state} and ${both.state}`);
    const key = (row: Record<string, unknown>) => String(Object.values(row)[0]);
    const keys = (rows: unknown[]) => (rows as Record<string, unknown>[]).map(key).sort();
    expect(keys(both.data)).toEqual(keys(alone.data));
  });

  it("sums session outcomes and identity counts across partitions", async () => {
    const one = sessionsPartition("a"), two = sessionsPartition("b");
    const handle: StoreHandle = { name: "sessions", path: "/a", db: one, partitions: [{ path: "/a", db: one }, { path: "/b", db: two }] };

    const outcomes = await runPanel<Row>(handle, Q.sessionOutcomes("2026-09-01T00:00:00Z"), "empty");
    if (outcomes.state !== "ok") throw new Error(`expected ok, got ${outcomes.state}`);
    expect(outcomes.data.map((r) => [r.status, Number(r.sessions)]).sort()).toEqual([["completed", 2], ["failed", 2]]);

    const identities = await runPanel<{ identity_id: number; sessions: number }>(handle, Q.sessionCountsByIdentity("2026-09-01T00:00:00Z"), "empty");
    if (identities.state !== "ok") throw new Error(`expected ok, got ${identities.state}`);
    expect(identities.data).toEqual([{ identity_id: 3, sessions: 4 }]);
  });
});
