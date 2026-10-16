import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateStore, type Migration } from "./migrate.js";

const MIGRATIONS: Migration[] = [
  { name: "001_notes.sql", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);" },
  { name: "002_tags.sql", sql: "ALTER TABLE notes ADD COLUMN tag TEXT;" },
];

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  return db;
}

describe("migrating a store", () => {
  it("applies what the store has not seen, and nothing twice", () => {
    const path = join(mkdtempSync(join(tmpdir(), "migrate-")), "s.db");
    const db = open(path);
    expect(migrateStore(db, MIGRATIONS.slice(0, 1), "s.db")).toEqual({ from: 0, to: 1 });
    expect(migrateStore(db, MIGRATIONS, "s.db")).toEqual({ from: 1, to: 2 });
    expect(migrateStore(db, MIGRATIONS, "s.db")).toEqual({ from: 2, to: 2 });
    db.prepare("INSERT INTO notes (body, tag) VALUES (?, ?)").run("x", "y");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  });

  it("validates a current store while another connection holds the write lock", () => {
    const path = join(mkdtempSync(join(tmpdir(), "migrate-readonly-")), "s.db");
    const writer = open(path);
    migrateStore(writer, MIGRATIONS, "s.db");
    const reader = open(path);
    reader.exec("PRAGMA busy_timeout = 0");
    writer.exec("BEGIN IMMEDIATE");
    try { expect(migrateStore(reader, MIGRATIONS, "s.db")).toEqual({ from: 2, to: 2 }); }
    finally { writer.exec("ROLLBACK"); reader.close(); writer.close(); }
  });
  it("refuses a store newer than this build knows", () => {
    const db = open(join(mkdtempSync(join(tmpdir(), "migrate-")), "s.db"));
    migrateStore(db, MIGRATIONS, "s.db");
    expect(() => migrateStore(db, MIGRATIONS.slice(0, 1), "s.db")).toThrow(/s.db is at version 2, but this build only knows 1/);
  });

  it("leaves no half-applied schema when a migration fails", () => {
    const db = open(join(mkdtempSync(join(tmpdir(), "migrate-")), "s.db"));
    const broken = [...MIGRATIONS, { name: "003_bad.sql", sql: "CREATE TABLE t (a); SELECT nope FROM missing;" }];
    expect(() => migrateStore(db, broken, "s.db")).toThrow();
    // Nothing from the failed run survives, not even the migrations before the bad one.
    expect(db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get()).toEqual({ v: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('notes', 't')").get()).toEqual({ n: 0 });
  });

  it("lets many processes open a fresh store at once without a crash", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "migrate-")), "race.db");
    const runner = new URL("./migrate.ts", import.meta.url).pathname;
    // Journal initialization is fixture setup, not migration concurrency: a
    // fresh-file WAL upgrade may fail before SQLite enters its busy handler.
    const initial = open(path);
    expect(initial.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get()).toEqual({ n: 0 });
    initial.close();
    // Release all eight processes only after every handle is ready. No child
    // has applied schema yet, and startup speed cannot serialize the race.
    const script = `
      import { DatabaseSync } from "node:sqlite";
      import { migrateStore } from ${JSON.stringify(runner)};
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
      process.stdout.write("ready\\n");
      await new Promise(resolve => process.stdin.once("data", resolve));
      migrateStore(db, ${JSON.stringify(MIGRATIONS)}, "race.db");
      db.close();
    `;
    const children = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", data => { stderr += data; });
      const ready = new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", data => {
          output += data;
          if (output.includes("ready\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`Migration child exited before release (${code}): ${stderr}`)));
      });
      const exited = new Promise<{ code: number | null; stderr: string }>(resolve => {
        child.once("exit", code => resolve({ code, stderr }));
      });
      return { child, ready, exited };
    });
    let codes: Array<{ code: number | null; stderr: string }>;
    try {
      await Promise.all(children.map(child => child.ready));
      for (const { child } of children) child.stdin.end("migrate\n");
      codes = await Promise.all(children.map(child => child.exited));
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    }
    for (const { code, stderr } of codes) expect(code, stderr).toBe(0);
    const db = open(path);
    expect(db.prepare("SELECT count(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
  }, 30_000);
});

describe("migration history verification", () => {
  it("adopts legacy names and checksum-free histories without replaying SQL", () => {
    const db = open(join(mkdtempSync(join(tmpdir(), "migrate-legacy-")), "s.db"));
    db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO notes VALUES(1,'keep'); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO schema_migrations(version,name) VALUES(1,'001_notes'); PRAGMA user_version=1;");
    expect(migrateStore(db, MIGRATIONS, "legacy")).toEqual({ from: 1, to: 2 });
    expect(db.prepare("SELECT body FROM notes").get()).toEqual({ body: "keep" });
    expect(db.prepare("SELECT name,length(checksum) AS length FROM schema_migrations WHERE version=1").get()).toEqual({ name: "001_notes", length: 64 });
    db.close();
  });
  it("refuses changed, renamed and missing applied history", () => {
    const db = open(join(mkdtempSync(join(tmpdir(), "migrate-immutable-")), "s.db"));
    migrateStore(db, MIGRATIONS, "immutable");
    expect(() => migrateStore(db, [{ ...MIGRATIONS[0], sql: MIGRATIONS[0].sql + "\n" }, MIGRATIONS[1]], "immutable")).toThrow(/checksum/);
    expect(() => migrateStore(db, [{ ...MIGRATIONS[0], name: "001_renamed.sql" }, MIGRATIONS[1]], "immutable")).toThrow(/renamed/);
    db.exec("DELETE FROM schema_migrations WHERE version=1");
    expect(() => migrateStore(db, MIGRATIONS, "immutable")).toThrow(/missing versions/);
    db.close();
  });
  it("checks history before stamping legacy checksums or applying pending SQL", () => {
    const db = open(join(mkdtempSync(join(tmpdir(), "migrate-adopt-")), "s.db"));
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE); INSERT INTO schema_migrations VALUES(1,'001_wrong');");
    expect(() => migrateStore(db, MIGRATIONS, "legacy")).toThrow(/renamed/);
    expect(db.prepare("PRAGMA table_info(schema_migrations)").all().map((row) => row.name)).not.toContain("checksum");
    db.close();
  });
  it("rejects transaction control before SQL runs but allows triggers and CASE", () => {
    const db = open(join(mkdtempSync(join(tmpdir(), "migrate-tx-")), "s.db"));
    expect(() => migrateStore(db, [{ name: "001_bad.sql", sql: "CREATE TABLE must_not_exist(id); COMMIT;" }], "bad")).toThrow(/owns transactions/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='must_not_exist'").get()).toBeUndefined();
    migrateStore(db, [{ name: "001_trigger.sql", sql: "CREATE TABLE t(id INTEGER); CREATE TRIGGER increment AFTER INSERT ON t BEGIN UPDATE t SET id=CASE WHEN id=1 THEN 2 ELSE id END; END; INSERT INTO t VALUES(1);" }], "trigger");
    expect(db.prepare("SELECT id FROM t").get()).toEqual({ id: 2 });
    db.close();
  });
});
