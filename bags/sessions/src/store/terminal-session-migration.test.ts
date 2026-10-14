import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import { MIGRATIONS } from "./sessions-db.js";

it("repairs historical status-only closure and closes its attached process history", () => {
  const database = new BetterSqlite3(":memory:");
  try {
    const index = MIGRATIONS.findIndex(migration => migration.name === "020_terminal_session_closure.sql");
    expect(index).toBeGreaterThan(0);
    migrateStore(database, MIGRATIONS.slice(0, index), "terminal-upgrade-fixture");
    database.exec(`INSERT INTO sessions(id,status,active,state,metadata,completed_at)
      VALUES('legacy','cancelled',1,'open','{"name":"keep"}','2026-10-01T00:00:00Z'),
            ('live','running',1,'open','{}',NULL);
      INSERT INTO processes(session_id,pid,pid_started_at,hostname) VALUES('legacy',1234,5678,'host');`);
    const live = database.prepare("SELECT * FROM sessions WHERE id='live'").get();
    migrateStore(database, MIGRATIONS, "terminal-upgrade-fixture");
    expect(database.prepare("SELECT status,active,state,ended_at,metadata FROM sessions WHERE id='legacy'").get()).toEqual({ status: "cancelled", active: 0, state: "closed", ended_at: "2026-10-01T00:00:00Z", metadata: '{"name":"keep","end_reason":"terminal-status-repair"}' });
    expect(database.prepare("SELECT ended_at FROM processes WHERE session_id='legacy'").get()).toEqual({ ended_at: "2026-10-01T00:00:00Z" });
    expect(database.prepare("SELECT * FROM sessions WHERE id='live'").get()).toEqual(live);
    expect(() => database.exec("UPDATE sessions SET status='failed' WHERE id='live'")).toThrow(/terminal session must be closed/);
    database.exec("UPDATE sessions SET state='archived' WHERE id='legacy'");
    database.exec("UPDATE sessions SET summary='archived summary' WHERE id='legacy'");
    expect(database.prepare("SELECT state,summary FROM sessions WHERE id='legacy'").get()).toEqual({ state: "archived", summary: "archived summary" });
    expect(() => database.exec("UPDATE sessions SET state='open' WHERE id='legacy'")).toThrow(/terminal session must be closed/);
    expect(() => database.exec("UPDATE sessions SET active=1 WHERE id='legacy'")).toThrow(/terminal session must be closed/);
    expect(() => database.exec("UPDATE sessions SET ended_at=NULL WHERE id='legacy'")).toThrow(/terminal session must be closed/);
  } finally { database.close(); }
});
