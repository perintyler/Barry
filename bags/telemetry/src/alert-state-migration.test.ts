import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateStore } from "@barry-rocks/sdk/stores";
import generatedMigrations from "./generated/metrics-migrations.js";
import { openDb, writePoints } from "./store.js";
import { evaluateRule, selectNotifications } from "./rules.js";

// The migration accepts both legacy shapes, including stores where the old per-tick ALTER already ran.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-001
const baseline = generatedMigrations.slice(0, 1);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alert-state-"));
  path = join(dir, "metrics.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function columns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(alert_state)").all() as { name: string }[]).map((column) => column.name);
}

/** A store as the previous build left it: at 001, optionally with the ALTER applied. */
function previousStore(withColumn: boolean): void {
  const db = new Database(path);
  migrateStore(db, baseline, path);
  if (withColumn) db.exec("ALTER TABLE alert_state ADD COLUMN last_notified INTEGER");
  db.prepare("INSERT INTO alert_state (rule, firing, since, last_seen, detail) VALUES (?, ?, ?, ?, ?)").run("disk|{}", 1, 100, 500, "disk full");
  db.prepare("INSERT INTO alert_state (rule, firing, since, last_seen, detail) VALUES (?, ?, ?, ?, ?)").run("swap|{}", 0, 100, 200, "swap");
  db.close();
}

describe("alert_state migration", () => {
  it("gives a fresh store the column", () => {
    const db = openDb(path);
    expect(columns(db)).toContain("last_notified");
    db.close();
  });

  it.each([true, false])("upgrades a 001 store (column already added: %s), keeping its alerts", (withColumn) => {
    previousStore(withColumn);
    const db = openDb(path);
    expect(columns(db)).toContain("last_notified");
    const rows = db.prepare("SELECT rule, firing, since, last_seen, detail, last_notified FROM alert_state ORDER BY rule").all();
    expect(rows).toEqual([
      { rule: "disk|{}", firing: 1, since: 100, last_seen: 500, detail: "disk full", last_notified: 500 },
      { rule: "swap|{}", firing: 0, since: 100, last_seen: 200, detail: "swap", last_notified: null },
    ]);
    db.close();
  });

  it("evaluating rules changes no schema", () => {
    const db = openDb(path);
    const prepare = vi.spyOn(db, "prepare");
    writePoints(db, [{ ts: 1000, metric: "m", value: 99 }]);
    const evaluations = evaluateRule(db, { id: "r", kind: "threshold", metric: "m", message: "m is {value}", severity: "warn", limit: 50, rationale: "a fixture" }, 1000);
    expect(evaluations).toHaveLength(1);
    selectNotifications(db, evaluations, 1000);
    selectNotifications(db, [], 1060);
    const ddl = prepare.mock.calls.map(([sql]) => sql).filter((sql) => /\b(ALTER|CREATE|DROP)\b/i.test(sql));
    expect(ddl).toEqual([]);
    db.close();
  });
});
