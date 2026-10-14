import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openBagStore } from "./open-bag-store.js";
import { withStoreContext } from "./context.js";

const scratch = mkdtempSync(join(tmpdir(), "bag-store-"));
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const migrations = [{ name: "001_notes.sql", sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);" }];

describe("openBagStore", () => {
  it("opens with a busy timeout, WAL and foreign keys, then migrates", () => {
    const store = openBagStore({ file: "notes.db", migrations, path: () => join(scratch, "notes.db"), connect: (path) => new DatabaseSync(path) });
    const db = store.db();
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.prepare("INSERT INTO notes (body) VALUES (?)").run("hello");
    expect(store.db()).toBe(db);
    store.close();
  });

  it("keeps a handle per identity for an identity-scoped store", () => {
    const store = openBagStore({
      file: "notes.db", migrations, identityScoped: true, connect: (path) => new DatabaseSync(path),
      path: () => join(scratch, "per-identity.db"),
    });
    const scoped = withStoreContext({ identity: "bux" }, () => store.db());
    expect(scoped).not.toBe(store.db());
    expect(withStoreContext({ identity: "bux" }, () => store.db())).toBe(scoped);
    store.close();
  });
});
