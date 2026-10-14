import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { directory, serviceFixture, sourceHome } from "./__tests__/db-home.js";
import { backupManagedStores, backedUpDataStores, sqliteIntegrity, UNMANAGED_DATA_DIR } from "./db-stores.js";
import { dbBackupCommand } from "./db.js";
import { dbRestoreCommand } from "./db-restore.js";

let failBag: string | null = null;
vi.mock("@barry-rocks/sdk/bags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/sdk/bags")>();
  return {
    ...actual,
    parseManifest: (path: string) => {
      if (failBag && (path.includes(failBag) || path.endsWith(`/${failBag}`))) {
        throw new Error(`broken manifest for ${failBag}`);
      }
      return actual.parseManifest(path);
    },
  };
});

afterEach(() => {
  failBag = null;
});

const noServices = { statuses: async () => [], isSystem: () => false, stop: async () => {}, start: async () => {} };

it("copies valid unmanaged data stores and skips non-stores, active generation stores, and backup directories", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const dataDir = join(barryAppSupportDir(), "data");

  // 1. the external plans store with WAL mode and an uncheckpointed row
  const plansDir = join(dataDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  const plansDb = new DatabaseSync(join(plansDir, "plans.db"));
  plansDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE plans(id TEXT); INSERT INTO plans VALUES('plan-1');");
  expect(existsSync(join(plansDir, "plans.db-wal"))).toBe(true);

  // 2. sessions/sessions.db (matches a store in the active generation)
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionsDb = new DatabaseSync(join(sessionsDir, "sessions.db"));
  sessionsDb.exec("CREATE TABLE s(x TEXT); INSERT INTO s VALUES('skip');");
  sessionsDb.close();

  // 3. an external plans metadata file (not a SQLite database)
  writeFileSync(join(plansDir, "coffee.json"), JSON.stringify({ coffee: true }));

  // 4. barry-devops/backups/database-x/config.db (contains backups/)
  const devopsDir = join(dataDir, "barry-devops", "backups", "database-x");
  mkdirSync(devopsDir, { recursive: true });
  const devopsDb = new DatabaseSync(join(devopsDir, "config.db"));
  devopsDb.exec("CREATE TABLE cfg(k TEXT);");
  devopsDb.close();

  // 5. old-backup/RESTORE.md (contains RESTORE.md)
  const oldBackupDir = join(dataDir, "old-backup");
  mkdirSync(oldBackupDir, { recursive: true });
  writeFileSync(join(oldBackupDir, "RESTORE.md"), "# Old Backup");
  const oldDb = new DatabaseSync(join(oldBackupDir, "store.db"));
  oldDb.exec("CREATE TABLE t(x);");
  oldDb.close();

  const backup = join(directory("barry-data-backup-"), "backup");
  try {
    await dbBackupCommand(backup, { vault: false });
  } finally {
    plansDb.close();
  }

  // Assert on unmanaged/data/ contents
  const unmanagedData = join(backup, UNMANAGED_DATA_DIR);
  expect(existsSync(join(unmanagedData, "plans", "plans.db"))).toBe(true);
  expect(existsSync(join(unmanagedData, "plans", "plans.db-wal"))).toBe(false);
  expect(existsSync(join(unmanagedData, "plans", "plans.db-shm"))).toBe(false);

  // Readable and contains the uncheckpointed row
  const copiedPlans = new DatabaseSync(join(unmanagedData, "plans", "plans.db"), { readOnly: true });
  try {
    expect(copiedPlans.prepare("SELECT id FROM plans").all()).toEqual([{ id: "plan-1" }]);
  } finally {
    copiedPlans.close();
  }

  // Skipped files
  expect(existsSync(join(unmanagedData, "sessions"))).toBe(false);
  expect(existsSync(join(unmanagedData, "plans", "coffee.json"))).toBe(false);
  expect(existsSync(join(unmanagedData, "barry-devops"))).toBe(false);
  expect(existsSync(join(unmanagedData, "old-backup"))).toBe(false);

  // backedUpDataStores utility returns the external plans store
  expect(backedUpDataStores(backup)).toEqual(["plans/plans.db"]);
}, 30000);

it("does not copy itself when backup directory is inside data/", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(barryAppSupportDir(), "data", "barry-devops", "backups", "b1");
  await dbBackupCommand(backup, { vault: false });

  const unmanagedData = join(backup, UNMANAGED_DATA_DIR);
  expect(existsSync(join(unmanagedData, "barry-devops"))).toBe(false);
});

it("refuses a backup when free space is smaller than generation + data stores + 1GB", async () => {
  const { assertBackupFits } = await import("./db-stores.js");
  const genStore = { bag: "sessions", store: "sessions", scope: "identity" as const, path: "/gen", bytes: 1 * 1024 ** 3, walBytes: 0, version: 1, tables: 1 };
  const dataStore = { bag: "plans", file: "plans.db", path: "/data", bytes: 1 * 1024 ** 3, walBytes: 0 };
  // total needed: 2GB + 1GB buffer = 3GB
  expect(() => assertBackupFits([genStore, dataStore], "/backups", () => 2.5 * 1024 ** 3)).toThrow(/not enough free disk.*2\.0 GB.*2\.5 GB/);
  expect(() => assertBackupFits([genStore, dataStore], "/backups", () => 3.5 * 1024 ** 3)).not.toThrow();

  // Also verify through backupManagedStores
  await sourceHome();
  const dataDir = join(barryAppSupportDir(), "data", "plans");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "plans.db"));
  db.exec("CREATE TABLE t(x);");
  db.close();

  const backup = join(directory("barry-space-backup-"), "backup");
  await expect(backupManagedStores(backup, { availableSpace: () => 1024 ** 3 })).rejects.toThrow(/not enough free disk/);
});

it("handles a refused bag by copying its stores as unmanaged, logging, and refusing restore", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();

  failBag = "workflows";
  const backup = join(directory("barry-refused-bag-"), "backup");
  await dbBackupCommand(backup, { vault: false });

  // Verify the refused bag's store under generation was copied to stores-unmanaged/
  const unmanagedStore = join(backup, "stores-unmanaged", "node", "workflows", "workflows.db");
  expect(existsSync(unmanagedStore)).toBe(true);
  const db = new DatabaseSync(unmanagedStore, { readOnly: true });
  try {
    expect(db.prepare("SELECT count(*) AS n FROM workflow_runs").get()).toMatchObject({ n: 1 });
  } finally {
    db.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(`${unmanagedStore}${suffix}`, { force: true });
  }

  // Verify dbBackupCommand prints the warning line
  const printed = log.mock.calls.map(c => String(c[0])).join("\n");
  expect(printed).toContain("workflows: its store declarations could not be loaded, so its stores were copied to stores-unmanaged/ — broken manifest for workflows");

  // Verify restoring that backup refuses if the bag is still broken, naming the bad bag
  await expect(dbRestoreCommand(backup, { services: noServices })).rejects.toThrow(/workflows/);
}, 30000);

it("reports the data section on restore without copying files into place", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();

  const plansDir = join(barryAppSupportDir(), "data", "plans");
  mkdirSync(plansDir, { recursive: true });
  const plansDb = new DatabaseSync(join(plansDir, "plans.db"));
  plansDb.exec("CREATE TABLE plans(id TEXT); INSERT INTO plans VALUES('plan-1');");
  plansDb.close();

  const backup = join(directory("barry-restore-data-"), "backup");
  await dbBackupCommand(backup, { vault: false });

  // Case A: Target does NOT exist in the restored generation
  // Wipe data/ directory
  rmSync(join(barryAppSupportDir(), "data"), { recursive: true, force: true });
  log.mockClear();

  await dbRestoreCommand(backup, { services: noServices });
  const outputA = log.mock.calls.map(c => String(c[0])).join("\n");
  expect(outputA).toContain("not restored, kept outside the store generation (RESTORE.md says how to put one back):");
  const expectedPathA = join(barryAppSupportDir(), "data", "plans", "plans.db");
  expect(outputA).toContain(`unmanaged/data/plans/plans.db -> ${expectedPathA}`);
  // Verify data/ was NOT populated
  expect(existsSync(expectedPathA)).toBe(false);

  // Case B: Target DOES exist in the restored generation
  // Simulate by creating node/the external plans store in the current active generation before restore
  const currentGen = activeStoreRoot();
  const simNodePlansDir = join(currentGen, "node", "plans");
  mkdirSync(simNodePlansDir, { recursive: true });
  const simDb = new DatabaseSync(join(simNodePlansDir, "plans.db"));
  simDb.exec("CREATE TABLE simulated(id TEXT);");
  simDb.close();

  log.mockClear();
  await dbRestoreCommand(backup, { services: noServices });
  const outputB = log.mock.calls.map(c => String(c[0])).join("\n");
  const newGen = activeStoreRoot();
  const expectedPathB = join(newGen, "node", "plans", "plans.db");
  expect(outputB).toContain(`unmanaged/data/plans/plans.db -> ${expectedPathB}`);
}, 30000);

it("includes unmanaged/data/ and Stores outside the generation in RESTORE.md", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-restore-md-"), "backup");
  await dbBackupCommand(backup, { vault: false });

  const restoreMd = readFileSync(join(backup, "RESTORE.md"), "utf8");
  expect(restoreMd).toContain("unmanaged/data/<bag>/<file>");
  expect(restoreMd).toContain("## Stores outside the generation");
  expect(restoreMd).toContain(`${join(barryAppSupportDir(), "data")}/<bag>/<file>`);
  expect(restoreMd).toContain('lsof "<path>"');
  expect(restoreMd).toContain("barry service stop <service>");
  // A WAL left beside the copy would be replayed into it, so all three files move.
  expect(restoreMd).toContain('for s in "" -wal -shm; do [ -e "<path>$s" ] && mv "<path>$s" "<path>$s.before-restore"; done');
  expect(restoreMd).toContain('cp "unmanaged/data/<bag>/<file>" "<path>"');
  expect(restoreMd).toContain("Writes made since this backup are lost from the\nstore; the `.before-restore` files keep them.");
});

// An integrity probe can run while a service retains a WAL connection.
it("preserves a live WAL and fresh-connection reads across integrity verification", () => {
  const path = join(directory("barry-live-integrity-"), "sessions.db");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('before');");
  try {
    expect(sqliteIntegrity(path)).toBe("ok");
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(existsSync(`${path}-shm`)).toBe(true);
    writer.prepare("INSERT INTO sessions VALUES(?)").run("after");
    const reader = new DatabaseSync(path, { readOnly: true });
    try { expect(reader.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "after" }, { id: "before" }]); }
    finally { reader.close(); }
  } finally { writer.close(); }
});

it("routes committed sessions and reads messages through fresh connections after a live integrity probe", async () => {
  const { identity } = await sourceHome();
  const path = join(activeStoreRoot(), "identities", identity, "sessions", "sessions.db");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  try {
    writer.prepare("INSERT INTO sessions(id) VALUES(?)").run("incident-created");
    expect(sqliteIntegrity(path)).toBe("ok");
    expect(sessionIdentity("incident-created")).toBe(identity);
    const reader = new DatabaseSync(path, { readOnly: true });
    try { expect(reader.prepare("SELECT id FROM sessions WHERE id=?").get("incident-created")).toEqual({ id: "incident-created" }); }
    finally { reader.close(); }
    writer.prepare("INSERT INTO messages(id,session_id,type) VALUES(?,?,'text')").run("incident-message", "incident-created");
    const messages = new DatabaseSync(path, { readOnly: true });
    try { expect(messages.prepare("SELECT id FROM messages WHERE session_id=?").all("incident-created")).toEqual([{ id: "incident-message" }]); }
    finally { messages.close(); }
  } finally { writer.close(); }
});
