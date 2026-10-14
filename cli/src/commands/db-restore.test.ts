import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { directory, sourceHome, serviceFixture } from "./__tests__/db-home.js";
import { dbBackupCommand } from "./db.js";
import { dbRestoreCommand } from "./db-restore.js";

const noServices = { statuses: async () => [], isSystem: () => false, stop: async () => {}, start: async () => {} };

it("backs up every store of a generation and restores it into a fresh home with workflow runs paused", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const source = await sourceHome();
  const backup = join(directory("barry-db-backup-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const printed = log.mock.calls.map(call => String(call[0])).join("\n");
  expect(printed).toMatch(/stores\/[0-9a-f-]+ \(\d+ stores:/);
  expect(printed).toContain("stores-unmanaged/node/retired/leftover.db");
  const [backupId] = readdirSync(join(backup, "stores")).filter(name => !name.startsWith("."));
  const manifest = JSON.parse(readFileSync(join(backup, "stores", backupId, "manifest.json"), "utf8")) as { stores: { manifest: { bag: string; store: string; identity?: string; node: string } }[] };
  const captured = manifest.stores.map(entry => `${entry.manifest.identity ? "identity" : "node"}:${entry.manifest.bag}/${entry.manifest.store}`);
  expect(captured).toEqual(expect.arrayContaining(["node:nodes/peers", "node:workflows/workflows", "identity:sessions/sessions"]));
  expect(new Set(manifest.stores.map(entry => entry.manifest.node))).toEqual(new Set([source.installation]));
  expect(readFileSync(join(backup, "RESTORE.md"), "utf8")).toContain("barry db restore");
  // The fixed top-level copies older tooling reads are still written.
  for (const name of ["config.db", "sessions.db"]) expect(existsSync(join(backup, name)), name).toBe(true);

  // A fresh home on another machine: nothing under stores/, no bag snapshot.
  process.env.BARRY_HOME = directory("barry-db-restore-");
  await dbRestoreCommand(backup, { services: noServices });
  const restored = activeStoreRoot();
  expect(restored).not.toBe(join(barryStoresDir(), "generations", "g1"));
  const peers = new DatabaseSync(join(restored, "node", "nodes", "peers.db"), { readOnly: true });
  try {
    expect(peers.prepare("SELECT value FROM settings WHERE key='nodeId'").get()?.value).toBe(source.installation);
    expect(peers.prepare("SELECT legacyId FROM local_identities WHERE uuid=?").get(source.identity)?.legacyId).toBe(1);
  } finally { peers.close(); }
  const sessions = new DatabaseSync(join(restored, "identities", source.identity, "sessions", "sessions.db"), { readOnly: true });
  try {
    expect(sessions.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-1" }]);
    expect(sessions.prepare("SELECT session_id FROM messages WHERE id='message-1'").get()?.session_id).toBe("session-1");
  } finally { sessions.close(); }
  const workflows = new DatabaseSync(join(restored, "node", "workflows", "workflows.db"), { readOnly: true });
  try {
    expect(workflows.prepare("SELECT status, error FROM workflow_runs WHERE id='run-1'").get()).toMatchObject({ status: "blocked", error: expect.stringContaining("RecoveryPaused") });
    expect(Number(workflows.prepare("SELECT count(*) AS n FROM workflow_events WHERE run_id='run-1'").get()?.n)).toBeGreaterThan(0);
  } finally { workflows.close(); }
  const locks = new DatabaseSync(join(restored, "node", "retired", "leftover.db"), { readOnly: true });
  try { expect(locks.prepare("SELECT name FROM held").get()?.name).toBe("kept"); } finally { locks.close(); }
});

it("refuses a backup from another installation unless told to replace it", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-db-backup-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  process.env.BARRY_HOME = directory("barry-db-restore-");
  const root = barryStoresDir(), generation = join(root, "generations", "other");
  mkdirSync(generation, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "other" }));
  const other = new NodeRegistry(join(generation, "node", "nodes"));
  other.close();
  await expect(dbRestoreCommand(backup, { services: noServices })).rejects.toThrow(/--replace-installation/);
  expect(activeStoreRoot()).toBe(generation);
  await dbRestoreCommand(backup, { services: noServices, replaceInstallation: true });
  expect(activeStoreRoot()).not.toBe(generation);
  expect(existsSync(join(generation, "node", "nodes", "peers.db"))).toBe(true);
});

it("refuses a directory with no registry backup", async () => {
  const empty = directory("barry-db-legacy-");
  await expect(dbRestoreCommand(empty, { services: noServices })).rejects.toThrow(/RESTORE.md/);
});

it("refuses a backup that would leave the disk with less than a gigabyte free", async () => {
  const { assertBackupFits } = await import("./db-stores.js");
  const store = { bag: "sessions", store: "sessions", scope: "identity" as const, path: "/x", bytes: 2 * 1024 ** 3, walBytes: 0, version: 1, tables: 1 };
  expect(() => assertBackupFits([store], "/backups", () => 2.5 * 1024 ** 3)).toThrow(/not enough free disk.*2\.0 GB.*2\.5 GB/);
  expect(() => assertBackupFits([store], "/backups", () => 4 * 1024 ** 3)).not.toThrow();
});

it("snapshots the changed row, restores the backup, keeps the previous generation and restarts only running user services", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const source = await sourceHome();
  const backup = join(directory("barry-roundtrip-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const previous = activeStoreRoot(), path = join(previous, "node", "retired", "leftover.db");
  const changed = new DatabaseSync(path);
  try { changed.exec("UPDATE held SET name='changed'"); } finally { changed.close(); }
  const control = serviceFixture();
  await dbRestoreCommand(backup, { services: control.services });
  expect(control.stopped).toEqual(["sessions.api", "mcp.server"]);
  expect(control.started).toEqual(control.stopped);
  expect(control.roots).toEqual([activeStoreRoot(), activeStoreRoot()]);
  const restored = new DatabaseSync(join(activeStoreRoot(), "node", "retired", "leftover.db"));
  try { expect(restored.prepare("SELECT name FROM held").get()?.name).toBe("kept"); } finally { restored.close(); }
  const retained = new DatabaseSync(path);
  try { expect(retained.prepare("SELECT name FROM held").get()?.name).toBe("changed"); } finally { retained.close(); }
  const backups = join(process.env.BARRY_HOME!, "app-support", "backups");
  const [snapshot] = readdirSync(backups);
  const captured = new DatabaseSync(join(backups, snapshot, "stores-unmanaged/node/retired/leftover.db"));
  try { expect(captured.prepare("SELECT name FROM held").get()?.name).toBe("changed"); } finally { captured.close(); }
  expect(existsSync(join(source.root, "activations", `${activeStoreRoot().split("/").at(-1)}.json`))).toBe(true);
});
it("restarts the stopped set on the previous generation when activation validation fails", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-failed-restore-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const root = barryStoresDir(), previous = activeStoreRoot();
  // The candidate changes after it was prepared, before the switch.
  const control = serviceFixture({ status: () => {
    const candidate = readdirSync(join(root, "generations")).find(id => join(root, "generations", id) !== previous);
    if (candidate) writeFileSync(join(root, "generations", candidate, "changed.txt"), "invalid");
  } });
  await expect(dbRestoreCommand(backup, { services: control.services })).rejects.toThrow(/previous generation.*prepared store generation changed/);
  expect(control.started).toEqual(control.stopped);
  expect(control.roots).toEqual([previous, previous]);
  expect(activeStoreRoot()).toBe(previous);
});
it("keeps services running when the current snapshot or incoming backup is corrupt", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-corrupt-restore-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const previous = activeStoreRoot(), current = join(previous, "node/retired/leftover.db");
  const bytes = readFileSync(current);
  writeFileSync(current, "broken current store");
  const control = serviceFixture();
  await expect(dbRestoreCommand(backup, { services: control.services })).rejects.toThrow(/not a database/);
  expect(control.stopped).toEqual([]);
  expect(activeStoreRoot()).toBe(previous);
  writeFileSync(current, bytes);
  const unmanaged = join(backup, "stores-unmanaged/node/retired/leftover.db"), unmanagedBytes = readFileSync(unmanaged);
  writeFileSync(unmanaged, "broken incoming store");
  await expect(dbRestoreCommand(backup, { services: control.services })).rejects.toThrow(/not a database/);
  writeFileSync(unmanaged, unmanagedBytes);
  const [backupId] = readdirSync(join(backup, "stores")).filter(name => !name.startsWith("."));
  const managed = join(backup, "stores", backupId, "0.db");
  chmodSync(managed, 0o600);
  writeFileSync(managed, "broken incoming snapshot");
  await expect(dbRestoreCommand(backup, { services: control.services })).rejects.toThrow(/snapshot integrity mismatch/);
  expect(control.stopped).toEqual([]);
  expect(control.started).toEqual([]);
  expect(activeStoreRoot()).toBe(previous);
});
it("prepares the candidate only after the services writing to the current generation have stopped", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-live-restore-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const previous = activeStoreRoot();
  // A running service keeps writing to the generation the candidate is copied from.
  const live = new DatabaseSync(join(previous, "node", "retired", "leftover.db"));
  const writer = setInterval(() => {
    try { live.exec("INSERT INTO held VALUES('live')"); } catch { /* A reader holds the store; the next tick writes. */ }
  }, 1);
  try {
    const control = serviceFixture({ stop: () => clearInterval(writer) });
    await dbRestoreCommand(backup, { services: control.services });
    expect(control.stopped).toEqual(["sessions.api", "mcp.server"]);
    expect(activeStoreRoot()).not.toBe(previous);
  } finally { clearInterval(writer); live.close(); }
});
it("stops a service someone starts during the restore and starts it again on the restored generation", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-raced-restore-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const control = serviceFixture({ stop: key => { if (key === "mcp.server") control.states.set("disabled.web", true); } });
  await dbRestoreCommand(backup, { services: control.services });
  expect(control.stopped).toEqual(["sessions.api", "mcp.server", "disabled.web"]);
  expect(control.started).toEqual(control.stopped);
  expect(control.roots).toEqual(control.started.map(() => activeStoreRoot()));
});

it("prunes the generation two back after a second restore", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const oldest = activeStoreRoot(), backup = join(directory("barry-pruning-restore-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  await dbRestoreCommand(backup, { services: noServices });
  const previous = activeStoreRoot();
  await dbRestoreCommand(backup, { services: noServices });
  expect(existsSync(oldest)).toBe(false);
  expect(existsSync(previous)).toBe(true);
  expect(log.mock.calls.flat().join("\n")).toContain("removed older generation g1");
});
