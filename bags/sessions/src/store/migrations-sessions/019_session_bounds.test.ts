import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import MIGRATIONS from "../../generated/sessions-migrations.js";

it.each([false, true])("adds bounds without dropping old restrictions (existing rows: %s)", seeded => {
  const db = new Database(":memory:");
  try {
    migrateStore(db, MIGRATIONS.slice(0, 18), "session-bounds-fixture");
    if (seeded) db.prepare("INSERT INTO sessions (id,bound_id,bound) VALUES ('old',7,'{\"deniedTools\":[\"Write\"]}')").run();
    migrateStore(db, MIGRATIONS, "session-bounds-fixture");
    db.prepare("INSERT INTO sessions (id) VALUES ('new')").run();
    expect(db.prepare("SELECT bounds FROM sessions WHERE id='new'").get()).toEqual({ bounds: "[]" });
    if (seeded) expect(db.prepare("SELECT bounds,bound_id,bound FROM sessions WHERE id='old'").get()).toEqual({ bounds: "[]", bound_id: 7, bound: '{"deniedTools":["Write"]}' });
  } finally { db.close(); }
});
