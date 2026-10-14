import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-processes-")), "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("./sessions-db.js");
const { createSessionSqlite, endSessionSqlite, markCrashedSessionsSqlite, deleteSessionSqlite } = await import(
  "./sessions-sqlite-writes.js"
);
const {
  recordProcessStart,
  markProcessEnded,
  markProcessInstanceEnded,
  stampLiveness,
  getLiveProcess,
  getLiveProcessesBySessions,
  listLiveProcesses,
  listProcesses,
  listReapCandidates,
} = await import("./processes.js");

const TEST_SESSION_ID = "proc-session-1";
const TEST_SESSION_ID_2 = "proc-session-2";

function resetDb(): void {
  const sqlite = getSessionsSqlite();
  sqlite.prepare("DELETE FROM processes").run();
  sqlite.prepare("DELETE FROM sessions").run();
}

describe("processes store", () => {
  beforeEach(() => {
    resetDb();
  });

  afterAll(() => {
    closeSessionsDb();
  });

  it("records process start and updates metadata on conflict while live", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });

    const initial = recordProcessStart({
      sessionId: TEST_SESSION_ID,
      pid: 1234,
      pidStartedAt: 1700000000,
      hostname: "test-host",
      processName: "node",
      command: "node agent.js",
      appName: "claude",
      parentPid: 1000,
      source: "cli",
    });

    expect(initial.sessionId).toBe(TEST_SESSION_ID);
    expect(initial.pid).toBe(1234);
    expect(initial.endedAt).toBeNull();

    // Upsert against live row
    const updated = recordProcessStart({
      sessionId: TEST_SESSION_ID,
      pid: 1234,
      pidStartedAt: 1700000000,
      hostname: "test-host",
      processName: "node-worker",
      command: "node agent.js --flag",
      appName: "claude",
      parentPid: 1000,
      source: "cli",
    });

    expect(updated.id).toBe(initial.id);
    expect(updated.processName).toBe("node-worker");
    expect(updated.command).toBe("node agent.js --flag");

    const live = getLiveProcess(TEST_SESSION_ID);
    expect(live?.id).toBe(initial.id);
    expect(live?.processName).toBe("node-worker");
  });

  it("appends history: ending a process allows a new row for the same session", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });

    const first = recordProcessStart({
      sessionId: TEST_SESSION_ID,
      pid: 1001,
      pidStartedAt: 1700000000,
      source: "cli",
    });

    markProcessEnded(TEST_SESSION_ID, "process-exited");

    const liveAfterEnd = getLiveProcess(TEST_SESSION_ID);
    expect(liveAfterEnd).toBeNull();

    const second = recordProcessStart({
      sessionId: TEST_SESSION_ID,
      pid: 1002,
      pidStartedAt: 1700000500,
      source: "cli",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.pid).toBe(1002);
    expect(second.endedAt).toBeNull();

    const allHistory = listProcesses(TEST_SESSION_ID);
    expect(allHistory).toHaveLength(2);
    expect(allHistory[0].id).toBe(first.id);
    expect(allHistory[0].endedAt).not.toBeNull();
    expect(allHistory[0].livenessReason).toBe("process-exited");
    expect(allHistory[1].id).toBe(second.id);
  });

  it("reads the live process of each session asked for, the latest after a replacement", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    createSessionSqlite({ id: TEST_SESSION_ID_2, agent_token: "test-token", metadata: {} });
    createSessionSqlite({ id: "proc-session-3", agent_token: "test-token", metadata: {} });
    recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1001, pidStartedAt: 1700000000, hostname: "host" });
    const replacement = recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1002, pidStartedAt: 1700000500, hostname: "host" });
    recordProcessStart({ sessionId: TEST_SESSION_ID_2, pid: 2001, pidStartedAt: 1700000000 });
    markProcessEnded(TEST_SESSION_ID_2, "process-exited");
    recordProcessStart({ sessionId: "proc-session-3", pid: 3001, pidStartedAt: 1700000000 });

    const live = getLiveProcessesBySessions([TEST_SESSION_ID, TEST_SESSION_ID_2, "unknown-session"]);
    expect([...live.keys()]).toEqual([TEST_SESSION_ID]);
    expect(live.get(TEST_SESSION_ID)).toMatchObject({ id: replacement.id, pid: 1002, pidStartedAt: 1700000500, hostname: "host" });
    expect(getLiveProcessesBySessions([]).size).toBe(0);
  });

  it("stamps liveness in a batch transaction", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    createSessionSqlite({ id: TEST_SESSION_ID_2, agent_token: "test-token", metadata: {} });

    const p1 = recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 2001, source: "cli" });
    const p2 = recordProcessStart({ sessionId: TEST_SESSION_ID_2, pid: 2002, source: "cli" });

    stampLiveness([
      { id: p1.id, liveness: "alive" },
      { id: p2.id, liveness: "dead", livenessReason: "no-process" },
    ]);

    const p1Updated = getLiveProcess(TEST_SESSION_ID);
    const p2Updated = getLiveProcess(TEST_SESSION_ID_2);

    expect(p1Updated?.liveness).toBe("alive");
    expect(p1Updated?.lastCheckedAt).not.toBeNull();
    expect(p2Updated?.liveness).toBe("dead");
    expect(p2Updated?.livenessReason).toBe("no-process");
    expect(p2Updated?.lastCheckedAt).not.toBeNull();
  });

  it("trigger closes process row when session ends via endSession", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    const proc = recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 3001, source: "cli" });

    expect(getLiveProcess(TEST_SESSION_ID)).not.toBeNull();

    endSessionSqlite(TEST_SESSION_ID, "completed");

    const live = getLiveProcess(TEST_SESSION_ID);
    expect(live).toBeNull();

    const history = listProcesses(TEST_SESSION_ID);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(proc.id);
    expect(history[0].endedAt).not.toBeNull();
  });

  it("trigger closes process row when session crashes via markCrashedSessions", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    getSessionsSqlite().prepare("UPDATE sessions SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(TEST_SESSION_ID);
    recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 4001, source: "cli" });

    markCrashedSessionsSqlite(0);

    expect(getLiveProcess(TEST_SESSION_ID)).toBeNull();
  });

  it("control-store cleanup removes processes when a local session is deleted", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 5001, source: "cli" });

    deleteSessionSqlite(TEST_SESSION_ID);

    expect(listProcesses(TEST_SESSION_ID)).toHaveLength(0);
  });

  it("listReapCandidates returns round-robin candidates unprobed first", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    createSessionSqlite({ id: TEST_SESSION_ID_2, agent_token: "test-token", metadata: {} });

    const p1 = recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 6001, source: "cli" });
    const p2 = recordProcessStart({ sessionId: TEST_SESSION_ID_2, pid: 6002, source: "cli" });

    // p1 was checked earlier
    stampLiveness([{ id: p1.id, liveness: "alive" }]);

    const candidates = listReapCandidates(10);
    expect(candidates).toHaveLength(2);
    // Unchecked p2 comes first
    expect(candidates[0].id).toBe(p2.id);
    expect(candidates[1].id).toBe(p1.id);
  });
  it.each([
    { pid: 1235 }, { pidStartedAt: 1700000001 }, { hostname: "another-host" },
  ])("retains the old instance when its identity changes: %j", replacement => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    const input = { sessionId: TEST_SESSION_ID, pid: 1234, pidStartedAt: 1700000000, hostname: "original-host", command: "original command" };
    const first = recordProcessStart(input);
    const second = recordProcessStart({ ...input, ...replacement, command: "new command" });
    expect(second.id).toBeGreaterThan(first.id);
    const history = listProcesses(TEST_SESSION_ID);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ id: first.id, pid: first.pid, pidStartedAt: first.pidStartedAt, hostname: first.hostname,
      command: "original command", endedAt: expect.any(String), livenessReason: "process-replaced" });
    expect(markProcessInstanceEnded(first, "delayed close")).toBe(false);
    expect(getLiveProcess(TEST_SESSION_ID)?.id).toBe(second.id);
    expect(markProcessInstanceEnded(second, "exact close")).toBe(true);
    expect(markProcessInstanceEnded(second, "repeat close")).toBe(false);
    expect(getLiveProcess(TEST_SESSION_ID)).toBeNull();
  });
  it.each([
    { id: 999999 }, { sessionId: "another-session" }, { pid: 5678 }, { pidStartedAt: 1700000001 },
    { hostname: "another-host" }, { startedAt: "2000-01-01T00:00:00Z" },
  ])("refuses mismatched instance bindings without changing a record: %j", mismatch => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    const process = recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1234, pidStartedAt: 1700000000, hostname: "original-host" });
    const before = listProcesses(TEST_SESSION_ID);
    expect(markProcessInstanceEnded({ ...process, ...mismatch }, "mismatch")).toBe(false);
    expect(listProcesses(TEST_SESSION_ID)).toEqual(before);
  });
  it("compares nullable identity fields exactly", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    const process = recordProcessStart({ sessionId: TEST_SESSION_ID });
    expect(markProcessInstanceEnded({ ...process, pid: 1234 })).toBe(false);
    expect(markProcessInstanceEnded(process, "closed pending record")).toBe(true);
  });

  it("rolls back the previous instance's closure if replacement insertion fails", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    const process = recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1234 });
    const sqlite = getSessionsSqlite();
    sqlite.exec("CREATE TEMP TRIGGER reject_process_replacement BEFORE INSERT ON processes WHEN NEW.pid=5678 BEGIN SELECT RAISE(ABORT,'replacement rejected'); END");
    try {
      expect(() => recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 5678 })).toThrow("replacement rejected");
      expect(getLiveProcess(TEST_SESSION_ID)).toEqual(process);
      expect(listProcesses(TEST_SESSION_ID)).toEqual([process]);
    } finally { sqlite.exec("DROP TRIGGER reject_process_replacement"); }
  });
  it("serializes competing adoptions from separate Node processes without losing either history", async () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1111, pidStartedAt: 1700000000 });
    const source = new URL("./processes.ts", import.meta.url).href;
    const script = `process.env.BARRY_SESSIONS_DB=process.argv[1]; const {recordProcessStart}=await import(${JSON.stringify(source)}); recordProcessStart({sessionId:${JSON.stringify(TEST_SESSION_ID)},pid:Number(process.argv[2]),pidStartedAt:1700000000});`;
    await Promise.all([2222, 3333].map(pid => promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, getSessionsSqlite().name, String(pid)], { env: { ...process.env }, timeout: 10000 })));
    const history = listProcesses(TEST_SESSION_ID);
    expect(history).toHaveLength(3);
    expect(history.map(process => process.pid).sort()).toEqual([1111,2222,3333]);
    expect(history.filter(process => process.endedAt === null)).toHaveLength(1);
    expect(history.filter(process => process.endedAt !== null)).toHaveLength(2);
    expect(new Set(history.map(process => process.id)).size).toBe(3);
  }, 15000);

});

describe("process adoption requires an open existing Session", () => {
  beforeEach(resetDb);
  for (const state of ["closed", "crashed", "archived"]) {
    it(`refuses ${state} without changing preserved process history`, () => {
      createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
      recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1234 });
      getSessionsSqlite().prepare("UPDATE sessions SET state=? WHERE id=?").run(state, TEST_SESSION_ID);
      const before = listProcesses(TEST_SESSION_ID);
      expect(() => recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 5678 })).toThrow("unavailable for process adoption");
      expect(listProcesses(TEST_SESSION_ID)).toEqual(before);
    });
  }
  it("refuses an ended Session even if its state was changed back to open", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, agent_token: "test-token", metadata: {} });
    recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1234 });
    endSessionSqlite(TEST_SESSION_ID);
    getSessionsSqlite().prepare("UPDATE sessions SET state='open', status='pending' WHERE id=?").run(TEST_SESSION_ID);
    const before = listProcesses(TEST_SESSION_ID);
    expect(() => recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 5678 })).toThrow("unavailable for process adoption");
    expect(listProcesses(TEST_SESSION_ID)).toEqual(before);
  });
  it("does not manufacture a Session or process for a missing parent", () => {
    expect(() => recordProcessStart({ sessionId: "missing", pid: 1234 })).toThrow("unavailable for process adoption");
    expect(listProcesses("missing")).toEqual([]);
    expect(getSessionsSqlite().prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
  it("allows a process to start in a prepared inactive open Session", () => {
    createSessionSqlite({ id: TEST_SESSION_ID, active: false, agent_token: "test-token", metadata: {} });
    expect(recordProcessStart({ sessionId: TEST_SESSION_ID, pid: 1234 }).pid).toBe(1234);
  });
});
