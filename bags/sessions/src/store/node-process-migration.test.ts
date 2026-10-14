import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import { MIGRATIONS } from "./sessions-db.js";

it("preserves process history and its sequence while removing a cross-file foreign key", () => {
  const database = new BetterSqlite3(":memory:");
  database.pragma("foreign_keys=ON");
  try {
    const migrationIndex = MIGRATIONS.findIndex(migration => migration.name === "015_node_process_history.sql");
    expect(migrationIndex).toBeGreaterThan(0);
    migrateStore(database, MIGRATIONS.slice(0, migrationIndex), "process-upgrade-fixture");
    database.prepare("INSERT INTO sessions(id,metadata) VALUES('legacy','{}')").run();
    database.prepare("INSERT INTO processes(id,session_id,pid,liveness,liveness_reason,ended_at) VALUES(7,'legacy',1234,'alive','historical',null),(99999,'legacy',null,'dead','old','2026-01-01T00:00:00Z')").run();
    database.prepare("DELETE FROM processes WHERE id=99999").run();
    const history = database.prepare("SELECT * FROM processes").all();
    migrateStore(database, MIGRATIONS, "process-upgrade-fixture");
    expect(database.prepare("SELECT * FROM processes").all()).toEqual(history);
    expect(database.pragma("foreign_key_list(processes)")).toEqual([]);
    const added = database.prepare("INSERT INTO processes(session_id,pid) VALUES('partition-parent',2345)").run();
    expect(Number(added.lastInsertRowid)).toBe(100000);
    database.prepare("DELETE FROM sessions WHERE id='legacy'").run();
    expect(database.prepare("SELECT * FROM processes WHERE id=7").all()).toEqual([]);
    expect(database.prepare("SELECT session_id FROM processes WHERE id=?").get(added.lastInsertRowid)).toEqual({ session_id: "partition-parent" });
  } finally { database.close(); }
});

it("repairs preexisting local terminal process rows without changing Sessions or open history", () => {
  const database = new BetterSqlite3(":memory:");
  try {
    const index = MIGRATIONS.findIndex(migration => migration.name === "017_terminal_process_cleanup.sql");
    expect(index).toBeGreaterThan(0);
    migrateStore(database, MIGRATIONS.slice(0, index), "terminal-process-upgrade");
    database.prepare("INSERT INTO sessions(id,state,ended_at,metadata) VALUES('closed','closed','2026-10-01T00:00:00Z','{}'),('open','open',null,'{}')").run();
    database.prepare("INSERT INTO processes(id,session_id,pid,pid_started_at,hostname,command) VALUES(14,'closed',1234,5678,'host','original command'),(15,'open',1235,5679,'host','open command')").run();
    const sessions = database.prepare("SELECT * FROM sessions ORDER BY id").all();
    const open = database.prepare("SELECT * FROM processes WHERE id=15").get();
    migrateStore(database, MIGRATIONS, "terminal-process-upgrade");
    expect(database.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessions.map(row => ({ ...row as object, bounds: "[]" })));
    expect(database.prepare("SELECT * FROM processes WHERE id=15").get()).toEqual(open);
    expect(database.prepare("SELECT id,pid,pid_started_at,hostname,command,ended_at FROM processes WHERE id=14").get()).toEqual({ id: 14, pid: 1234, pid_started_at: 5678, hostname: "host", command: "original command", ended_at: "2026-10-01T00:00:00Z" });
  } finally { database.close(); }
});
