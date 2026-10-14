import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";

vi.mock("./db.js", () => ({ getSessionRecord: async () => ({ metadata: {} }) }));
const directory = mkdtempSync(join(tmpdir(), "barry-turn-history-"));
process.env.BARRY_SESSIONS_DB = join(directory, "sessions.db");
process.env.BARRY_USAGE_DB = join(directory, "usage.db");
const { getSessionsSqlite, closeSessionsDb } = await import("@barry-rocks/sessions-bag/store/sessions-db");
const { closeUsageDb } = await import("./telemetry.js");
const { projectTurnHistory } = await import("./turn-history.js");
afterAll(() => { closeUsageDb(); closeSessionsDb(); rmSync(directory, { recursive: true, force: true }); });

describe("committed turn history projection", () => {
  it("recovers lost acknowledgements without duplicating messages, results or usage", async () => {
    const db = getSessionsSqlite();
    db.prepare("INSERT INTO sessions(id,agent_token,metadata) VALUES('history','fixture','{}')").run();
    const store = new TurnContinuations(db);
    const turn = store.admit({ sessionId: "history", requestId: "initial", runId: "initial", actor: "user", policy: { mode: "review_required" }, content: { message: { content: "Work" } } });
    store.claim("history", turn.id, "first");
    store.append("history", turn.id, { type: "partial", text: "Before " });
    store.append("history", turn.id, { type: "partial", text: "approval" });
    const call = { id: "original", tool: "write", input: { value: "exact" } };
    store.append("history", turn.id, { type: "tool_use", ...call });
    store.append("history", turn.id, { type: "usage", id: "provider-response", usage: { inputTokens: 4, outputTokens: 2 } });
    const paused = store.pause("history", turn.id, "first", { format: "fixture", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "config", payload: {} }, [call]);
    store.released("history", turn.id, "first");
    await projectTurnHistory(store);
    expect(db.prepare("SELECT count(*) AS n FROM messages WHERE session_id='history'").get()).toEqual({ n: 3 });
    store.resolve({ sessionId: "history", turnId: turn.id, requestId: "resume", runId: "resume", actor: "user", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true } }] });
    store.claim("history", turn.id, "second");
    store.append("history", turn.id, { type: "tool_result", id: "original", result: "Done" });
    store.append("history", turn.id, { type: "partial", text: "Finished" });
    store.finish("history", turn.id, "second", { state: "completed", result: "Finished" });
    await projectTurnHistory(store);
    const messages = db.prepare("SELECT type,role,content,result FROM messages WHERE session_id='history' ORDER BY sequence").all();
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({ type: "tool_call", result: "Done" });
    // Simulate a process dying after destination commit but before outbox ack.
    db.prepare("UPDATE session_execution_events SET history_projected_at=NULL").run();
    await projectTurnHistory(store);
    expect(db.prepare("SELECT type,role,content,result FROM messages WHERE session_id='history' ORDER BY sequence").all()).toEqual(messages);
    const usage = new Database(process.env.BARRY_USAGE_DB, { readonly: true });
    expect(usage.prepare("SELECT count(*) AS n FROM session_usage").get()).toEqual({ n: 1 });
    usage.close();
    expect(store.pendingHistory()).toEqual([]);
  });
});
