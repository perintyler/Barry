import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { barryStoresDir } from "../services/home.mjs";
import { activeStoreRoot } from "./migration.js";
import { storePath } from "./registry.js";
import { sessionIdentity } from "./paths.js";

const root = barryStoresDir();
afterEach(() => rmSync(root, { recursive: true, force: true }));
function activate() { mkdirSync(root, { recursive: true }); writeFileSync(join(root, "active.json"), JSON.stringify({ id: "fixture" })); }
function database(identity?: string) {
  const path = storePath({ node: "local", bag: "sessions", store: identity ? "sessions" : "catalog", identity }, identity ? "identity" : "node", activeStoreRoot());
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY)");
  return { db, path };
}
it("does not create a store tree before cutover or for a missing record", () => {
  expect(sessionIdentity("missing")).toBeUndefined(); expect(existsSync(root)).toBe(false);
  activate(); expect(sessionIdentity("missing")).toBeUndefined();
  expect(existsSync(join(activeStoreRoot(), "node"))).toBe(false);
});
it("resolves the committed WAL row while ignoring another connection's uncommitted row", () => {
  activate(); const { db } = database("alice");
  try {
    db.prepare("INSERT INTO sessions VALUES(?)").run("owned");
    expect(sessionIdentity("owned")).toBe("alice");
    db.exec("BEGIN IMMEDIATE; INSERT INTO sessions VALUES('pending')");
    expect(sessionIdentity("pending")).toBeUndefined();
    db.exec("COMMIT"); expect(sessionIdentity("pending")).toBe("alice");
  } finally { db.close(); }
});
for (const second of ["bob", undefined]) {
  it(`rejects a duplicate in ${second ?? "the node catalog"}`, () => {
    activate(); const alice = database("alice"), other = database(second);
    try {
      alice.db.exec("INSERT INTO sessions VALUES('duplicate')"); other.db.exec("INSERT INTO sessions VALUES('duplicate')");
      expect(() => sessionIdentity("duplicate")).toThrow("Ambiguous Session location");
    } finally { alice.db.close(); other.db.close(); }
  });
}
it("routes a unique catalog row without selecting a partition", () => {
  activate(); const { db } = database();
  try { db.exec("INSERT INTO sessions VALUES('catalog')"); expect(sessionIdentity("catalog")).toBeUndefined(); }
  finally { db.close(); }
});
it("does not change inspected database bytes or interpolate a supplied Session ID", () => {
  activate(); const { db, path } = database("alice"); db.exec("INSERT INTO sessions VALUES('owned')"); db.close();
  const before = readFileSync(path);
  expect(sessionIdentity("' OR 1=1 --")).toBeUndefined(); expect(sessionIdentity("owned")).toBe("alice");
  expect(readFileSync(path)).toEqual(before);
});
it("refuses an unreadable partition rather than granting the first matching row", () => {
  activate(); const alice = database("alice"), other = database("bob");
  alice.db.exec("INSERT INTO sessions VALUES('owned')"); alice.db.close(); other.db.close();
  writeFileSync(other.path, "corrupt database");
  expect(() => sessionIdentity("owned")).toThrow();
});

it("rejects a location result obtained after its monotonic deadline", () => {
  activate(); const { db } = database("alice"); db.exec("INSERT INTO sessions VALUES('owned')"); db.close();
  const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(5001);
  try { expect(() => sessionIdentity("owned")).toThrow("deadline exceeded"); }
  finally { clock.mockRestore(); }
});
