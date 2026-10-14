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
it("permits catalog migrations only while the retained fixture is preserved", () => {
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
it("normalizes only nullable trait metadata representation and preserves real values", () => {
  const { root, path } = fixture(true);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE traits(id INTEGER PRIMARY KEY,metadata TEXT)");
  db.prepare("INSERT INTO traits VALUES(1,?)").run(JSON.stringify({ boundNames: [], includes: [], harnessTraits: null, nativeTools: null })); db.close();
  const before = captureStores(root, true), changed = new DatabaseSync(path);
  changed.prepare("UPDATE traits SET metadata=?").run(JSON.stringify({ boundNames: [], includes: [] })); changed.close();
  const normalized = captureStores(root);
  expect(Object.values(normalized)[0].tables.traits.rawSha256).not.toBe(Object.values(before)[0].tables.traits.rawSha256);
  expect(() => compareStores(before, normalized, true)).not.toThrow();
  const substantive = new DatabaseSync(path);
  substantive.prepare("UPDATE traits SET metadata=?").run(JSON.stringify({ boundNames: [], includes: [], nativeTools: { shell: ["read"] } })); substantive.close();
  expect(() => compareStores(before, captureStores(root), true)).toThrow("logical data changed");
  const missing = new DatabaseSync(path);
  missing.prepare("UPDATE traits SET metadata=?").run(JSON.stringify({ boundNames: [] })); missing.close();
  expect(() => compareStores(before, captureStores(root), true)).toThrow("logical data changed");
  const removed = new DatabaseSync(path); removed.exec("DELETE FROM traits"); removed.close();
  expect(() => compareStores(before, captureStores(root), true)).toThrow("logical data changed");
});
it("compares similarly named traits in unrelated stores without normalization", () => {
  const { root, path } = fixture(), db = new DatabaseSync(path);
  db.exec("CREATE TABLE traits(id INTEGER PRIMARY KEY,metadata TEXT)");
  db.prepare("INSERT INTO traits VALUES(1,?)").run(JSON.stringify({ nativeTools: null })); db.close();
  const before = captureStores(root, true), changed = new DatabaseSync(path);
  changed.prepare("UPDATE traits SET metadata=?").run("{}"); changed.close();
  expect(() => compareStores(before, captureStores(root), true)).toThrow("logical data changed");
});
