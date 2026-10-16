import { createHash } from "node:crypto";
/**
 * Read the migration version and apply pending migrations inside one BEGIN IMMEDIATE transaction so concurrent openers serialize on the write lock.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 * Runtime connections to a shared store must use one SQLite library within each process.
 */

/** One forward schema change loaded from SQL or a generated migration catalog. */
export interface Migration {
  name: string;
  sql: string;
}

/** The part of a SQLite handle this needs. better-sqlite3 and node:sqlite both fit. */
export interface MigratableDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: never[]): unknown;
    all(...params: never[]): unknown;
    run(...params: never[]): unknown;
  };
}

export interface MigrationResult {
  /** The version the store was at when opened. */
  from: number;
  /** The version it is at now. */
  to: number;
}

/**
 * Apply every migration the store has not seen, in order, all in one
 * transaction with the version read.
 *
 * Refuses a store stamped newer than `migrations` knows about: an older build
 * would otherwise read the tables it recognises and silently ignore columns
 * added since.
 *
 * @param store  A name for error messages, e.g. "sessions.db".
 */
export function migrateStore(
  db: MigratableDatabase,
  migrations: readonly Migration[],
  store: string,
): MigrationResult {
  for (const migration of migrations) assertTransactionSafe(migration);
  // A fully stamped store needs no writer lock. Keep the validation and the
  // version read in one read transaction so another process cannot migrate
  // between them; WAL readers continue while an unrelated writer is busy.
  const history = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (history) {
    db.exec("BEGIN");
    try {
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[];
      if (version === migrations.length && columns.some(column => column.name === "checksum")) {
        const applied = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as { version: number; name: string; checksum: string | null }[];
        if (applied.length === migrations.length && applied.every(entry => entry.checksum)) {
          applied.forEach((entry, index) => {
            if (entry.version !== index + 1) throw new Error(`${store}: migration history has missing versions`);
            const expected = migrations[index];
            if (entry.name.replace(/\.sql$/, "") !== expected.name.replace(/\.sql$/, "")) throw new Error(`${store}: applied migration ${entry.version} was renamed`);
            if (entry.checksum !== createHash("sha256").update(expected.sql, "utf8").digest("hex")) throw new Error(`${store}: applied migration ${entry.name} checksum mismatch`);
          });
          db.exec("COMMIT");
          return { from: version, to: version };
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the validation error. */ }
      throw error;
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      checksum TEXT
    );`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "checksum"))
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    const applied = db
      .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string; checksum: string | null }[];
    const from = applied.at(-1)?.version ?? 0;
    if (from > migrations.length) {
      throw new Error(
        `${store} is at version ${from}, but this build only knows ${migrations.length}. Upgrade Barry rather than letting an older build read a newer store.`,
      );
    }
    const checksum = (sql: string) => createHash("sha256").update(sql, "utf8").digest("hex");
    const stamp = db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?") as {
      run(checksum: string, version: number): unknown;
    };
    applied.forEach((entry, index) => {
      if (entry.version !== index + 1)
        throw new Error(`${store}: migration history has missing versions`);
      const expected = migrations[index];
      if (entry.name.replace(/\.sql$/, "") !== expected.name.replace(/\.sql$/, ""))
        throw new Error(`${store}: applied migration ${entry.version} was renamed`);
      const digest = checksum(expected.sql);
      if (entry.checksum && entry.checksum !== digest)
        throw new Error(`${store}: applied migration ${entry.name} checksum mismatch`);
      if (!entry.checksum) stamp.run(digest, entry.version);
    });
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
    ) as {
      run(version: number, name: string, checksum: string): unknown;
    };
    for (let index = from; index < migrations.length; index += 1) {
      const { name, sql } = migrations[index];
      db.exec(sql);
      insert.run(index + 1, name, checksum(sql));
    }
    db.exec(`PRAGMA user_version = ${migrations.length}`);
    db.exec("COMMIT");
    return { from, to: migrations.length };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction is already gone; the migration's own error is the one to report.
    }
    throw err;
  }
}

/** Reject transaction control before SQL runs; preserve BEGIN/END inside CREATE TRIGGER. */
function assertTransactionSafe(migration: Migration): void {
  const tokens =
    migration.sql.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_]+|;/gi,
    ) ?? [];
  let statement: string[] = [];
  let trigger = false;
  let body = false;
  let depth = 0;
  for (const raw of tokens) {
    if (/^(?:--|\/\*|['"`[])/.test(raw)) continue;
    const token = raw.toUpperCase();
    if (token === ";") {
      if (!trigger || (body && depth === 0)) {
        statement = [];
        trigger = false;
        body = false;
      }
      continue;
    }
    if (
      !statement.length &&
      [
        "BEGIN",
        "COMMIT",
        "END",
        "ROLLBACK",
        "SAVEPOINT",
        "RELEASE",
        "VACUUM",
        "ATTACH",
        "DETACH",
      ].includes(token)
    ) {
      throw new Error(
        `${migration.name}: Barry owns transactions; ${token} is unsupported in a migration`,
      );
    }
    statement.push(token);
    if (
      statement[0] === "CREATE" &&
      (statement[1] === "TRIGGER" ||
        (["TEMP", "TEMPORARY"].includes(statement[1]) && statement[2] === "TRIGGER"))
    )
      trigger = true;
    if (trigger && token === "BEGIN") {
      body = true;
      depth++;
    } else if (trigger && body && token === "CASE") depth++;
    else if (trigger && body && token === "END") depth--;
  }
}
