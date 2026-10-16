import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Concurrent persistence must not lose tool results (code review F6).
 *
 * A caller that appends each event without awaiting the previous one lets a
 * `tool_result` reach its correlation lookup while the matching `tool_start`
 * is still awaiting its INSERT. Finding neither a pending
 * map entry nor a committed row, the old code returned successfully having
 * saved nothing -- the live client showed a result that vanished on reload.
 *
 * These tests overlap the two persists on purpose. `result: null` on the
 * committed row is the defect; a retained-and-attached result is the fix.
 *
 * PORTED FROM THE PREVIOUS STORE, WITH ONE PREMISE THAT NO LONGER HOLDS.
 * Stated up front, because a green suite here would otherwise imply coverage
 * it does not have.
 *
 * ON THE OLD CLIENT the overlap was real: each persist awaited a network
 * round-trip per statement, so two un-awaited calls genuinely interleave at
 * their `await` points and the `tool_result`'s correlation lookup runs BEFORE
 * the `tool_start`'s INSERT has committed or registered anything in the
 * pending map. Finding nothing, the old code dropped the result.
 *
 * ON SQLITE it does not. better-sqlite3 is SYNCHRONOUS: the `tool_start`'s
 * INSERT runs to completion inside its own turn, so by the time the
 * `tool_result` call is reached the row is already committed and the
 * correlation query (`findPendingToolCallRow`) finds it directly -- the retain
 * path is never needed. MEASURED, not assumed: with BOTH halves of the F6 fix
 * removed from messages.ts (`takeOrphanedResult` stubbed to undefined and
 * `retainOrphanedResult` deleted), the concurrent case below still comes back
 * with `result: "hi\n"`.
 *
 * So the first test is kept but is NOT the load-bearing one any more, and it
 * is labelled as such where it sits. The case that still proves the fix is the
 * strictly-before-ordering one: a result whose call has not been persisted at
 * all has nothing to correlate against on either store, so the retain path is
 * the only thing that can save it. That case DOES go red when
 * `retainOrphanedResult` is removed -- verified.
 *
 * This is a narrowing of what the suite can catch, not of what the code must
 * do. Model resolution still awaits before the INSERT, so the retain
 * machinery must keep working; what changed is that SQLite's synchrony hides
 * one of the two ways it used to be exercised.
 *
 * One more deliberate difference: the earlier version read the row back with
 * `messages.metadata->>'toolUseId' = ...`. That operator works on SQLite 3.38+
 * (this build is 3.53.1), but the read here uses a raw `json_extract`
 * statement instead -- so the assertion does not depend on the very operator
 * the correlation query under test also depends on. A broken `->>` would
 * otherwise make the lookup fail AND the verification fail in the same
 * direction, which reads as a pass.
 */
process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-concurrent-")), "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("./sessions-db.js");
const { appendMessageSqlite } = await import("./sessions-sqlite-writes.js");
const { forgetSession } = await import("./messages.js");

function makeSession(id: string): void {
  getSessionsSqlite()
    .prepare("INSERT INTO sessions (id, agent_token, metadata, created_at) VALUES (?,?,?,?)")
    .run(id, "concurrent-persist-test-agent", JSON.stringify({ source: "concurrent-persist-test" }), "2026-09-22T05:00:00.000Z");
}

function readToolCall(sessionId: string, toolUseId: string): { name: string | null; result: string | null } | undefined {
  return getSessionsSqlite()
    .prepare(
      `SELECT name, result FROM messages
       WHERE session_id = ? AND type = 'tool_call'
         AND json_extract(metadata, '$.toolUseId') = ?`,
    )
    .get(sessionId, toolUseId) as { name: string | null; result: string | null } | undefined;
}

describe("concurrent persistence of tool_start/tool_result", () => {
  const sessionIds: string[] = [];

  beforeAll(() => {
    getSessionsSqlite();
  });

  beforeEach(() => {
    getSessionsSqlite().exec("DELETE FROM provider_sessions; DELETE FROM messages; DELETE FROM sessions;");
    // The correlation maps are module-level and shared across stores: a
    // pending entry or retained orphan surviving into the next case could be
    // claimed by an unrelated call and make a broken implementation look fine.
    for (const id of sessionIds.splice(0)) forgetSession(id);
  });

  afterAll(() => {
    for (const id of sessionIds.splice(0)) forgetSession(id);
    closeSessionsDb();
  });

  function newSessionId(): string {
    const id = `concurrent-persist-${randomUUID()}`;
    sessionIds.push(id);
    makeSession(id);
    return id;
  }

  it("keeps the result when it is persisted concurrently with its tool_start (passes on SQLite even without the fix — see the file docblock)", async () => {
    const sessionId = newSessionId();
    const toolUseId = `tool-${randomUUID()}`;

    // KEPT, BUT NOT LOAD-BEARING HERE. On the async client this interleaved
    // and was the case the F6 fix existed for. better-sqlite3 is synchronous,
    // so the
    // tool_start's INSERT commits before this call's handler runs and the
    // correlation query finds the row without the retain path — verified by
    // removing both halves of the fix and watching this stay green.
    //
    // It stays because the CALL SHAPE is what production uses (fire-and-forget
    // from broadcastToSession) and it must not throw or double-insert; the
    // proof that the fix works is the strictly-before case below.
    //
    // Both in flight at once — no await between them, exactly as
    // broadcastToSession's fire-and-forget calls used to behave.
    const start = appendMessageSqlite(
      sessionId,
      { type: "tool_start", name: "Bash", input: { command: "echo hi" }, toolUseId },
      null,
    );
    const result = appendMessageSqlite(
      sessionId,
      { type: "tool_result", result: "hi\n", toolUseId },
    );
    await Promise.all([start, result]);

    const row = readToolCall(sessionId, toolUseId);
    expect(row).toBeDefined();
    expect(row?.name).toBe("Bash");
    // The assertion the defect fails: the row exists but its result is null.
    expect(row?.result).toBe("hi\n");
  });

  it("keeps the result when it arrives strictly before its tool_start (control for ordering, not timing)", async () => {
    const sessionId = newSessionId();
    const toolUseId = `tool-${randomUUID()}`;

    // THE LOAD-BEARING CASE ON SQLITE. Fully awaited, result first: the call
    // row does not exist yet at all, so there is nothing for the correlation
    // query to find no matter how synchronous the driver is. The retained
    // orphan is the only thing that can carry this result to the row, and
    // deleting `retainOrphanedResult` turns exactly this red.
    await appendMessageSqlite(sessionId, { type: "tool_result", result: "done", toolUseId });
    await appendMessageSqlite(
      sessionId,
      { type: "tool_start", name: "Read", input: { file: "/x" }, toolUseId },
    );

    expect(readToolCall(sessionId, toolUseId)?.result).toBe("done");
  });

  it("serialized persistence still works (control: the ordered path was never broken)", async () => {
    const sessionId = newSessionId();
    const toolUseId = `tool-${randomUUID()}`;

    await appendMessageSqlite(
      sessionId,
      { type: "tool_start", name: "Grep", input: { pattern: "x" }, toolUseId },
    );
    await appendMessageSqlite(sessionId, { type: "tool_result", result: "match", toolUseId });

    expect(readToolCall(sessionId, toolUseId)?.result).toBe("match");
  });

  it("a retained result is claimed by its own call, not by an unrelated later call", async () => {
    const sessionId = newSessionId();
    const orphanId = `tool-${randomUUID()}`;
    const otherId = `tool-${randomUUID()}`;

    // A result whose call never arrives must not be handed to a different call.
    await appendMessageSqlite(sessionId, { type: "tool_result", result: "orphan", toolUseId: orphanId });
    await appendMessageSqlite(
      sessionId,
      { type: "tool_start", name: "Bash", input: {}, toolUseId: otherId },
    );

    expect(readToolCall(sessionId, otherId)?.result).toBeNull();
  });

  it("does not hand a retained result to a LATER call with no toolUseId of its own", async () => {
    // The other half of the same rule, and the one the "exactly one pending
    // call" fallback in persistOne can get wrong: an untagged result must not
    // be matched against a retained orphan belonging to a different call.
    const sessionId = newSessionId();
    const orphanId = `tool-${randomUUID()}`;
    const realId = `tool-${randomUUID()}`;

    await appendMessageSqlite(sessionId, { type: "tool_result", result: "orphan", toolUseId: orphanId });
    await appendMessageSqlite(
      sessionId,
      { type: "tool_start", name: "Bash", input: {}, toolUseId: realId },
    );
    // Untagged result: the only pending call is `realId`, so this one IS its
    // result — but "orphan" must not be what lands there.
    await appendMessageSqlite(sessionId, { type: "tool_result", result: "mine" });

    expect(readToolCall(sessionId, realId)?.result).toBe("mine");
    // And the orphan never became a row of its own.
    const total = getSessionsSqlite()
      .prepare("SELECT count(*) AS n FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number };
    expect(total.n).toBe(1);
  });

  it("forgets a session's retained results when the session is forgotten", async () => {
    const sessionId = newSessionId();
    const toolUseId = `tool-${randomUUID()}`;

    await appendMessageSqlite(sessionId, { type: "tool_result", result: "stale", toolUseId });
    forgetSession(sessionId);
    await appendMessageSqlite(sessionId, { type: "tool_start", name: "Bash", input: {}, toolUseId });

    expect(readToolCall(sessionId, toolUseId)?.result).toBeNull();
  });

  it("keeps correlation state for a bounded number of sessions, dropping the least recently written", async () => {
    const first = newSessionId();
    const toolUseId = `tool-${randomUUID()}`;
    await appendMessageSqlite(first, { type: "tool_result", result: "early", toolUseId });

    // A result for a call that never arrives is kept only in memory, so a
    // thousand other sessions doing the same must push the first one out.
    for (let i = 0; i < 1024; i += 1) {
      const other = `concurrent-persist-crowd-${i}`;
      sessionIds.push(other);
      await appendMessageSqlite(other, { type: "tool_result", result: "x", toolUseId: `crowd-${i}` });
    }
    await appendMessageSqlite(first, { type: "tool_start", name: "Bash", input: {}, toolUseId });

    expect(readToolCall(first, toolUseId)?.result).toBeNull();
  });
});

it("records resident rows on a worker while a WAL writer holds the database",async()=>{
 const {default:Database}=await import("better-sqlite3");
 const {closeRecordingWorkers}=await import("./threaded-persist.js");
 const sessionId=`threaded-${randomUUID()}`;makeSession(sessionId);
 const path=getSessionsSqlite().name;
 const stamp=(sequence:number)=>({type:"text",role:"user" as const,content:`row ${sequence}`,sequence,dedupeKey:`engine:${randomUUID()}`});
 const holder=new Database(path);
 try {
  expect(await appendMessageSqlite(sessionId,stamp(0),null,{channel:"engine"})).toBe(0);
  holder.exec("BEGIN IMMEDIATE");
  const pending=appendMessageSqlite(sessionId,stamp(1),null,{channel:"engine"});
  const started=performance.now();await new Promise(resolve=>setTimeout(resolve,25));
  expect(performance.now()-started).toBeLessThan(1000);
  holder.exec("COMMIT");expect(await pending).toBe(1);
 } finally {if(holder.inTransaction)holder.exec("ROLLBACK");holder.close();await closeRecordingWorkers();closeSessionsDb();}
},20_000);

it("recovers published sequence collisions with an independent prompt writer and rebases the FIFO",async()=>{
 const {persistInThread,closeRecordingWorkers}=await import("./threaded-persist.js");
 const {queuePromptSqlite}=await import("./sessions-sqlite-writes.js");
 const id=`repair-${randomUUID()}`;makeSession(id);
 const db=getSessionsSqlite();
 try {
  queuePromptSqlite(id,"from MCP",{clientMessageId:"peer"});
  const frame=(sequence:number)=>({type:"text",role:"assistant" as const,content:`reply-${sequence}`,sequence,dedupeKey:`engine:${id}:${sequence}`});
  expect(await persistInThread(db.name,id,frame(0),null,null)).toBe(1);
  expect(await persistInThread(db.name,id,frame(0),null,null)).toBe(1);
  expect(await persistInThread(db.name,id,frame(1),null,null)).toBe(2);
  expect(await persistInThread(db.name,id,frame(2),null,null)).toBe(3);
  expect(db.prepare("SELECT content_text FROM messages WHERE session_id=? ORDER BY sequence").all(id)).toHaveLength(4);
 } finally {await closeRecordingWorkers();}
});
it("refuses a direct prompt insert into a live foreign resident",async()=>{
 const {hostname}=await import("node:os");const {readProcessStartTime}=await import("../process-liveness.js");
 const {queuePromptSqlite}=await import("./sessions-sqlite-writes.js");const id=`foreign-${randomUUID()}`;makeSession(id);
 getSessionsSqlite().prepare("UPDATE sessions SET metadata=? WHERE id=?").run(JSON.stringify({hosted_runtime_pid:process.ppid,hosted_runtime_started_at:readProcessStartTime(process.ppid),hosted_runtime_hostname:hostname()}),id);
 expect(()=>queuePromptSqlite(id,"must route through owner")).toThrow("resident owner");
});
it("queues resident inbox prompts off the API thread and preserves their explicit order",async()=>{
 const {enqueuePromptInThread,closeRecordingWorkers,persistInThread}=await import("./threaded-persist.js");
 const {default:Database}=await import("better-sqlite3");const id=`prompt-worker-${randomUUID()}`;makeSession(id);const path=getSessionsSqlite().name;const holder=new Database(path);
 try{
  holder.exec("BEGIN IMMEDIATE");
  const prompt=enqueuePromptInThread(path,id,"from MCP",{sequence:0,clientMessageId:"worker-prompt"});
  await new Promise(resolve=>setTimeout(resolve,25));holder.exec("COMMIT");
  expect((await prompt).sequence).toBe(0);
  expect((await enqueuePromptInThread(path,id,"from MCP",{sequence:1,clientMessageId:"worker-prompt"})).duplicate).toBe(true);
  expect(await persistInThread(path,id,{type:"text",role:"assistant",content:"answer",sequence:1,dedupeKey:`engine:${id}`},null,null)).toBe(1);
 }finally{if(holder.inTransaction)holder.exec("ROLLBACK");holder.close();await closeRecordingWorkers();}
},20000);
