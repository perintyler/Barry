import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { SQLInputValue } from "node:sqlite";

/** Structural interface shared with callers that own an independent SQLite process. */
export interface SqliteStatement {
  get(...values: SQLInputValue[]): Record<string, unknown> | undefined;
  all(...values: SQLInputValue[]): Record<string, unknown>[];
  run(...values: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...values: SQLInputValue[]): IterableIterator<Record<string, unknown>>;
}
export interface SqliteConnection {
  exec(sql: string): unknown;
  prepare(sql: string): Pick<SqliteStatement, "get" | "all" | "run">;
}

/**
 * Runtime store probes must share the bags' SQLite library. Independently linked
 * SQLite copies in one process have separate handle bookkeeping: one copy can
 * unlink WAL/SHM while the other still writes through those files.
 */
export class SqliteDatabase {
  private readonly database: BetterSqlite3.Database;
  constructor(path: string, options: { readOnly?: boolean; open?: boolean } = {}) {
    this.database = new BetterSqlite3(path, { readonly: options.readOnly ?? false, fileMustExist: options.readOnly ?? false, timeout: 0 });
  }
  get isOpen(): boolean { return this.database.open; }
  get isTransaction(): boolean { return this.database.inTransaction; }
  exec(sql: string): this { this.database.exec(sql); return this; }
  prepare(sql: string): SqliteStatement {
    // Read exact integers first, then preserve built-in SQLite's default range
    // check instead of silently rounding an INTEGER into a JavaScript number.
    const statement = this.database.prepare<unknown[], Record<string, unknown>>(sql).safeIntegers(true);
    return {
      get: (...values) => { const row = statement.get(...values); return row === undefined ? undefined : numericRow(row); },
      all: (...values) => statement.all(...values).map(numericRow),
      run: (...values) => {
        const result = statement.run(...values);
        return { changes: numericInteger(result.changes), lastInsertRowid: numericInteger(result.lastInsertRowid) };
      },
      *iterate(...values) { for (const row of statement.iterate(...values)) yield numericRow(row); },
    };
  }
  async backup(path: string): Promise<void> { await this.database.backup(path); }
  close(): void { this.database.close(); }
}

function numericInteger(value: number | bigint): number {
  if (typeof value === "number") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw Object.assign(new RangeError(`Value is too large to be represented as a JavaScript number: ${value}`), { code: "ERR_OUT_OF_RANGE" });
  return number;
}
function numericRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? numericInteger(value) : value]));
}

/** Inspect sealed single-file snapshots without letting SQLite create archive sidecars. */
export async function withSqliteInspectionCopy<T>(path: string, inspect: (copy: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "barry-sqlite-inspect-"));
  try {
    const copy = join(directory, "snapshot.db");
    await copyFile(path, copy);
    return await inspect(copy);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
