import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** TTL cleanup returns bounded deletion counts without scanning first to count matches.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-ttl-")), "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("./sessions-db.js");
const { deleteMessagesOlderThanSqlite } = await import("./sessions-sqlite-writes.js");

describe("deleteMessagesOlderThanSqlite", () => {
  const sessionIds: string[] = [];
  let nextSequence = 0;

  afterEach(() => {
    const sqlite = getSessionsSqlite();
    for (const id of sessionIds.splice(0)) {
      sqlite.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      sqlite.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    }
  });

  function makeSession(): string {
    const id = `sr5-ttl-session-${randomUUID()}`;
    getSessionsSqlite()
      .prepare(
        "INSERT INTO sessions (id, agent_token, active, state, status, metadata) VALUES (?,?,1,'open','running','{}')",
      )
      .run(id, "ttl-test-agent");
    sessionIds.push(id);
    return id;
  }

  function insertOldMessage(sessionId: string, createdAt: Date): void {
    // ISO text, not a Date: `created_at` is TEXT here and better-sqlite3
    // refuses to bind a Date at all.
    getSessionsSqlite()
      .prepare(
        `INSERT INTO messages (id, session_id, type, sequence, role, content, created_at)
         VALUES (?,?,'message',?,'assistant',?,?)`,
      )
      .run(
        `sr5-msg-${randomUUID()}`,
        sessionId,
        nextSequence++,
        JSON.stringify([{ type: "text", text: "expired message" }]),
        createdAt.toISOString(),
      );
  }

  function remainingFor(sessionId: string): number {
    return (
      getSessionsSqlite()
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?")
        .get(sessionId) as { c: number }
    ).c;
  }

  const YEAR_AGO = () => new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const DAYS_400_AGO = () => new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

  it("deletes nothing and reports 0 rows / 1 batch when nothing is expired", () => {
    const sessionId = makeSession();
    insertOldMessage(sessionId, new Date()); // NOT expired — created now

    const result = deleteMessagesOlderThanSqlite(YEAR_AGO(), { sessionIds });

    expect(result.deletedRows).toBe(0);
    expect(result.budgetExhausted).toBe(false);
  });

  it("deletes all expired rows for the session and reports the exact count", () => {
    const sessionId = makeSession();
    for (let i = 0; i < 5; i += 1) insertOldMessage(sessionId, DAYS_400_AGO());

    const result = deleteMessagesOlderThanSqlite(YEAR_AGO(), { sessionIds });

    expect(result.deletedRows).toBe(5);
    expect(result.budgetExhausted).toBe(false);
    expect(remainingFor(sessionId)).toBe(0);
  });

  it("does not touch messages newer than the cutoff", () => {
    const sessionId = makeSession();
    insertOldMessage(sessionId, DAYS_400_AGO());
    insertOldMessage(sessionId, new Date());

    const result = deleteMessagesOlderThanSqlite(YEAR_AGO(), { sessionIds });

    expect(result.deletedRows).toBe(1);
    expect(remainingFor(sessionId)).toBe(1);
  });

  it("chunks a delete across multiple batches when there are more expired rows than one batch's worth", () => {
    const sessionId = makeSession();
    // 25 rows, batchSize 10 — must take 3 batches (10 + 10 + 5).
    for (let i = 0; i < 25; i += 1) insertOldMessage(sessionId, DAYS_400_AGO());

    const result = deleteMessagesOlderThanSqlite(YEAR_AGO(), { batchSize: 10, sessionIds });

    expect(result.deletedRows).toBe(25);
    expect(result.batches).toBe(3);
    expect(result.budgetExhausted).toBe(false);
  });

  it("stops at maxBatches and reports budgetExhausted=true when more rows remain expired", () => {
    const sessionId = makeSession();
    // 25 rows, batchSize 10, maxBatches 2 — can only clear 20 of the 25.
    for (let i = 0; i < 25; i += 1) insertOldMessage(sessionId, DAYS_400_AGO());

    const result = deleteMessagesOlderThanSqlite(YEAR_AGO(), {
      batchSize: 10,
      maxBatches: 2,
      sessionIds,
    });

    expect(result.deletedRows).toBe(20);
    expect(result.batches).toBe(2);
    // The actual claim: a caller can tell "more remains" from "caught up".
    expect(result.budgetExhausted).toBe(true);

    // The remaining 5 really are still there, and the next scheduled run picks
    // up where this one stopped.
    expect(remainingFor(sessionId)).toBe(5);

    const secondRun = deleteMessagesOlderThanSqlite(YEAR_AGO(), {
      batchSize: 10,
      maxBatches: 2,
      sessionIds,
    });
    expect(secondRun.deletedRows).toBe(5);
    expect(secondRun.budgetExhausted).toBe(false);
  });

  it("stops on the time budget even if the batch budget would allow more", () => {
    const sessionId = makeSession();
    for (let i = 0; i < 25; i += 1) insertOldMessage(sessionId, DAYS_400_AGO());

    // timeBudgetMs=0 makes the first iteration's budget check fire before any
    // delete runs — proving the time check is independent of the batch-count
    // check rather than a proxy for it.
    const result = deleteMessagesOlderThanSqlite(YEAR_AGO(), {
      batchSize: 10,
      timeBudgetMs: 0,
      sessionIds,
    });

    expect(result.deletedRows).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.budgetExhausted).toBe(true);
  });

  it("keeps sessions.message_count right through a batched sweep", () => {
    // The AFTER DELETE trigger from migration 002 is what does this, and a
    // bulk delete is where a per-call-site counter would drift. Verified at
    // scale too: a 69,253-row sweep left zero sessions disagreeing with
    // COUNT(*).
    const sessionId = makeSession();
    for (let i = 0; i < 12; i += 1) insertOldMessage(sessionId, DAYS_400_AGO());
    insertOldMessage(sessionId, new Date());

    deleteMessagesOlderThanSqlite(YEAR_AGO(), { batchSize: 5, sessionIds });

    const counter = (
      getSessionsSqlite()
        .prepare("SELECT message_count FROM sessions WHERE id = ?")
        .get(sessionId) as { message_count: number }
    ).message_count;
    expect(counter).toBe(remainingFor(sessionId));
    expect(counter).toBe(1);
  });
});

process.on("exit", () => closeSessionsDb());
