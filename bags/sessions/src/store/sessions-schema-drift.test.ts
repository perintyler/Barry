import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionsSqlite, closeSessionsDb } from "./sessions-db.js";
import { SESSIONS_STORE_COLUMNS } from "./sessions-types.js";

/**
 * The sessions store's schema-drift guard: the Kysely types must match what
 * the migrations build. A guard of this shape once caught a `traits.skills`
 * bug that had hidden for months.
 *
 * Runs against a throwaway file, not the developer's store: the point is to
 * check what the migrations BUILD, and a store that already exists could pass
 * while the migration that creates it is broken.
 */
process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-sessions-drift-")), "sessions.db");

function columnsOf(table: string): string[] {
  return (getSessionsSqlite().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((r) => r.name)
    .sort();
}

describe("sessions store schema", () => {
  afterAll(() => closeSessionsDb());

  it.each(Object.keys(SESSIONS_STORE_COLUMNS) as (keyof typeof SESSIONS_STORE_COLUMNS)[])(
    "%s: declared columns match the live schema, both directions",
    (table) => {
      const live = columnsOf(table);
      const declared = [...SESSIONS_STORE_COLUMNS[table]].sort();
      // Bidirectional on purpose: a live column missing from the declaration is
      // a migration the types do not know about, and a declared column with no
      // live counterpart is a stale or typo'd type. Either one makes every
      // query built from these types wrong in a way nothing else notices.
      expect(live, `${table} columns drifted`).toEqual(declared);
    },
  );

  it("keeps messages.id as the primary key, not (session_id, sequence)", () => {
    // 1,116 (session_id, sequence) pairs collide in production. A composite key
    // would drop them on import and still pass a naive row-count check.
    const pk = (getSessionsSqlite().prepare("PRAGMA table_info(messages)").all() as {
      name: string;
      pk: number;
    }[]).filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(["id"]);
  });

  it("enforces foreign keys on the connection", () => {
    // Three relationships in this schema are real foreign keys, and they
    // enforce nothing on a connection where foreign_keys is off. So this test
    // asserts the OUTCOME — an orphan insert throws — rather than the setting.
    //
    // Honest caveat, established by trying it: removing
    // `pragma("foreign_keys = ON")` from sessions-db.ts does NOT turn this
    // test red, because the better-sqlite3 build vendored here already
    // defaults the pragma to 1. So this guards the schema (the FKs exist and
    // are declared correctly), not the pragma line. If the driver is ever
    // swapped or upgraded to one that defaults to off, the explicit pragma is
    // what keeps this passing — which is the reason to keep it rather than
    // delete it as redundant.
    const sqlite = getSessionsSqlite();
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      sqlite
        .prepare("INSERT INTO messages (id, session_id, type) VALUES (?, ?, ?)")
        .run("drift-orphan", "no-such-session", "message"),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("uses WAL NORMAL for background recording (power-loss tradeoff documented in ADR 0049)", () => {
    expect(getSessionsSqlite().pragma("journal_mode", { simple: true })).toBe("wal");
    expect(getSessionsSqlite().pragma("synchronous", { simple: true })).toBe(1);
  });

  it("indexes the FTS5 table over messages rather than duplicating its content", () => {
    // External content: the index stores terms and reads values back from
    // `messages` by rowid. A standalone fts5 table would hold a second copy of
    // 638 MB of message bodies.
    const sql = (getSessionsSqlite()
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_fts'")
      .get() as { sql: string }).sql;
    expect(sql).toContain("content='messages'");
    expect(sql).toContain("content_rowid='rowid'");
  });
});
