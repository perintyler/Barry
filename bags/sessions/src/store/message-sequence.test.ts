/**
 * A message's sequence is assigned by the store, in the insert, so any number
 * of processes can append to one session and agree on its order; and the
 * duplicates history accumulated under per-process counters are renumbered
 * by migration 018 before the order is made unique.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import BetterSqlite3 from "better-sqlite3";
import { migrateStore } from "@barry-rocks/sdk/stores";

const scratch = mkdtempSync(join(tmpdir(), "barry-sequence-"));
process.env.BARRY_SESSIONS_DB = join(scratch, "sessions.db");

const { appendMessageSqlite, createSessionSqlite } = await import("./sessions-sqlite-writes.js");
const { closeSessionsDb, getSessionsSqlite } = await import("./sessions-db.js");
const migrations = (await import("../generated/sessions-migrations.js")).default;

afterAll(() => {
  closeSessionsDb();
  rmSync(scratch, { recursive: true, force: true });
});

function sequences(db: BetterSqlite3.Database, sessionId: string): number[] {
  return (db.prepare("SELECT sequence FROM messages WHERE session_id = ? ORDER BY sequence").all(sessionId) as { sequence: number }[])
    .map((row) => row.sequence);
}

describe("appending a message", () => {
  let sessionId: string;
  const session = (): string => {
    const id = randomUUID();
    createSessionSqlite({ id, agent_token: null, metadata: {} });
    return id;
  };
  beforeAll(() => { sessionId = session(); });

  it("takes the next sequence in its session and answers it", async () => {
    expect(await appendMessageSqlite(sessionId, { type: "text", role: "user", content: "one" })).toBe(0);
    expect(await appendMessageSqlite(sessionId, { type: "text", role: "assistant", content: "two" })).toBe(1);
    expect(await appendMessageSqlite(sessionId, { type: "init", content: "three" })).toBe(2);
  });

  it("answers null for a row it already holds", async () => {
    const first = await appendMessageSqlite(sessionId, { type: "text", role: "assistant", content: "seen", dedupeKey: "k1" });
    expect(first).toBe(3);
    expect(await appendMessageSqlite(sessionId, { type: "text", role: "assistant", content: "seen", dedupeKey: "k1" })).toBeNull();
    expect(sequences(getSessionsSqlite(), sessionId)).toEqual([0, 1, 2, 3]);
  });

  it("keeps one order when two processes append to the same session at once", async () => {
    const shared = session();
    const writer = join(scratch, "append.mts");
    const module = fileURLToPath(new URL("./sessions-sqlite-writes.ts", import.meta.url));
    writeFileSync(writer, `
      const { appendMessageSqlite } = await import(${JSON.stringify(module)});
      for (let i = 0; i < 150; i += 1) await appendMessageSqlite(process.argv[2], { type: "text", role: "assistant", content: process.pid + ":" + i });
    `);
    const run = () => promisify(execFile)(process.execPath, ["--import", "tsx", writer, shared], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, BARRY_SESSIONS_DB: process.env.BARRY_SESSIONS_DB },
    });
    await Promise.all([run(), run()]);
    expect(sequences(getSessionsSqlite(), shared)).toEqual(Array.from({ length: 300 }, (_, i) => i));
  }, 120_000);
});

describe("migration 018", () => {
  it("renumbers a session's duplicate sequences, keeping their order and moving as few as it can", () => {
    const db = new BetterSqlite3(":memory:");
    migrateStore(db, migrations.slice(0, 17), "sessions.db");
    const insertSession = db.prepare("INSERT INTO sessions (id, metadata) VALUES (?, ?)");
    insertSession.run("dup", JSON.stringify({ embedding_watermark_seq: 6 }));
    insertSession.run("clean", JSON.stringify({ embedding_watermark_seq: 2 }));
    const insert = db.prepare("INSERT INTO messages (id, session_id, type, sequence, created_at) VALUES (?, ?, 'message', ?, ?)");
    [0, 1, 1, 2, 5, 5, 6].forEach((sequence, i) => insert.run(`dup-${i}`, "dup", sequence, `2026-10-01T00:00:0${i}Z`));
    [0, 1, 2].forEach((sequence, i) => insert.run(`clean-${i}`, "clean", sequence, `2026-10-01T00:00:0${i}Z`));

    migrateStore(db, migrations, "sessions.db");

    const ordered = (session: string) => (db.prepare("SELECT id, sequence FROM messages WHERE session_id = ? ORDER BY sequence").all(session) as { id: string; sequence: number }[]);
    expect(ordered("dup")).toEqual([0, 1, 2, 3, 5, 6, 7].map((sequence, i) => ({ id: `dup-${i}`, sequence })));
    expect(ordered("clean").map((row) => row.sequence)).toEqual([0, 1, 2]);
    const watermark = (session: string) => JSON.parse((db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(session) as { metadata: string }).metadata).embedding_watermark_seq;
    expect(watermark("dup")).toBeUndefined();
    expect(watermark("clean")).toBe(2);
    expect(() => insert.run("again", "clean", 2, "2026-10-01T00:00:09Z")).toThrow(/UNIQUE/);
  });
});
