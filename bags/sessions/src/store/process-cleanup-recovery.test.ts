import { execFileSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { storePath, migrateStore } from "@barry-rocks/sdk/stores";

import { MIGRATIONS } from "./sessions-db.js";
import { installProcessCleanup } from "./process-cleanup.js";
import { createProcessCleanupRecovery, startProcessCleanupRecovery } from "./process-cleanup-recovery.js";

const cleanups: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(override?: string) {
  const root = override ?? mkdtempSync(join(tmpdir(), "barry-cleanup-recovery-"));
  const path = storePath({ node: "local", bag: "sessions", store: "catalog" }, "node", root);
  mkdirSync(dirname(path), { recursive: true });
  const control = new BetterSqlite3(path); control.pragma("journal_mode=WAL"); control.pragma("busy_timeout=5000");
  migrateStore(control, MIGRATIONS, "recovery-control");
  cleanups.push(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  const partition = (identity: string, count = 1) => {
    const path = storePath({ node: "local", identity, bag: "sessions", store: "sessions" }, "identity", root);
    mkdirSync(dirname(path), { recursive: true });
    const source = new BetterSqlite3(path); source.pragma("journal_mode=WAL"); migrateStore(source, MIGRATIONS, "recovery-source");
    installProcessCleanup(source, () => control);
    for (let index = 0; index < count; index++) {
      const id = `${identity}-${index}`;
      source.prepare("INSERT INTO sessions(id,active,metadata) VALUES(?,1,'{}')").run(id);
      control.prepare("INSERT INTO processes(session_id,pid) VALUES(?,1234)").run(id);
      source.prepare("UPDATE sessions SET active=0 WHERE id=?").run(id);
    }
    source.close(); return path;
  };
  const recovery = (options = {}) => {
    const worker = createProcessCleanupRecovery({ control, root: () => root, ...options });
    cleanups.push(worker.stop); return worker;
  };
  return { root, control, partition, recovery };
}
function pending(path: string) {
  const db = new BetterSqlite3(path, { readonly: true });
  try { return (db.prepare("SELECT count(*) AS n FROM process_cleanup_intents").get() as { n: number }).n; }
  finally { db.close(); }
}
it("replays committed intents in a partition the service has never opened", () => {
  const f = fixture(), path = f.partition("alice"), worker = f.recovery();
  expect(worker.poll()).toMatchObject({ stores: 1, applied: 1, failed: 0 });
  expect(pending(path)).toBe(0);
  expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: expect.any(String) });
});
it("advances bounded batches across polls without losing the rest of a backlog", () => {
  const f = fixture(), path = f.partition("alice", 5), worker = f.recovery({ intentsPerStore: 1, storesPerPoll: 1 });
  let applied = 0;
  for (let index = 0; index < 20; index++) { const report = worker.poll(); expect(report.applied).toBeLessThanOrEqual(1); applied += report.applied; }
  expect(applied).toBe(5); expect(pending(path)).toBe(0);
});
it("retains a poisoned intent and processes healthy work after it and in another partition", () => {
  const f = fixture(), bad = f.partition("alice", 2), other = f.partition("bob");
  const db = new BetterSqlite3(bad); db.prepare("UPDATE process_cleanup_intents SET instances='[{}]' WHERE id=1").run(); db.close();
  const report = f.recovery().poll();
  expect(report).toMatchObject({ stores: 2, applied: 2, failed: 1 });
  expect(pending(bad)).toBe(1); expect(pending(other)).toBe(0);
  expect(f.control.prepare("SELECT ended_at FROM processes WHERE session_id='alice-0'").get()).toEqual({ ended_at: null });
});
it("does not create missing stores or directories", () => {
  const f = fixture(), worker = f.recovery();
  expect(worker.poll()).toMatchObject({ applied: 0, failed: 0 });
  expect(existsSync(join(f.root, "identities"))).toBe(false);
  mkdirSync(join(f.root, "identities", "empty"), { recursive: true });
  expect(worker.poll()).toMatchObject({ stores: 0, failed: 0 });
  expect(existsSync(join(f.root, "identities", "empty", "sessions"))).toBe(false);
});
it("refuses sources whose bag directory points outside the active generation", () => {
  const f = fixture(), outside = fixture(), path = outside.partition("outside");
  mkdirSync(join(f.root, "identities", "alias"), { recursive: true });
  symlinkSync(dirname(path), join(f.root, "identities", "alias", "sessions"), "dir");
  expect(f.recovery().poll()).toMatchObject({ stores: 0, applied: 0, failed: 1 });
  expect(pending(path)).toBe(1);
});
it("stops applying when the active generation changes", () => {
  const f = fixture(), path = f.partition("alice"); let current = f.root;
  const worker = f.recovery({ root: () => current }); current = `${f.root}-new`;
  expect(worker.poll()).toMatchObject({ applied: 0, generationChanged: true }); expect(pending(path)).toBe(1);
});
it("bounds acknowledgement contention and safely retries after it clears", () => {
  const f = fixture(), path = f.partition("alice"), worker = f.recovery({ busyMs: 1 });
  const writer = new BetterSqlite3(path); writer.exec("BEGIN IMMEDIATE");
  try {
    expect(worker.poll()).toMatchObject({ applied: 0, failed: 1 });
    expect(pending(path)).toBe(1);
    expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: expect.any(String) });
  } finally { writer.exec("ROLLBACK"); writer.close(); }
  for (let index = 0; index < 6; index++) worker.poll();
  expect(pending(path)).toBe(0); expect(f.control.pragma("busy_timeout", { simple: true })).toBe(5000);
});
it("does not apply while the control store has an uncommitted transaction", () => {
  const f = fixture(), path = f.partition("alice"), worker = f.recovery();
  f.control.transaction(() => { expect(worker.poll()).toMatchObject({ applied: 0, stores: 0, deferred: true }); })();
  expect(pending(path)).toBe(1); expect(worker.poll().applied).toBe(1);
});
it("runs without a reporter and releases its interval and discovery handle on stop", () => {
  vi.useFakeTimers(); const f = fixture(), path = f.partition("alice");
  const worker = startProcessCleanupRecovery({ control: f.control, root: () => f.root, intervalMs: 1000 });
  cleanups.push(worker.stop); expect(pending(path)).toBe(0);
  const second = f.partition("bob"); vi.advanceTimersByTime(3000); expect(pending(second)).toBe(0);
  worker.stop(); const third = f.partition("carol"); vi.advanceTimersByTime(5000); expect(pending(third)).toBe(1);
});

it("runs recovery as the sessions API starts it", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-cleanup-entrypoint-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const stores = join(home, "app-support", "stores"), root = join(stores, "generations", "recovery-test");
  mkdirSync(stores, { recursive: true }); writeFileSync(join(stores, "active.json"), JSON.stringify({ id: "recovery-test" }));
  const f = fixture(root), path = f.partition("alice");
  const script = `
    process.env.BARRY_HOME=process.argv[1]; process.env.BARRY_SESSIONS_DB='';
    const { startCleanupRecovery } = await import('./api/src/cleanup-recovery.ts');
    startCleanupRecovery((detail) => process.stderr.write(detail));
    process.stdout.write('RECOVERY_READY'); process.exit(0);
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, home], { cwd: new URL("../..", import.meta.url), encoding: "utf8", stdio: "pipe", timeout: 15_000 });
  expect(output).toContain("RECOVERY_READY"); expect(pending(path)).toBe(0);
  expect(f.control.prepare("SELECT ended_at FROM processes").get()).toEqual({ ended_at: expect.any(String) });
});
it("keeps oversized work recorded while allowing later healthy intents", () => {
  const f = fixture(), path = f.partition("alice", 2);
  const db = new BetterSqlite3(path); db.prepare("UPDATE process_cleanup_intents SET instances=? WHERE id=1").run(JSON.stringify("x".repeat(1024 * 1024))); db.close();
  expect(f.recovery().poll()).toMatchObject({ applied: 1, oversized: 1 }); expect(pending(path)).toBe(1);
});
it("does not migrate a legacy partition without an intent table", () => {
  const f = fixture(), path = f.partition("alice");
  const db = new BetterSqlite3(path); db.exec("DROP TABLE process_cleanup_intents"); db.close();
  expect(f.recovery().poll()).toMatchObject({ applied: 0, unsupported: 1, failed: 0 });
  const observed = new BetterSqlite3(path, { readonly: true });
  try { expect(observed.prepare("SELECT 1 FROM sqlite_master WHERE name='process_cleanup_intents'").get()).toBeUndefined(); }
  finally { observed.close(); }
});

it("defers application when discovery consumes the monotonic work budget", () => {
  const f = fixture(), path = f.partition("alice");
  const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(2);
  const worker = f.recovery({ now: clock, budgetMs: 1 });
  expect(worker.poll()).toMatchObject({ applied: 0, deferred: true }); expect(pending(path)).toBe(1);
  clock.mockReturnValue(0); for (let index = 0; index < 4; index++) worker.poll();
  expect(pending(path)).toBe(0);
});

it("normalizes legacy aggregates then replays their individual instances in bounded polls", () => {
  const f = fixture(), path = f.partition("alice", 4);
  const db = new BetterSqlite3(path);
  const result = db.prepare(`INSERT INTO process_cleanup_intents(session_id,action,target_path,instances,ended_at)
    SELECT 'alice-0','close',?,json_group_array(json(json_extract(instances,'$[0]'))),'2026-10-01T00:00:00Z' FROM process_cleanup_intents`).run(f.control.name);
  db.prepare("DELETE FROM process_cleanup_intents WHERE id<>?").run(result.lastInsertRowid);
  // Preserve an invalid foreign binding as a separate failed intent, rather
  // than discarding it while valid bindings are normalized.
  db.close(); const worker = f.recovery({ intentsPerStore: 1 });
  expect(worker.poll()).toMatchObject({ applied: 0, normalized: 4 });
  let applied = 0;
  for (let index = 0; index < 20; index++) applied += worker.poll().applied;
  expect(applied).toBe(1); expect(pending(path)).toBe(3);
  expect(f.control.prepare("SELECT ended_at FROM processes WHERE session_id='alice-0'").get()).toEqual({ ended_at: "2026-10-01T00:00:00Z" });
  expect(f.control.prepare("SELECT count(*) AS n FROM processes WHERE session_id<>'alice-0' AND ended_at IS NULL").get()).toEqual({ n: 3 });
});
