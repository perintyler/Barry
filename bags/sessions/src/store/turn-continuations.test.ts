import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnContinuations } from "./turn-continuations.js";
import { TurnExecution, type ContinuationDescriptor } from "@barry-rocks/sdk/sessions";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "barry-continuations-")); directories.push(directory);
  const path = join(directory, "sessions.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL"); db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('session'),('foreign');");
  db.exec(readFileSync(new URL("../../migrations/sessions/010_turn_continuations.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/sessions/011_turn_owner_process.sql", import.meta.url), "utf8"));
  const store = new TurnContinuations(db);
  const admission = { sessionId: "session", requestId: "request", runId: "run", actor: "user", content: "Work", policy: { mode: "review_required" as const } };
  const turn = store.admit(admission);
  expect(store.claim("session", turn.id, "owner")).toBe(true);
  const checkpoint: ContinuationDescriptor = { format: "fixture", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "config", payload: { original: "proposal" } };
  const call = { id: "call", tool: "effect", input: { exact: "original" } };
  const paused = store.pause("session", turn.id, "owner", checkpoint, [call]);
  store.released("session", turn.id, "owner");
  const resolution = { sessionId: "session", turnId: turn.id, requestId: "decision", runId: "resumed", actor: "user", decisions: [{ interruptId: paused.interrupts[0].id, decision: { allow: true as const } }] };
  return { path, db, store, admission, turn, checkpoint, call, resolution };
}

describe("durable turn receipts", () => {
  it("persists individual rulings across restart and resumes the batch exactly once", () => {
    const f = fixture();
    f.store.cancel("session", f.turn.id);
    const turn = f.store.admit({ ...f.admission, requestId: "batch", runId: "batch" });
    f.store.claim("session", turn.id, "owner");
    const paused = f.store.pause("session", turn.id, "owner", f.checkpoint, [f.call, { ...f.call, id: "second" }]);
    f.store.released("session", turn.id, "owner");
    const first = { sessionId: "session", turnId: turn.id, interruptId: paused.interrupts[0].id, decision: { allow: true as const }, actor: "first-reviewer" };
    expect(() => f.store.recordRuling({ ...first, sessionId: "foreign" })).toThrow("does not belong");
    expect(() => f.store.recordRuling({ ...first, interruptId: "foreign" })).toThrow("does not belong");
    expect(f.store.recordRuling(first).state).toBe("waiting_for_input");
    expect(() => f.store.resolve({ sessionId: "session", turnId: turn.id, requestId: "conflicting-batch", runId: "conflicting-batch", actor: "other-client", decisions: paused.interrupts.map((item) => ({ interruptId: item.id, decision: { allow: false } })) })).toThrow("different decision");
    expect(f.store.pendingRulings("session", turn.id).map((item) => item.id)).toEqual([paused.interrupts[1].id]);
    f.db.close();
    const db = new Database(f.path); const reopened = new TurnContinuations(db);
    try {
      expect(reopened.recordRuling(first).state).toBe("waiting_for_input");
      expect(() => reopened.recordRuling({ ...first, decision: { allow: false } })).toThrow("different decision");
      const second = { ...first, interruptId: paused.interrupts[1].id, decision: { allow: false as const }, actor: "second-reviewer" };
      const resumed = reopened.recordRuling(second);
      expect(resumed.state).toBe("running");
      expect(reopened.recordRuling(second)).toEqual(resumed);
      expect(reopened.decisions("session", turn.id).get("call")).toEqual({ allow: true });
      expect(reopened.decisions("session", turn.id).get("second")).toEqual({ allow: false });
      expect(db.prepare("SELECT count(*) AS n FROM session_resolution_receipts").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it("expires a partially reviewed batch to denial after downtime", () => {
    const f = fixture();
    f.store.cancel("session", f.turn.id);
    const turn = f.store.admit({ ...f.admission, requestId: "expiry-batch", runId: "expiry-batch" });
    f.store.claim("session", turn.id, "owner");
    const paused = f.store.pause("session", turn.id, "owner", f.checkpoint, [f.call, { ...f.call, id: "second" }]);
    f.store.released("session", turn.id, "owner");
    const before = new TurnContinuations(f.db, () => "2026-10-01T11:00:00.000Z");
    f.db.prepare("UPDATE session_interrupts SET expires_at='2026-10-01T12:00:00.000Z' WHERE turn_id=?").run(turn.id);
    before.recordRuling({ sessionId: "session", turnId: turn.id, interruptId: paused.interrupts[0].id, decision: { allow: true }, actor: "reviewer" });
    f.db.close();
    const db = new Database(f.path); const reopened = new TurnContinuations(db, () => "2026-10-01T13:00:00.000Z");
    try {
      expect(() => reopened.recordRuling({ sessionId: "session", turnId: turn.id, interruptId: paused.interrupts[1].id, decision: { allow: true }, actor: "late-reviewer" })).toThrow("deadline has passed");
      expect(reopened.expireDue()).toHaveLength(1);
      expect([...reopened.decisions("session", turn.id).values()].every((decision) => !decision.allow)).toBe(true);
      expect(reopened.expireDue()).toEqual([]);
    } finally { db.close(); }
  });

  it("cancels a v2 turn waiting for an execution lease without opening a harness", async () => {
    const f = fixture(); f.store.cancel("session", f.turn.id);
    const release = vi.fn();
    let grant!: (lease: { release(): void }) => void;
    const acquire = vi.fn(() => new Promise<{ release(): void }>(resolve => { grant = resolve; }));
    const openHarness = vi.fn();
    const execution = new TurnExecution({ store: f.store, acquire, openHarness, authorize: async () => ({ allow: true }) });
    try {
      const turn = execution.admit({ ...f.admission, requestId: "waiting-cancel", runId: "waiting-cancel" });
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
      const cancelled = execution.cancel("session", turn.id);
      expect(f.store.snapshot("session", turn.id).state).toBe("cancelled");
      grant({ release }); await cancelled;
      expect(openHarness).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(f.store.active("session")).toBeUndefined();
    } finally { grant?.({ release }); await execution.close(); f.db.close(); }
  });

  it("enforces an absolute expiry after downtime exactly once", () => {
    const f = fixture();
    f.db.prepare("UPDATE session_interrupts SET expires_at='2026-10-01T12:00:00.000Z'").run();
    f.db.close();
    const db = new Database(f.path);
    const store = new TurnContinuations(db, () => "2026-10-01T13:00:00.000Z");
    expect(() => store.resolve(f.resolution)).toThrow("deadline has passed");
    const expired = store.expireDue();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(f.turn.id);
    expect(expired[0].interrupts[0].status).toBe("expired");
    expect(store.decisions("session", f.turn.id).get("call")).toEqual({ allow: false, reason: "Approval deadline expired" });
    expect(store.expireDue()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM session_resolution_receipts").get()).toEqual({ n: 1 });
    db.close();
  });

  it("does not free a cancelled turn until physical harness cleanup completes", async () => {
    const f = fixture(); f.store.cancel("session", f.turn.id);
    let interrupt!: () => void; let releaseClose!: () => void;
    const stopped = new Promise<void>((resolve) => { interrupt = resolve; });
    const closed = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => closed);
    const execution = new TurnExecution({ store: f.store, authorize: async () => ({ allow: true }), openHarness: async () => ({
      approvalContinuation: "durable", validate: () => {}, restore: async () => ({ type: "completed" }),
      begin: async () => { await stopped; return { type: "completed" }; },
      interrupt: async () => { interrupt(); }, close,
    }) });
    const turn = execution.admit({ ...f.admission, requestId: "cancel-test", runId: "cancel-test" });
    await vi.waitFor(() => expect(f.db.prepare("SELECT owner FROM session_turns WHERE id=?").get(turn.id)).not.toEqual({ owner: null }));
    // Wait until the running harness has been acquired, then cancel it.
    await new Promise((resolve) => setImmediate(resolve));
    const cancelling = execution.cancel("session", turn.id);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(f.store.snapshot("session", turn.id).state).toBe("cancelled");
    expect(() => f.store.admit({ ...f.admission, requestId: "competitor", runId: "competitor" })).toThrow("active turn");
    releaseClose(); await cancelling;
    expect(f.store.active("session")).toBeUndefined();
    await execution.close(); f.db.close();
  });

  it("blocks uncertain owners and records a proven dead owner without retrying effects", () => {
    const f = fixture();
    const identity = { pid: 42, pid_started_at: 100, hostname: "fixture-host" };
    const store = new TurnContinuations(f.db, undefined, identity);
    store.resolve(f.resolution); store.claim("session", f.turn.id, "crashed-owner");
    f.db.prepare("INSERT INTO session_call_outcomes VALUES(?,?,?,'executing',NULL,?)").run(f.turn.id, f.call.id, "hash", "crashed-owner");
    store.reconcileOwners((observed) => {
      expect(observed).toEqual(identity);
      return { state: "unknown", reason: "other-host" };
    });
    expect(store.snapshot("session", f.turn.id).state).toBe("running");
    expect(store.claim("session", f.turn.id, "competitor")).toBe(false);
    store.reconcileOwners(() => ({ state: "alive" }));
    expect(store.snapshot("session", f.turn.id).state).toBe("running");
    store.reconcileOwners(() => ({ state: "dead", reason: "pid-reused" }));
    expect(store.snapshot("session", f.turn.id).state).toBe("recovery_required");
    expect(store.runnable()).toEqual([]);
    expect(f.db.prepare("SELECT state FROM session_call_outcomes").get()).toEqual({ state: "uncertain" });
    expect(() => store.admit({ ...f.admission, requestId: "new", runId: "new" })).toThrow("active turn");
    const events = store.replay("session").length;
    store.reconcileOwners(() => ({ state: "dead", reason: "no-process" }));
    expect(store.replay("session")).toHaveLength(events);
    f.db.close();
  });

  it("retains durable pauses after owner death and reports lost live callbacks", () => {
    const f = fixture();
    const identity = { pid: 42, pid_started_at: 100, hostname: "fixture-host" };
    f.db.prepare("UPDATE session_turns SET owner_process_json=?").run(JSON.stringify(identity));
    f.store.reconcileOwners(() => ({ state: "dead", reason: "no-process" }));
    expect(f.store.snapshot("session", f.turn.id).state).toBe("waiting_for_input");
    f.db.prepare("UPDATE session_turns SET continuation_json=?").run(JSON.stringify({ ...f.checkpoint, format: "barry.live.permission" }));
    f.store.reconcileOwners(() => ({ state: "dead", reason: "no-process" }));
    expect(f.store.snapshot("session", f.turn.id).state).toBe("recovery_required");
    expect(f.store.snapshot("session", f.turn.id).interrupts[0].status).toBe("pending");
    f.db.close();
  });

  it("keeps approvals and the exact checkpoint across closing and reopening the store", () => {
    const f = fixture(); f.db.close();
    const db = new Database(f.path); const reopened = new TurnContinuations(db);
    expect(reopened.snapshot("session", f.turn.id).state).toBe("waiting_for_input");
    expect(reopened.continuation("session", f.turn.id)).toEqual(f.checkpoint);
    const resumed = reopened.resolve(f.resolution);
    expect(resumed.id).toBe(f.turn.id); expect(resumed.runId).toBe("resumed");
    expect(reopened.resolve(f.resolution)).toEqual(resumed);
    expect(reopened.resolve({ ...f.resolution, requestId: "second-app", runId: "another-run" })).toEqual(resumed);
    expect(() => reopened.resolve({ ...f.resolution, requestId: "conflicting", decisions: [{ interruptId: f.resolution.decisions[0].interruptId, decision: { allow: false } }] })).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM session_run_segments").get()).toEqual({ n: 2 });
    expect(() => reopened.snapshot("foreign", f.turn.id)).toThrow(); db.close();
  });

  it("deduplicates accepted work and rejects reused request identities", () => {
    const f = fixture();
    expect(f.store.admit(f.admission).id).toBe(f.turn.id);
    expect(() => f.store.admit({ ...f.admission, content: "Changed" })).toThrow("different input");
    expect(() => f.store.resolve({ ...f.resolution, decisions: [] })).toThrow("every pending interrupt");
    expect(f.store.snapshot("session", f.turn.id).state).toBe("waiting_for_input"); f.db.close();
  });

  it("reuses durable outcomes and never blindly retries an uncertain effect", async () => {
    const f = fixture(); f.store.resolve(f.resolution);
    expect(f.store.claim("session", f.turn.id, "successor")).toBe(true);
    expect(f.store.claim("session", f.turn.id, "competitor")).toBe(false);
    let executions = 0;
    const effect = async () => { executions++; return { id: "call", result: "done" }; };
    await f.store.execute("session", f.turn.id, "successor", f.call, effect);
    await f.store.execute("session", f.turn.id, "successor", f.call, effect);
    expect(executions).toBe(1);
    f.db.prepare("UPDATE session_call_outcomes SET state='executing',outcome_json=NULL").run();
    await expect(f.store.execute("session", f.turn.id, "successor", f.call, effect)).rejects.toThrow("uncertain");
    expect(executions).toBe(1);
    await expect(f.store.execute("session", f.turn.id, "successor", { ...f.call, input: { exact: "changed" } }, effect)).rejects.toThrow("approved proposal");
    f.db.close();
  });

  it("detects corrupt private state and replays events only within their session", () => {
    const f = fixture();
    expect(f.store.replay("session")).toHaveLength(2); expect(f.store.replay("foreign")).toEqual([]);
    f.db.prepare("UPDATE session_turns SET continuation_json='{}'").run();
    expect(() => f.store.continuation("session", f.turn.id)).toThrow("Corrupt"); f.db.close();
  });

  it("queues an incoming turn when ifActive is queue, and promotes it after active turn completes", () => {
    const f = fixture();
    // f.turn is currently waiting_for_input (active)
    const queuedTurn = f.store.admit({
      sessionId: "session",
      requestId: "queued-req",
      runId: "queued-run",
      actor: "user",
      content: "Queued work",
      policy: { mode: "automatic" },
      ifActive: "queue",
    });
    expect(queuedTurn.state).toBe("queued");
    // While original turn is active, promoteQueued returns undefined
    expect(f.store.promoteQueued("session")).toBeUndefined();
    // Complete the original turn
    f.store.resolve(f.resolution);
    f.store.claim("session", f.turn.id, "owner");
    f.store.finish("session", f.turn.id, "owner", { state: "completed" });
    // Now promoting queued turn transitions it to running
    const promoted = f.store.promoteQueued("session");
    expect(promoted).toBeDefined();
    expect(promoted!.turn.id).toBe(queuedTurn.id);
    expect(promoted!.turn.state).toBe("running");
    expect(promoted!.input).toBe("Queued work");
    expect(f.store.active("session")?.id).toBe(queuedTurn.id);
    f.db.close();
  });
});

