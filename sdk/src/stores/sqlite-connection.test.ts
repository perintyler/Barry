import { createHash } from "node:crypto";
import { StoreRegistry, validateSnapshot } from "./registry.js";
import BetterSqlite3 from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SqliteDatabase, withSqliteInspectionCopy } from "./sqlite-connection.js";
import { sqliteProvider } from "./sqlite-provider.js";

it("keeps a bag writer's WAL linked when a writable registry connection closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-shared-sqlite-"));
  const path = join(root, "sessions.db");
  const writer = new BetterSqlite3(path);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id TEXT, session_id TEXT); INSERT INTO sessions VALUES('before');");
  try {
    // Independent connections must keep the writer's WAL linked.
    // Historical reproduction: docs/decisions/0027-regression-evidence-boundaries.md.
    const registry = await sqliteProvider([]).open(path, { readonly: false });
    registry.close();
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(existsSync(`${path}-shm`)).toBe(true);
    writer.prepare("INSERT INTO sessions VALUES(?)").run("after");
    writer.prepare("INSERT INTO messages VALUES(?,?)").run("message", "after");
    const reader = new SqliteDatabase(path, { readOnly: true });
    try {
      expect(reader.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "after" }, { id: "before" }]);
      expect(reader.prepare("SELECT id FROM messages WHERE session_id=?").get("after")).toEqual({ id: "message" });
    } finally { reader.close(); }
    // The independent process may use Node's built-in SQLite: file locking is
    // process-wide, so this does not mix SQLite libraries in the writer process.
    const fresh = spawnSync(process.execPath, ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(JSON.stringify({sessions:db.prepare('SELECT id FROM sessions ORDER BY id').all(),messages:db.prepare('SELECT id FROM messages').all()}));db.close();", path], { encoding: "utf8" });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout)).toEqual({ sessions: [{ id: "after" }, { id: "before" }], messages: [{ id: "message" }] });
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); }
});

it("keeps the built-in driver's zero default busy timeout until a caller overrides it", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    db.exec("PRAGMA busy_timeout=50");
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 50 });
  } finally { db.close(); }
});

it("keeps exact safe integer numbers and BigInt bindings in get, all and iteration", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    db.exec("CREATE TABLE values_table(n INTEGER, label TEXT, bytes BLOB, fraction REAL)");
    expect(db.prepare("INSERT INTO values_table VALUES(?,?,?,?)").run(9007199254740991n, "label", Buffer.from([0, 255]), 1.5)).toEqual({ changes: 1, lastInsertRowid: 1 });
    const statement = db.prepare("SELECT * FROM values_table");
    const row = { n: 9007199254740991, label: "label", bytes: Buffer.from([0, 255]), fraction: 1.5 };
    expect(statement.get()).toEqual(row); expect(statement.all()).toEqual([row]); expect([...statement.iterate()]).toEqual([row]);
  } finally { db.close(); }
});

it.each([9223372036854775807n, -9223372036854775808n])("refuses unsafe INTEGER output without rounding (%s)", value => {
  const db = new SqliteDatabase(":memory:");
  try {
    db.exec("CREATE TABLE values_table(n INTEGER)"); db.prepare("INSERT INTO values_table VALUES(?)").run(value);
    const statement = db.prepare("SELECT n FROM values_table");
    for (const read of [() => statement.get(), () => statement.all(), () => [...statement.iterate()]]) {
      try { read(); throw new Error("Unsafe integer was returned"); }
      catch (error) { expect(error).toMatchObject({ name: "RangeError", code: "ERR_OUT_OF_RANGE" }); expect(String(error)).toContain(String(value)); }
    }
  } finally { db.close(); }
});

it("refuses unsafe lastInsertRowid metadata with the built-in driver's range error", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    db.exec("CREATE TABLE values_table(id INTEGER PRIMARY KEY)");
    expect(() => db.prepare("INSERT INTO values_table VALUES(?)").run(9223372036854775807n)).toThrow(RangeError);
    expect(db.prepare("SELECT count(*) AS n FROM values_table").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it("inspects older WAL-header single-file snapshots without changing the archive or leaving sidecars", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-old-wal-backup-"));
  const writer = new BetterSqlite3(join(root, "live.db"));
  const archive = join(root, "archived.db");
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE rows(id TEXT); INSERT INTO rows VALUES('saved');");
    await writer.backup(archive);
    const bytes = readFileSync(archive);
    expect(bytes[18]).toBe(2); // Historical online backups retained the WAL header.
    let inspected = "";
    await withSqliteInspectionCopy(archive, async copy => {
      inspected = copy;
      const db = new SqliteDatabase(copy, { readOnly: true });
      try { expect(db.prepare("SELECT id FROM rows").get()).toEqual({ id: "saved" }); }
      finally { db.close(); }
    });
    expect(existsSync(inspected)).toBe(false);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const snapshot = { path: archive, manifest: { format: 1, node: "desktop", bag: "saved", store: "rows", schemaVersion: 0, revision: checksum, capturedAt: new Date().toISOString(), bytes: bytes.length, checksum } } as const;
    await validateSnapshot(snapshot);
    const registry = new StoreRegistry("desktop", root);
    registry.register("saved", "rows", { owned_by: "node", engine: "sqlite", migrations: "./migrations" }, sqliteProvider([]));
    await registry.validateDatabase({ node: "desktop", bag: "saved", store: "rows" }, archive);
    await registry.prepareRestore(snapshot, join(root, "restored.db"));
    expect(existsSync(join(root, "restored.db-wal"))).toBe(false);
    expect(existsSync(join(root, "restored.db-shm"))).toBe(false);
    expect(readFileSync(archive)).toEqual(bytes);
    expect(readdirSync(root).filter(name => name.startsWith("archived.db"))).toEqual(["archived.db"]);
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); }
});
