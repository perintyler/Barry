import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import MIGRATIONS from "../../generated/sessions-migrations.js";

it("upgrades an existing Sessions history and retains execution authority immutably before destination creation", () => {
  const db = new Database(":memory:");
  try {
    migrateStore(db, MIGRATIONS.slice(0, 23), "workflow-authority-fixture");
    db.prepare("INSERT INTO sessions(id,metadata) VALUES('old','{\"source\":\"ordinary\"}')").run();
    migrateStore(db, MIGRATIONS, "workflow-authority-fixture");
    const insert = db.prepare("INSERT INTO session_workflow_execution_authorities VALUES(?,?,?)");
    insert.run("future-destination", "a".repeat(64), '{"version":1,"intent":"original"}');
    expect(db.prepare("SELECT metadata FROM sessions WHERE id='old'").get()).toEqual({ metadata: '{"source":"ordinary"}' });
    expect(db.prepare("SELECT count(*) AS count FROM session_workflow_destinations").get()).toEqual({ count: 0 });
    expect(() => db.prepare("UPDATE session_workflow_execution_authorities SET authority_json='{}'").run()).toThrow("immutable");
    expect(() => db.prepare("DELETE FROM session_workflow_execution_authorities").run()).toThrow("immutable");
    expect(() => insert.run("future-destination", "b".repeat(64), "{}")).toThrow(/UNIQUE/);
    expect(() => insert.run("corrupt", "a".repeat(64), "not json")).toThrow(/CHECK/);
    expect(() => insert.run("bad-hash", "invalid", "{}")).toThrow(/CHECK/);
    migrateStore(db, MIGRATIONS, "workflow-authority-fixture");
    expect(db.prepare("SELECT authority_json FROM session_workflow_execution_authorities").get()).toEqual({ authority_json: '{"version":1,"intent":"original"}' });
  } finally { db.close(); }
});
