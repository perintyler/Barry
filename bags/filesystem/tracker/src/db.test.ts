import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDb, closeDb, getDb } from "./db.js";
import MIGRATIONS from "./generated/file-tracker-migrations.js";
const baseline = MIGRATIONS[0].sql;
import { record } from "./index.js";

describe("file tracker storage", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "barry-file-tracker-"));
    process.env.BARRY_FILE_TRACKER_DB = join(directory, "tracker.db");
  });

  afterEach(() => {
    closeDb();
    delete process.env.BARRY_FILE_TRACKER_DB;
    rmSync(directory, { recursive: true, force: true });
  });

  it("applies the versioned baseline with operational pragmas", () => {
    const db = getDb();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });

  it("enforces append-only file changes", () => {
    record({ sessionId: "session-1", filePath: "src/index.ts", tool: "Edit" });
    expect(() => getDb().prepare("UPDATE changes SET tool = 'Write'").run()).toThrow("append-only");
    expect(() => getDb().prepare("DELETE FROM changes").run()).toThrow("append-only");
  });

  // Several processes open the tracker at startup and each migrates it. A
  // version read outside the write lock let two of them both apply 001, and
  // the loser crashed the MCP engine. Here another process holds the lock
  // mid-migration while this one opens the file.
  it("waits for a concurrent migrator instead of re-applying its migration", async () => {
    const child = spawn(process.execPath, ["-e", `
      const Database = require(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))});
      const db = new Database(process.env.DB);
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
      db.exec("BEGIN IMMEDIATE");
      db.exec(process.env.BASELINE);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (1, '001_baseline.sql')").run();
      db.pragma("user_version = 1");
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);
    `], { env: { ...process.env, DB: process.env.BARRY_FILE_TRACKER_DB, BASELINE: baseline }, stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));

    const db = getDb();

    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual(MIGRATIONS.map((_, index) => ({ version: index + 1 })));
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(await exited).toBe(0);
  });

  it("creates an independently readable backup", async () => {
    record({ sessionId: "session-1", filePath: "README.md" });
    const destination = join(directory, "backups", "tracker.db");
    await backupDb(destination);

    const backup = new Database(destination, { readonly: true });
    expect(backup.prepare("SELECT COUNT(*) AS count FROM changes").get()).toEqual({ count: 1 });
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    backup.close();
  });
});
