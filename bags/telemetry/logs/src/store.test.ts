import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEVEL } from "@barry-rocks/sdk/logging";
import { openLogsDb, prune, type Db } from "./store.js";

const DAY = 86_400;
const NOW = 1_800_000_000;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logs-store-"));
  db = openLogsDb(join(dir, "logs.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function line(id: string, level: number, ageDays: number): void {
  db.prepare("INSERT INTO log_event (id, ts, level, service, msg) VALUES (?, ?, ?, 'test', 'm')").run(id, NOW - ageDays * DAY, level);
}

function remaining(): string[] {
  return (db.prepare("SELECT id FROM log_event ORDER BY id").all() as { id: string }[]).map((row) => row.id);
}

describe("prune", () => {
  it("keeps each level for its own horizon, and applies exactly one per row", () => {
    // Just inside and just past each horizon: error 30d, warn 14d, info 3d, debug 1d.
    line("error-29", LEVEL.error, 29);
    line("error-31", LEVEL.error, 31);
    line("warn-13", LEVEL.warn, 13);
    line("warn-15", LEVEL.warn, 15);
    line("info-2", LEVEL.info, 2);
    line("info-4", LEVEL.info, 4);
    line("debug-0", LEVEL.debug, 0.5);
    line("debug-2", LEVEL.debug, 2);

    const counts = prune(db, NOW);

    expect(remaining()).toEqual(["debug-0", "error-29", "info-2", "warn-13"]);
    expect(counts.reduce((sum, band) => sum + band.deleted, 0)).toBe(4);
  });

  it("reports a band that removed nothing as zero, not absent", () => {
    expect(prune(db, NOW).map((band) => band.deleted)).toEqual([0, 0, 0, 0]);
  });
});
