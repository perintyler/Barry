import { createHash } from "node:crypto";
import generatedMigrations from "./generated/migrations.js";
import { SqliteDatabase as DatabaseSync, type SqliteConnection } from "../stores/sqlite-connection.js";

export const migrations = generatedMigrations;
export function migrate(db: SqliteConnection, owner: string): void {
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  // Preflight before journal-mode or schema changes, including another owner's store.
  if (table("workflow_meta")) {
    const identity = db.prepare("SELECT value FROM workflow_meta WHERE key='owner'").get()?.value;
    const format = db.prepare("SELECT value FROM workflow_meta WHERE key='format'").get()?.value;
    if (identity && identity !== owner) throw new Error("workflow store belongs to another owner");
    if (format !== "1" && format !== "2") throw new Error("unsupported workflow store format");
  }
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version > migrations.length) throw new Error("unsupported workflow store schema");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (table("workflow_runs") && !table("schema_migrations")) {
      const baseline = new DatabaseSync(":memory:");
      try {
        baseline.exec(migrations[0].sql);
        const expected = baseline.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'workflow_%' ORDER BY name").all();
        const actual = db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'workflow_%' ORDER BY name").all();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("legacy workflow schema failed baseline verification");
      } finally { baseline.close(); }
    }
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT(datetime('now')),checksum TEXT)");
    const columns = db.prepare("PRAGMA table_info(schema_migrations)").all();
    if (!columns.some(column => column.name === "checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    const applied = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
    if (applied.length > migrations.length) throw new Error("unsupported workflow migration history");
    for (let index = 0; index < migrations.length; index++) {
      const migration = migrations[index], entry = applied[index];
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      if (entry) {
        if (entry.version !== index + 1 || String(entry.name).replace(/\.sql$/, "") !== migration.name.replace(/\.sql$/, "") || (entry.checksum && entry.checksum !== checksum)) throw new Error("workflow migration checksum/history mismatch");
        db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?").run(checksum, index + 1);
      } else {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version,name,checksum) VALUES(?,?,?)").run(index + 1, migration.name, checksum);
      }
    }
    db.prepare("INSERT OR IGNORE INTO workflow_meta VALUES('owner',?)").run(owner);
    db.exec(`PRAGMA user_version=${migrations.length}`);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* Original fault is authoritative. */ } throw error; }
}
