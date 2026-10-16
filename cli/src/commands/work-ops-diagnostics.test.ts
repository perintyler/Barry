/** Real SQLite bytes; these do not qualify cross-store/native recovery acceptance. */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { diagnoseWorkOps } from "./work-ops-diagnostics.js";
import { hashOpsFile } from "./work-ops.js";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-ops-sqlite-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "source.db"), db = new Database(path); cleanup.push(() => { if (db.open) db.close(); });
  return { root, path, db };
}

it("refuses a live WAL even when the main-file hash matches; a sealed SQLite backup includes committed WAL rows", async () => {
  const f = fixture(); f.db.pragma("journal_mode=WAL"); f.db.pragma("wal_autocheckpoint=0");
  f.db.exec("CREATE TABLE workflow_runtime_generations(state TEXT); INSERT INTO workflow_runtime_generations VALUES('qualified')");
  expect(existsSync(f.path + "-wal")).toBe(true);
  expect(() => diagnoseWorkOps(f.path, hashOpsFile(f.path).sha256, "runtime")).toThrow("SealedCopyRequired");
  const copy = join(f.root, "backup.db"); await f.db.backup(copy);
  const before = readFileSync(copy), hash = hashOpsFile(copy).sha256;
  expect(diagnoseWorkOps(copy, hash, "runtime").observations.generations).toEqual([{ state: "qualified", count: 1 }]);
  expect(readFileSync(copy)).toEqual(before); expect(existsSync(copy + "-wal")).toBe(false); expect(existsSync(copy + "-shm")).toBe(false);
});

it("reports held/unknown reservations for their owners without releasing them", () => {
  const f = fixture();
  f.db.exec(`PRAGMA user_version=1; CREATE TABLE resource_meta(broker TEXT); INSERT INTO resource_meta VALUES('endpoint-broker');
    CREATE TABLE resource_reservations(owner TEXT,resource TEXT,pool TEXT,state TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_micros INTEGER);
    INSERT INTO resource_reservations VALUES('owner','model','model','unknown',10,20,30),('owner','model','model','held',1,2,3);`);
  f.db.close(); const hash = hashOpsFile(f.path).sha256;
  const report = diagnoseWorkOps(f.path, hash, "broker");
  expect(report.observations.reservations).toEqual(expect.arrayContaining([expect.objectContaining({ state: "unknown", count: 1 }), expect.objectContaining({ state: "held", count: 1 })]));
  expect(hashOpsFile(f.path).sha256).toBe(hash); expect(report.liveHealth).toBe("unknown");
});

it("does not convert an unrelated or newer schema into a healthy empty journal", () => {
  const f = fixture(); f.db.exec("PRAGMA user_version=999; CREATE TABLE unrelated(id TEXT)"); f.db.close();
  const report = diagnoseWorkOps(f.path, hashOpsFile(f.path).sha256, "executor");
  expect(report.issues.length).toBeGreaterThan(0); expect(report.schemaVersion).toBe(999);
  expect(report.complete).toBe(false); expect(report.restoreReady).toBe(false);
});

it("refuses artifact/database corruption against a trusted digest", () => {
  const f = fixture(); f.db.exec("CREATE TABLE retained(id TEXT)"); f.db.close();
  const hash = hashOpsFile(f.path).sha256, copy = join(f.root, "tampered.db"); copyFileSync(f.path, copy); writeFileSync(copy, "lost database");
  expect(() => diagnoseWorkOps(copy, hash, "executor")).toThrow("SealedCopyHashMismatch");
});

it("inspects a sealed copy when the system temp directory has a symlinked parent", () => {
  const f = fixture(); f.db.exec("CREATE TABLE workflow_runtime_generations(state TEXT)"); f.db.close();
  const temporary = join(f.root, "temporary"), alias = join(f.root, "temporary-alias");
  mkdirSync(temporary); symlinkSync(temporary, alias); vi.stubEnv("TMPDIR", alias);
  expect(diagnoseWorkOps(f.path, hashOpsFile(f.path).sha256, "runtime").issues).toEqual([]);
  expect(readdirSync(temporary)).toEqual([]);
});
