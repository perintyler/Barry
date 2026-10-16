import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { captureStores, compareStores, isExpectedSystemDrift } from "../scripts/verify-release-upgrade.js";
const roots: string[] = [];
function fixture(identities = false) {
  const root = mkdtempSync(join(tmpdir(), "release-upgrade-evidence-")); roots.push(root);
  const directory = join(root, "node", identities ? "identities" : "fixture"); mkdirSync(directory, { recursive: true });
  const path = join(directory, identities ? "identities.db" : "fixture.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO entries VALUES(1,'retained')"); db.close();
  return { root, path };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("allows only specifically declared system services in aggregate doctor drift", () => {
  const system = ["service:vault.api"];
  expect(isExpectedSystemDrift("unprepared: vault.api; unregistered: vault.api", system)).toBe(true);
  expect(isExpectedSystemDrift("unprepared: ; unregistered: vault.api", system)).toBe(true);
  expect(isExpectedSystemDrift("unprepared: owner; unregistered: vault.api", system)).toBe(false);
  expect(isExpectedSystemDrift("unprepared: ; unregistered: ", system)).toBe(false);
  expect(isExpectedSystemDrift("permission denied", system)).toBe(false);
  const failures = [{ name: "service:vault.api", detail: "not registered" }];
  expect(isExpectedSystemDrift("vault.api: not registered", system, failures)).toBe(true);
  expect(isExpectedSystemDrift("owner: not registered; vault.api: not registered", system, failures)).toBe(false);
  expect(isExpectedSystemDrift("vault.api: permission denied", system, failures)).toBe(false);
  expect(isExpectedSystemDrift("vault.api: not registered; owner: not registered", system, [...failures, { name: "service:owner", detail: "not registered" }])).toBe(false);
});
it("records real SQLite digests/row counts and rejects changed retained data", () => {
  const { root, path } = fixture(), before = captureStores(root, true, `${root}-snapshots`);
  roots.push(`${root}-snapshots`);
  expect(Object.values(before)[0].fixtureRows).toBe(16);
  expect(() => compareStores(before, captureStores(root), true)).not.toThrow();
  const db = new DatabaseSync(path); db.exec("UPDATE entries SET value='changed'"); db.close();
  expect(() => compareStores(before, captureStores(root), true)).toThrow("logical data changed");
});
it("permits schema migrations only while the retained fixture is preserved", () => {
  const { root, path } = fixture(), before = captureStores(root, true);
  const db = new DatabaseSync(path); db.exec("ALTER TABLE entries ADD COLUMN updated TEXT;CREATE TABLE migrated(id INTEGER)"); db.close();
  expect(() => compareStores(before, captureStores(root), false)).not.toThrow();
  const changed = new DatabaseSync(path); changed.exec("DELETE FROM release_verification_fixture WHERE id=0"); changed.close();
  expect(() => compareStores(before, captureStores(root), false)).toThrow("fixture row count changed");
});
it("rejects migration loss of original application rows or tables with an intact fixture", () => {
  const { root, path } = fixture(), before = captureStores(root, true);
  const db = new DatabaseSync(path);
  db.exec("ALTER TABLE entries ADD COLUMN updated TEXT;DELETE FROM entries"); db.close();
  expect(() => compareStores(before, captureStores(root), false)).toThrow("retained table lost rows after migration: entries");
  const missing = new DatabaseSync(path); missing.exec("DROP TABLE entries"); missing.close();
  expect(() => compareStores(before, captureStores(root), false)).toThrow("retained table disappeared after migration: entries");
});
it("allows retired traits and bounds tables in identities.db to be dropped when migrations advance", () => {
  const { root, path } = fixture(true);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE traits(id INTEGER PRIMARY KEY);CREATE TABLE bounds(id INTEGER PRIMARY KEY);INSERT INTO traits VALUES(1);INSERT INTO bounds VALUES(1)");
  db.close();
  const before = captureStores(root, true);
  const migrated = new DatabaseSync(path);
  migrated.exec("DROP TABLE traits;DROP TABLE bounds");
  migrated.close();
  const after = captureStores(root);
  expect(() => compareStores(before, after, false)).not.toThrow();
  expect(() => compareStores(before, after, true)).toThrow("logical data changed");
});
it("rejects dropping tables in unrelated stores even when named traits or bounds", () => {
  const { root, path } = fixture(), db = new DatabaseSync(path);
  db.exec("CREATE TABLE bounds(id INTEGER PRIMARY KEY);INSERT INTO bounds VALUES(1)"); db.close();
  const before = captureStores(root, true), changed = new DatabaseSync(path);
  changed.exec("DROP TABLE bounds"); changed.close();
  expect(() => compareStores(before, captureStores(root), false)).toThrow("retained table disappeared after migration: bounds");
});
