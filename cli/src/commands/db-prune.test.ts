import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { directory, sourceHome, serviceFixture } from "./__tests__/db-home.js";
import { dbPruneCommand } from "./db-prune.js";
import { dbRestoreCommand } from "./db-restore.js";
import { dbBackupCommand } from "./db.js";

it("prunes an older generation on demand after two restores, keeping active and previous", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { root } = await sourceHome(), backup = join(directory("barry-prune-backup-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  await dbRestoreCommand(backup, { services: serviceFixture().services });
  const previous = activeStoreRoot();
  await dbRestoreCommand(backup, { services: serviceFixture().services });
  const active = activeStoreRoot();
  // Completed switches prune automatically; an orphan represents leftovers from an earlier command.
  const old = join(root, "generations/old"); mkdirSync(old); writeFileSync(join(old, "file"), "old bytes");
  await dbPruneCommand({ yes: true });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(active)).toBe(true); expect(existsSync(previous)).toBe(true);
  expect(log.mock.calls.flat().join("\n")).toContain("Freed 9 bytes.");
  await dbPruneCommand({ yes: true });
  expect(log.mock.calls.flat().join("\n")).toContain("Nothing to prune:");
});
it("requires --yes unattended and declining confirmation changes nothing", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { root } = await sourceHome(); mkdirSync(join(root, "generations/old"));
  const before = readdirSync(join(root, "generations"));
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(dbPruneCommand()).rejects.toThrow("Unattended prune requires --yes");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const confirm = vi.fn(async () => false);
    await dbPruneCommand({ confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(readdirSync(join(root, "generations"))).toEqual(before);
    expect(log.mock.calls.flat()).toContain("No changes made.");
  } finally {
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
it("warns when pruning fails after restore and still succeeds with services running", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { root } = await sourceHome(), backup = join(directory("barry-prune-failure-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const old = join(root, "generations/old"), inaccessible = join(old, "locked");
  mkdirSync(inaccessible, { recursive: true }); writeFileSync(join(inaccessible, "file"), "kept");
  chmodSync(inaccessible, 0o000);
  try {
    const control = serviceFixture();
    await dbRestoreCommand(backup, { services: control.services });
    expect(control.started).toEqual(control.stopped);
    expect(log.mock.calls.flat().join("\n")).toMatch(/could not remove older generations: .*Run `barry db prune` later/);
    expect(activeStoreRoot()).not.toBe(join(root, "generations/g1"));
  } finally { chmodSync(inaccessible, 0o700); }
});
