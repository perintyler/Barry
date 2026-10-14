import BetterSqlite3 from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import { MIGRATIONS } from "./sessions-db.js";
import { drainProcessCleanup, installProcessCleanup, normalizeProcessCleanupIntent } from "./process-cleanup.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "barry-process-cleanup-"));
  const source = new BetterSqlite3(join(directory, "partition.db"));
  const control = new BetterSqlite3(join(directory, "control.db"));
  for (const db of [source, control]) {
    db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");
    migrateStore(db, MIGRATIONS, "cleanup-fixture");
  }
  installProcessCleanup(source, () => control);
  source.prepare("INSERT INTO sessions(id,user_id,identity_id,metadata,active) VALUES('session',7,8,'{}',1)").run();
  control.prepare("INSERT INTO processes(session_id,pid,pid_started_at,hostname) VALUES('session',123,456,'host')").run();
  return { directory, source, control, close() { source.close(); control.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it("commits the exact instance and source owners with the session change", () => {
  const f = fixture();
  try {
    f.source.prepare("UPDATE sessions SET active=0 WHERE id='session'").run();
    expect(f.source.prepare("SELECT session_id,user_id,identity_id,action FROM process_cleanup_intents").get()).toEqual({ session_id: "session", user_id: 7, identity_id: 8, action: "close" });
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: null });
    expect(drainProcessCleanup(f.source, f.control)).toBe(1);
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).not.toEqual({ ended_at: null });
    expect(drainProcessCleanup(f.source, f.control)).toBe(0);
  } finally { f.close(); }
});

it("rolls back intents and never drains an uncommitted Session transaction", () => {
  const f = fixture();
  try {
    expect(() => f.source.transaction(() => {
      f.source.prepare("DELETE FROM sessions").run();
      expect(drainProcessCleanup(f.source, f.control)).toBe(0);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(f.source.prepare("SELECT count(*) AS count FROM process_cleanup_intents").get()).toEqual({ count: 0 });
    expect(f.source.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: null });
  } finally { f.close(); }
});

it("deletes only captured history and preserves a later replacement", () => {
  const f = fixture();
  try {
    f.source.prepare("DELETE FROM sessions").run();
    f.control.prepare("UPDATE processes SET ended_at='old'").run();
    f.control.prepare("INSERT INTO processes(session_id,pid,pid_started_at,hostname) VALUES('session',123,999,'host')").run();
    expect(drainProcessCleanup(f.source, f.control)).toBe(1);
    expect(f.control.prepare("SELECT pid_started_at,ended_at FROM processes").all()).toEqual([{ pid_started_at: 999, ended_at: null }]);
  } finally { f.close(); }
});

for (const window of ["after-session-commit", "before-acknowledgement"]) {
  it(`recovers from actual SIGKILL ${window} without touching a replacement`, () => {
    const f = fixture();
    try {
      const script = `
        import Database from 'better-sqlite3';
        import { installProcessCleanup, drainProcessCleanup } from './src/store/process-cleanup.ts';
        const source=new Database(process.argv[1]), control=new Database(process.argv[2]);
        installProcessCleanup(source,()=>control);
        source.prepare("UPDATE sessions SET active=0 WHERE id='session'").run();
        if(process.argv[3]==='before-acknowledgement') {
          source.function('crash_before_ack',()=>{process.kill(process.pid,'SIGKILL');});
          source.exec('CREATE TEMP TRIGGER crash BEFORE DELETE ON process_cleanup_intents BEGIN SELECT crash_before_ack(); END');
          drainProcessCleanup(source,control);
        }
        process.kill(process.pid,'SIGKILL');
      `;
      let signal: string | undefined;
      try { execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.source.name, f.control.name, window], { cwd: new URL("../..", import.meta.url), stdio: "pipe" }); }
      catch (error) { signal = (error as { signal: string }).signal; }
      expect(signal).toBe("SIGKILL");
      expect(f.source.prepare("SELECT active FROM sessions").get()).toEqual({ active: 0 });
      expect(f.source.prepare("SELECT count(*) AS count FROM process_cleanup_intents").get()).toEqual({ count: 1 });
      f.control.prepare("UPDATE processes SET ended_at=COALESCE(ended_at,'replaced')").run();
      f.control.prepare("INSERT INTO processes(session_id,pid,pid_started_at,hostname) VALUES('session',123,999,'host')").run();
      const reopened = new BetterSqlite3(f.source.name);
      try { expect(drainProcessCleanup(reopened, f.control)).toBe(1); }
      finally { reopened.close(); }
      expect(f.control.prepare("SELECT ended_at FROM processes WHERE pid_started_at=999").get()).toEqual({ ended_at: null });
      expect(drainProcessCleanup(f.source, f.control)).toBe(0);
    } finally { f.close(); }
  });
}

it("supports a Session and process in the same database", () => {
  const f = fixture();
  try {
    installProcessCleanup(f.control, () => f.control);
    f.control.prepare("INSERT INTO sessions(id,metadata) VALUES('session','{}')").run();
    f.control.prepare("UPDATE sessions SET active=0 WHERE id='session'").run();
    expect(drainProcessCleanup(f.control, f.control)).toBe(0);
    f.control.prepare("DELETE FROM sessions").run();
    expect(drainProcessCleanup(f.control, f.control)).toBe(0);
    expect(f.control.prepare("SELECT * FROM processes").all()).toEqual([]);
  } finally { f.close(); }
});

it("retains an intent when its target or stored bindings cannot be verified", () => {
  const f = fixture();
  try {
    f.source.prepare("DELETE FROM sessions").run();
    f.source.prepare("UPDATE process_cleanup_intents SET target_path='different.db'").run();
    expect(() => drainProcessCleanup(f.source, f.control)).toThrow("target differs");
    f.source.prepare("UPDATE process_cleanup_intents SET target_path=?,instances='[{}]'").run(f.control.name);
    expect(() => drainProcessCleanup(f.source, f.control)).toThrow();
    expect(f.source.prepare("SELECT count(*) AS count FROM process_cleanup_intents").get()).toEqual({ count: 1 });
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: null });
  } finally { f.close(); }
});

for (const state of ["closed", "crashed", "archived"]) {
  it(`captures cross-file cleanup when only Session state becomes ${state}`, () => {
    const f = fixture();
    try {
      f.source.prepare("UPDATE sessions SET state=? WHERE id='session'").run(state);
      expect(drainProcessCleanup(f.source, f.control)).toBe(1);
      expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: expect.any(String) });
    } finally { f.close(); }
  });
}

it("refuses an instance bound to a different Session while retaining the intent", () => {
  const f = fixture();
  try {
    f.source.prepare("DELETE FROM sessions").run();
    f.source.prepare("UPDATE process_cleanup_intents SET session_id='different'").run();
    expect(() => drainProcessCleanup(f.source, f.control)).toThrow("differs from its recorded Session");
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: null });
    expect(f.source.prepare("SELECT count(*) AS count FROM process_cleanup_intents").get()).toEqual({ count: 1 });
  } finally { f.close(); }
});

it("does not substitute a later intent if a competing worker already acknowledged the selected one", () => {
  const f = fixture();
  try {
    f.source.prepare("UPDATE sessions SET active=0 WHERE id='session'").run();
    f.source.prepare("DELETE FROM sessions").run();
    f.source.prepare("DELETE FROM process_cleanup_intents WHERE id=1").run();
    f.source.prepare("UPDATE process_cleanup_intents SET instances='[{}]' WHERE id=2").run();
    expect(drainProcessCleanup(f.source, f.control, 1, 0, 1)).toBe(0);
    expect(f.source.prepare("SELECT id FROM process_cleanup_intents").all()).toEqual([{ id: 2 }]);
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: null });
  } finally { f.close(); }
});

function addHistory(control: BetterSqlite3.Database, count: number) {
  control.prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO processes(session_id,pid,pid_started_at,hostname,ended_at)
    SELECT 'session',1000+value,1700000000+value,'history-host','2026-01-01T00:00:00Z' FROM n`).run(count);
}
it("captures a large deleted history as individually bounded durable intents", () => {
  const f = fixture();
  try {
    addHistory(f.control, 20_000);
    f.source.prepare("DELETE FROM sessions").run();
    const captured = f.source.prepare("SELECT count(*) AS n,min(json_array_length(instances)) AS minimum,max(json_array_length(instances)) AS maximum,max(length(CAST(instances AS BLOB))) AS bytes,sum(length(CAST(instances AS BLOB))) AS total FROM process_cleanup_intents").get() as { n: number; minimum: number; maximum: number; bytes: number; total: number };
    expect(captured).toMatchObject({ n: 20_001, minimum: 1, maximum: 1 });
    expect(captured.bytes).toBeLessThan(500); expect(captured.total).toBeGreaterThan(1024 * 1024);
    expect(drainProcessCleanup(f.source, f.control, 64)).toBe(64);
    expect(f.source.prepare("SELECT count(*) AS n FROM process_cleanup_intents").get()).toEqual({ n: 19_937 });
    expect(f.control.prepare("SELECT count(*) AS n FROM processes").get()).toEqual({ n: 19_937 });
  } finally { f.close(); }
});
it("rolls back a failed streaming capture and releases its control-store iterator", () => {
  const f = fixture();
  try {
    addHistory(f.control, 5);
    f.source.exec("CREATE TEMP TRIGGER reject_capture BEFORE INSERT ON process_cleanup_intents WHEN json_extract(NEW.instances,'$[0].id')=3 BEGIN SELECT RAISE(ABORT,'capture refused'); END");
    expect(() => f.source.prepare("DELETE FROM sessions").run()).toThrow("capture refused");
    expect(f.source.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(f.source.prepare("SELECT count(*) AS n FROM process_cleanup_intents").get()).toEqual({ n: 0 });
    expect(f.control.prepare("SELECT count(*) AS n FROM processes").get()).toEqual({ n: 6 });
    expect(f.control.prepare("INSERT INTO processes(session_id,pid) VALUES('another',4321)").run().changes).toBe(1);
  } finally { f.close(); }
});
it("normalizes a legacy payload above one MiB without decoding the whole history in JavaScript", () => {
  const f = fixture();
  try {
    addHistory(f.control, 10_000); f.source.prepare("DELETE FROM sessions").run();
    const legacy = f.source.prepare(`INSERT INTO process_cleanup_intents(session_id,user_id,identity_id,action,target_path,instances,ended_at,created_at)
      SELECT 'session',7,8,'delete',?,json_group_array(json(json_extract(instances,'$[0]'))),'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z' FROM process_cleanup_intents`).run(f.control.name);
    f.source.prepare("DELETE FROM process_cleanup_intents WHERE id<>?").run(legacy.lastInsertRowid);
    expect((f.source.prepare("SELECT length(CAST(instances AS BLOB)) AS bytes FROM process_cleanup_intents").get() as { bytes: number }).bytes).toBeGreaterThan(1024 * 1024);
    expect(normalizeProcessCleanupIntent(f.source, Number(legacy.lastInsertRowid))).toBe(10_001);
    expect(f.source.prepare("SELECT min(json_array_length(instances)) AS minimum,max(json_array_length(instances)) AS maximum,count(*) AS n FROM process_cleanup_intents").get()).toEqual({ minimum: 1, maximum: 1, n: 10_001 });
    expect(f.source.prepare("SELECT DISTINCT session_id,user_id,identity_id,action,target_path,ended_at,created_at FROM process_cleanup_intents").get()).toEqual({ session_id: "session", user_id: 7, identity_id: 8, action: "delete", target_path: f.control.name, ended_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z" });
    expect(drainProcessCleanup(f.source, f.control, 16)).toBe(16);
    expect(f.control.prepare("SELECT count(*) AS n FROM processes").get()).toEqual({ n: 9985 });
  } finally { f.close(); }
});
it("retains the original aggregate if normalization is interrupted by a SQL failure", () => {
  const f = fixture();
  try {
    f.source.prepare("UPDATE sessions SET active=0").run();
    f.source.prepare("UPDATE process_cleanup_intents SET instances=json_insert(instances,'$[#]',json_extract(instances,'$[0]'))").run();
    const before = f.source.prepare("SELECT * FROM process_cleanup_intents").all();
    f.source.exec("CREATE TEMP TRIGGER reject_normalization BEFORE INSERT ON process_cleanup_intents BEGIN SELECT RAISE(ABORT,'normalization refused'); END");
    expect(() => normalizeProcessCleanupIntent(f.source, 1)).toThrow("normalization refused");
    expect(f.source.prepare("SELECT * FROM process_cleanup_intents").all()).toEqual(before);
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: null });
  } finally { f.close(); }
});
