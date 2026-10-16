import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { barryAppSupportDir, barryArchivesDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { CLI_TARGET } from "../target.js";
import { storeMigrateCommand } from "./store-migrate.js";
import { originalVerdicts, storeRemoveOriginalsCommand } from "./store-remove-originals.js";

vi.mock("@barry-rocks/mcp-bag", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/mcp-bag")>(),
  serviceRequest: async () => ({ services: [] }),
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>(); return { ...fs, unlinkSync: vi.fn(fs.unlinkSync) };
});
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
let home: string, reportPath: string;
let entries: { path: string; archive: string; checksum: string }[];
const old = new Date("2026-01-01T00:00:00Z"), archived = new Date("2026-01-01T00:01:00Z"), newer = new Date("2026-01-01T00:02:00Z");
const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), outputTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
function tty(value: boolean): void {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value });
}
function file(path: string, content = "original", time = old): string {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); utimesSync(path, time, time); return path;
}
function report(pretty = true, state = "active"): void {
  file(reportPath, JSON.stringify({ id: "m1", state, originals: entries, tables: [], archived: [] }, null, pretty ? 2 : undefined));
}
function original(bag: string, store = bag, options: { active?: boolean; identity?: boolean; path?: string } = {}): string {
  const path = file(options.path ?? join(barryAppSupportDir(), "data", bag, `${store}.db`));
  const archive = file(join(dirname(reportPath), `${bag}-${store}.db`), "archive", archived);
  entries.push({ path, archive, checksum: createHash("sha256").update("archive").digest("hex") });
  if (options.active !== false) file(join(barryStoresDir(), "generations/gen", options.identity ? "identities/owner" : "node", bag, `${store}.db`));
  report(); return path;
}
function snapshot(paths: string[]) { return paths.map(path => ({ path, bytes: readFileSync(path), mtime: lstatSync(path).mtimeMs })); }
function unchanged(saved: ReturnType<typeof snapshot>): void {
  for (const { path, bytes, mtime } of saved) { expect(readFileSync(path)).toEqual(bytes); expect(lstatSync(path).mtimeMs).toBe(mtime); }
}
function trashOrFallback(target: string, runner: (file: string, args: string[]) => unknown = childProcess.execFileSync): void {
  try {
    runner("trash", [target]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const trashDir = join(barryAppSupportDir(), "trash");
      mkdirSync(trashDir, { recursive: true });
      try {
        renameSync(target, join(trashDir, basename(target)));
      } catch {
        rmSync(target, { recursive: true, force: true });
      }
    } else {
      throw error;
    }
  }
}
function output(): string { return vi.mocked(console.log).mock.calls.map(args => args.join(" ")).join("\n"); }
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "barry-remove-originals-"));
  vi.stubEnv("BARRY_HOME", home); vi.stubEnv("BARRY_IDENTITIES_DB", join(home, "identities.db"));
  vi.spyOn(console, "log").mockImplementation(() => {}); tty(false);
  entries = []; reportPath = join(barryArchivesDir(), "store-migrations/m1/report.json");
  file(join(barryStoresDir(), "active.json"), JSON.stringify({ id: "gen" }));
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[CLI_TARGET];
  for (const [stream, descriptor] of [[process.stdin, inputTTY], [process.stdout, outputTTY]] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor); else Reflect.deleteProperty(stream, "isTTY");
  }
  vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.mocked(unlinkSync).mockReset(); trashOrFallback(home);
});

it("removes real migration originals while preserving all archives and report bytes and mtimes", async () => {
  unlinkSync(join(barryStoresDir(), "active.json"));
  const paths = [join(barryAppSupportDir(), "data/logs/logs.db"), join(barryAppSupportDir(), "data/locks/locks.db"), join(barryAppSupportDir(), "config.db")];
  for (const path of paths) {
    mkdirSync(dirname(path), { recursive: true }); const db = new DatabaseSync(path);
    db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY); INSERT INTO records VALUES(1)"); db.close(); utimesSync(path, old, old);
  }
  await storeMigrateCommand({ servicesStopped: true, id: "m1" });
  const migration = JSON.parse(readFileSync(reportPath, "utf8")) as { originals: { archive: string }[] };
  const saved = snapshot([reportPath, ...migration.originals.map(entry => entry.archive), paths[2]]);
  await storeRemoveOriginalsCommand({ yes: true });
  expect(existsSync(paths[0])).toBe(false); expect(existsSync(paths[1])).toBe(false);
  expect(output()).toContain("config.db: not under data/"); unchanged(saved);
});
it("removes companions despite newer shm, preserving unlisted files and folders", async () => {
  const path = original("logs");
  for (const suffix of ["-wal", "-shm", "-journal"]) file(path + suffix, suffix, suffix === "-shm" ? newer : old);
  const saved = snapshot([file(join(dirname(path), "bookkeeping.lock")), file(join(dirname(path), "other.db"))]);
  await storeRemoveOriginalsCommand({ yes: true });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(existsSync(path + suffix)).toBe(false);
  expect(existsSync(dirname(path))).toBe(true); unchanged(saved);
});
it("passes the releases gate with only the eligible original removed", async () => {
  const config = original("core", "config", { path: join(barryAppSupportDir(), "config.db") });
  const peers = original("nodes", "peers", { path: join(barryStoresDir(), "node/nodes/peers.db") });
  const supervisor = original("supervisor", "supervisor", { active: false }), plans = original("plans", "plans", { active: false });
  const main = original("memory"); utimesSync(main, newer, newer);
  const todos = original("todos", "todos", { identity: true }), wal = file(todos + "-wal", "new writes", newer);
  const eligible = original("logs"), saved = snapshot([config, peers, supervisor, plans, main, todos, wal]);
  await storeRemoveOriginalsCommand({ yes: true }); expect(existsSync(eligible)).toBe(false); unchanged(saved);
  expect(output()).toContain("Remove (1 originals");
  for (const path of ["config.db", "stores/node/nodes/peers.db"]) expect(output()).toContain(`${path}: not under data/`);
  for (const bag of ["supervisor", "plans"]) expect(output()).toContain(`${bag}.db: not in the active generation`);
  expect(output()).toContain(`memory.db: written since the migration: data/memory/memory.db at ${newer.toISOString()}`);
  expect(output()).toContain(`todos.db: written since the migration: data/todos/todos.db-wal at ${newer.toISOString()}`);
});
it("accepts a store present only in an identity partition", async () => {
  const path = original("events", "events", { identity: true }); await storeRemoveOriginalsCommand({ yes: true }); expect(existsSync(path)).toBe(false);
});
it("keeps an original absent from the active generation", async () => {
  const path = original("logs", "logs", { active: false }), saved = snapshot([path]);
  await storeRemoveOriginalsCommand({ yes: true }); unchanged(saved); expect(output()).toContain("not in the active generation");
});
it("keeps originals with missing or mismatched archived copies", async () => {
  const missing = original("logs"), mismatch = original("locks"); unlinkSync(entries[0].archive); writeFileSync(entries[1].archive, "changed");
  const saved = snapshot([missing, mismatch]); await storeRemoveOriginalsCommand({ yes: true }); unchanged(saved);
  expect(output()).toContain("archived copy missing"); expect(output()).toContain("archived copy does not match the report");
});
it("finds a copy beside a moved report", async () => {
  const path = original("logs"), moved = join(home, "moved"); renameSync(dirname(reportPath), moved);
  const movedReport = join(moved, "report.json"), saved = snapshot([movedReport, join(moved, "logs-logs.db")]);
  await storeRemoveOriginalsCommand({ report: movedReport, yes: true }); expect(existsSync(path)).toBe(false); unchanged(saved);
});
it("keeps a symlink original and its target", async () => {
  const path = original("logs"), target = file(join(home, "target.db")); unlinkSync(path); symlinkSync(target, path);
  const saved = snapshot([target]); await storeRemoveOriginalsCommand({ yes: true }); unchanged(saved);
  expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(output()).toContain("not a regular file");
});
it("lists already gone originals and succeeds", async () => {
  const path = original("logs"); unlinkSync(path); await storeRemoveOriginalsCommand({ yes: true });
  expect(output()).toContain("Already gone:"); expect(output()).toContain("Nothing to remove.");
});
it("refuses staged reports without changes", async () => {
  const path = original("logs"); report(true, "staged"); const saved = snapshot([path, reportPath]);
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow("never activated (state: staged)"); unchanged(saved);
});
it("refuses homes without an active generation", async () => {
  const path = original("logs"); unlinkSync(join(barryStoresDir(), "active.json")); const saved = snapshot([path]);
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow("no active store generation"); unchanged(saved);
});
it("propagates an interrupted switch's recovery refusal", async () => {
  const path = original("logs"), saved = snapshot([path]);
  file(join(barryStoresDir(), "activation.json"), JSON.stringify({ format: 1, root: barryStoresDir(), id: "gen", previousId: "before", state: "sealed", previousChecksum: "a".repeat(64), nextChecksum: "b".repeat(64) }));
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow("requires recovery"); unchanged(saved);
});
it("requires an explicit report when multiple reports exist", async () => {
  const path = original("logs"), second = file(join(barryArchivesDir(), "store-migrations/m2/report.json"), readFileSync(reportPath, "utf8")), saved = snapshot([path]);
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow("pass --report <path>");
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow(second); unchanged(saved);
  await storeRemoveOriginalsCommand({ report: reportPath, yes: true }); expect(existsSync(path)).toBe(false);
});
it("refuses identity target before reading reports", async () => {
  const path = original("logs"), saved = snapshot([path]);
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = { kind: "identity", name: "bux", binding: { id: 1, home: null } };
  await expect(storeRemoveOriginalsCommand({ report: "/missing", yes: true })).rejects.toThrow("from the instance"); unchanged(saved);
  expect(() => originalVerdicts(reportPath)).toThrow("from the instance");
});
it("prints verdicts before refusing unattended removal", async () => {
  const path = original("logs"), saved = snapshot([path]); await expect(storeRemoveOriginalsCommand()).rejects.toThrow("Unattended removal requires --yes");
  expect(output()).toContain("Remove (1 originals"); unchanged(saved);
});
it.each([false, true])("dry-run changes nothing without a terminal (--yes %s)", async yes => {
  const path = original("logs"), saved = snapshot([path, reportPath, entries[0].archive]); await storeRemoveOriginalsCommand({ dryRun: true, yes }); unchanged(saved);
  expect(output()).toContain("Remove (1 originals");
});
it.each([false, true])("honors interactive confirmation %s", async answer => {
  const path = original("logs"); tty(true); const confirm = vi.fn(async () => answer), saved = snapshot([path]);
  await storeRemoveOriginalsCommand({ confirm }); expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Remove 1 pre-migration originals"));
  if (answer) expect(existsSync(path)).toBe(false); else { unchanged(saved); expect(output()).toContain("No changes made."); }
});
it("reports no migration as a successful no-op", async () => {
  await storeRemoveOriginalsCommand({ yes: true }); expect(output()).toContain("No store migration report under"); expect(output()).toContain("nothing to remove");
});
it.each(["-wal", "-journal", ""])("keeps files written during confirmation (%s)", async suffix => {
  const path = original("logs"); tty(true);
  await storeRemoveOriginalsCommand({ confirm: async () => { file(path + suffix, "new writes", newer); return true; } });
  expect(existsSync(path)).toBe(true); expect(readFileSync(path + suffix, "utf8")).toBe("new writes"); expect(output()).toContain("Removed 0 originals");
});
it("keeps an original written while its archived copy was being filled", async ({ skip }) => {
  const path = original("logs"), archive = entries[0].archive, created = lstatSync(archive).birthtimeMs;
  if (!created) skip("this filesystem records no creation time");
  const during = new Date(created + 3_600_000), filled = new Date(created + 7_200_000);
  utimesSync(archive, filled, filled); const saved = snapshot([path, file(path + "-wal", "write during the copy", during)]);
  await storeRemoveOriginalsCommand({ yes: true }); unchanged(saved);
  expect(output()).toContain(`written since the migration: data/logs/logs.db-wal at ${during.toISOString()}`);
});
it.each(["gone", "symlink"])("rechecks the original after confirmation (%s)", async change => {
  const path = original("logs"), target = file(join(home, "target")); tty(true);
  await storeRemoveOriginalsCommand({ confirm: async () => { unlinkSync(path); if (change === "symlink") symlinkSync(target, path); return true; } });
  expect(readFileSync(target, "utf8")).toBe("original"); expect(output()).toContain("Removed 0 originals");
});
it("parses only indented report heads and falls back for compact reports", () => {
  original("logs"); const pretty = originalVerdicts(reportPath).originals, head = readFileSync(reportPath, "utf8").split('\n  "tables": ')[0];
  writeFileSync(reportPath, head + '\n  "tables": [],\n  "archived": [invalid rows deliberately omitted');
  expect(originalVerdicts(reportPath).originals).toEqual(pretty); report(false); expect(originalVerdicts(reportPath).originals).toEqual(pretty);
});
it.each([
  { id: "m1", state: "active" }, { id: 1, state: "active", originals: [] }, { id: "m1", originals: [] },
  { id: "m1", state: "active", originals: [{ path: "x", archive: "x" }] },
])("refuses malformed reports (%j)", async value => {
  const path = original("logs"), saved = snapshot([path]); writeFileSync(reportPath, JSON.stringify(value));
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow("Invalid store migration report"); unchanged(saved);
});

it("refuses originals reached through a bag directory symlink outside data", async () => {
  const path = original("logs"), moved = join(home, "outside"); renameSync(dirname(path), moved); symlinkSync(moved, dirname(path));
  const saved = snapshot([join(moved, "logs.db")]); await storeRemoveOriginalsCommand({ yes: true }); unchanged(saved);
  expect(output()).toContain("logs.db: not under data/"); expect(output()).toContain("Nothing to remove.");
});
it("preserves an archived copy even if a report lists it as its own original", async () => {
  const path = original("logs"); entries[0].archive = path; entries[0].checksum = createHash("sha256").update(readFileSync(path)).digest("hex"); report();
  const saved = snapshot([path, reportPath]); await storeRemoveOriginalsCommand({ yes: true }); unchanged(saved);
  expect(output()).toContain("is an archived copy");
});

it("rechecks a bag directory replaced with an outside symlink during confirmation", async () => {
  const path = original("logs"), outside = join(home, "outside"), target = file(join(outside, "logs.db")), saved = snapshot([target]); tty(true);
  await storeRemoveOriginalsCommand({ confirm: async () => {
    renameSync(dirname(path), join(home, "old-logs")); symlinkSync(outside, dirname(path)); return true;
  } });
  unchanged(saved); expect(output()).toContain("Removed 0 originals");
});

it("removes an original whose -wal SQLite deletes between the lstat and the unlink", async () => {
  const path = original("logs"); for (const suffix of ["-wal", "-shm"]) file(path + suffix, suffix);
  vi.mocked(unlinkSync).mockImplementation(target => { if (target === path + "-wal") fs.unlinkSync(target); fs.unlinkSync(target); });
  await storeRemoveOriginalsCommand({ yes: true });
  for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(path + suffix)).toBe(false);
  expect(output()).toContain("Removed 1 originals");
});
it("reports a partial removal after attempting every original", async () => {
  const logs = original("logs"), locks = original("locks"), events = original("events"); file(logs + "-wal", "wal");
  vi.mocked(unlinkSync).mockImplementation(target => {
    if (target === logs + "-wal" || target === locks) throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(target)}'`), { code: "EACCES" });
    fs.unlinkSync(target);
  });
  await expect(storeRemoveOriginalsCommand({ yes: true })).rejects.toThrow(/Removal incomplete[^]*data\/logs\/logs\.db-wal[^]*data\/locks\/locks\.db/);
  expect(existsSync(logs)).toBe(false); expect(existsSync(logs + "-wal")).toBe(true); expect(existsSync(locks)).toBe(true); expect(existsSync(events)).toBe(false);
  expect(output()).toContain("Removed data/logs/logs.db but not data/logs/logs.db-wal (EACCES");
  expect(output()).toContain("Could not remove data/locks/locks.db: EACCES"); expect(output()).toContain("Removed 2 originals");
});
it.each([false, true])("lists the companions an already gone original left behind (gone during confirmation %s)", async during => {
  const path = original("logs"); file(path + "-wal", "wal"); file(path + "-shm", "shm"); tty(true);
  if (!during) unlinkSync(path);
  await storeRemoveOriginalsCommand({ confirm: async () => { unlinkSync(path); return true; } });
  const left = "(left behind: data/logs/logs.db-wal, data/logs/logs.db-shm)";
  expect(output()).toContain(during ? `Kept data/logs/logs.db: already gone ${left}` : `  data/logs/logs.db ${left}`);
  expect(existsSync(path + "-wal")).toBe(true); expect(existsSync(path + "-shm")).toBe(true);
});
it.each([
  { change: "replaced", swap: (path: string) => renameSync(file(path + ".restored", "restored"), path), reason: "replaced since it was checked" },
  { change: "resized", swap: (path: string) => { file(path, "original, then more"); }, reason: "changed size since it was checked (8 to 19 bytes)" },
])("keeps a main file $change during confirmation even with an older mtime", async ({ swap, reason }) => {
  const path = original("logs"); tty(true);
  await storeRemoveOriginalsCommand({ confirm: async () => { swap(path); return true; } });
  expect(existsSync(path)).toBe(true); expect(output()).toContain(`Kept data/logs/logs.db: ${reason}`); expect(output()).toContain("Removed 0 originals");
});
it("falls back safely when trash binary is absent", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "barry-absent-trash-"));
  writeFileSync(join(scratchDir, "dummy.txt"), "content");
  const throwingRunner = () => {
    const err = new Error("spawnSync trash ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  };
  try {
    trashOrFallback(scratchDir, throwingRunner);
    expect(existsSync(scratchDir)).toBe(false);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
