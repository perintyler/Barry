import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { activateStoreGeneration, prepareStoreGeneration, previousStoreGeneration, validatePreparedStoreGeneration, activeStoreRoot } from "@barry-rocks/sdk/internal/stores";

import { directory, sourceHome, serviceFixture } from "./__tests__/db-home.js";
import { dbRollbackCommand } from "./db-rollback.js";
import { dbRestoreCommand } from "./db-restore.js";
import { dbBackupCommand } from "./db.js";

function row(root: string): string {
  const db = new DatabaseSync(join(root, "node/retired/leftover.db"), { readOnly: true });
  try { return String(db.prepare("SELECT name FROM held").get()?.name); } finally { db.close(); }
}
function change(root: string, value: string): void {
  const db = new DatabaseSync(join(root, "node/retired/leftover.db"));
  try { db.prepare("UPDATE held SET name=?").run(value); } finally { db.close(); }
}
async function switchedHome() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { root } = await sourceHome(), legacy = activeStoreRoot();
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "g1", generation: legacy, report: {} }));
  const prepared = await prepareStoreGeneration({ root, previousId: "g1", servicesStopped: true, build: async candidate => change(candidate, "changed") });
  await activateStoreGeneration({ root, id: prepared.id, previousId: "g1", servicesStopped: true,
    validate: async () => { await validatePreparedStoreGeneration(root, prepared.id); }, sealPrevious: async () => {},
  });
  return { root, legacy, current: prepared.directory };
}
it("rolls back to a copy of a legacy generation, snapshots writes and restarts only running user services", async () => {
  const { root, legacy, current } = await switchedHome(), control = serviceFixture();
  await dbRollbackCommand({ yes: true, services: control.services });
  const active = activeStoreRoot(), id = active.split("/").at(-1)!;
  expect(active).not.toBe(legacy); expect(active).not.toBe(current);
  expect(row(active)).toBe("kept"); expect(existsSync(legacy)).toBe(false); expect(row(current)).toBe("changed");
  expect(JSON.parse(readFileSync(join(root, "preparations", `${id}.json`), "utf8")).source).toBe("g1");
  const backups = join(process.env.BARRY_HOME!, "app-support/backups"), [snapshot] = readdirSync(backups);
  const db = new DatabaseSync(join(backups, snapshot, "stores-unmanaged/node/retired/leftover.db"), { readOnly: true });
  try { expect(db.prepare("SELECT name FROM held").get()?.name).toBe("changed"); } finally { db.close(); }
  expect(control.stopped).toEqual(["sessions.api", "mcp.server"]);
  expect(control.started).toEqual(control.stopped); expect(control.roots).toEqual([active, active]);
  expect(control.states.get("vault.api")).toBe(true);
  // The snapshot is itself a valid restore source.
  await dbRestoreCommand(join(backups, snapshot), { services: serviceFixture().services });
  expect(row(activeStoreRoot())).toBe("changed");
});
it("rolls back between restored generations and a second rollback undoes the first", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await sourceHome();
  const backup = join(directory("barry-rollback-backup-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  await dbRestoreCommand(backup, { services: serviceFixture().services });
  const first = activeStoreRoot(); change(first, "after first restore");
  await dbRestoreCommand(backup, { services: serviceFixture().services });
  const second = activeStoreRoot(); expect(row(second)).toBe("kept");
  await dbRollbackCommand({ yes: true, services: serviceFixture().services });
  const rollback = activeStoreRoot(); expect(row(rollback)).toBe("after first restore");
  expect(existsSync(first)).toBe(false); expect(row(second)).toBe("kept");
  await dbRollbackCommand({ yes: true, services: serviceFixture().services });
  expect(activeStoreRoot()).not.toBe(second); expect(row(activeStoreRoot())).toBe("kept");
});
it.each(["fresh", "legacy"])("refuses a %s home with no receipt without creating anything", async kind => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  if (kind === "legacy") await sourceHome(); else vi.stubEnv("BARRY_HOME", directory("barry-rollback-fresh-"));
  const root = barryStoresDir(), before = existsSync(root) ? readdirSync(join(root, "generations")) : [];
  const control = serviceFixture();
  await expect(dbRollbackCommand({ yes: true, services: control.services })).rejects.toThrow(/barry db restore/);
  expect(existsSync(join(process.env.BARRY_HOME!, "app-support/backups"))).toBe(false);
  expect(existsSync(root) ? readdirSync(join(root, "generations")) : []).toEqual(before);
  expect(control.stopped).toEqual([]);
});
it("refuses when the active generation cannot be snapshotted", async () => {
  const { root, current } = await switchedHome(), generations = readdirSync(join(root, "generations"));
  // Without an installation id the snapshot skips every store, so the undo it offers would restore nothing.
  rmSync(join(current, "node/nodes/peers.db"));
  const control = serviceFixture();
  await expect(dbRollbackCommand({ yes: true, services: control.services })).rejects.toThrow(/cannot snapshot current stores without an installation id/);
  expect(readdirSync(join(root, "generations"))).toEqual(generations);
  expect(existsSync(join(process.env.BARRY_HOME!, "app-support/backups"))).toBe(false);
  expect(control.stopped).toEqual([]);
});
it("rolls back the selector and restarts the same services after candidate validation fails", async () => {
  const { root, current, legacy } = await switchedHome(), selector = readFileSync(join(root, "active.json"));
  let candidate: string | undefined;
  const control = serviceFixture({ status: () => {
    candidate = readdirSync(join(root, "generations")).find(id => ![current, legacy].includes(join(root, "generations", id)));
    if (candidate) writeFileSync(join(root, "generations", candidate, "changed.txt"), "invalid");
  } });
  await expect(dbRollbackCommand({ yes: true, services: control.services })).rejects.toThrow(/Rollback failed; services restarted.*prepared store generation changed/);
  expect(control.started).toEqual(control.stopped); expect(control.roots).toEqual([current, current]);
  expect(readFileSync(join(root, "active.json"))).toEqual(selector);
  expect(JSON.parse(readFileSync(join(root, "activations", `${candidate}.json`), "utf8")).state).toBe("rolledBack");
  expect(previousStoreGeneration(root)?.id).toBe("g1");
});
it("requires --yes unattended and declining a terminal prompt takes no snapshot", async () => {
  const { root } = await switchedHome(), generations = readdirSync(join(root, "generations"));
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  await expect(dbRollbackCommand()).rejects.toThrow(/Unattended rollback requires --yes/);

  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    const confirm = vi.fn(async (_message: string) => false), control = serviceFixture();
    await dbRollbackCommand({ confirm, services: control.services });
    expect(confirm.mock.calls[0]?.[0]).toContain(previousStoreGeneration(root)!.replacedBy);
    expect(confirm.mock.calls[0]?.[0]).toContain(previousStoreGeneration(root)!.replacedAt.toISOString());
    expect(confirm.mock.calls[0]?.[0]).toContain("Writes since");
    expect(confirm.mock.calls[0]?.[0]).toContain("stop being used");
    expect(readdirSync(join(root, "generations"))).toEqual(generations);
    expect(existsSync(join(process.env.BARRY_HOME!, "app-support/backups"))).toBe(false); expect(control.stopped).toEqual([]);
  } finally {
    if (input) Object.defineProperty(process.stdin, "isTTY", input); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (output) Object.defineProperty(process.stdout, "isTTY", output); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});
it("prepares before stopping services and catches services started before the switch", async () => {
  const { root, legacy, current } = await switchedHome();
  const control = serviceFixture({
    status: () => expect(readdirSync(join(root, "generations"))).toHaveLength(3),
    stop: key => { if (key === "mcp.server") control.states.set("disabled.web", true); },
  });
  await dbRollbackCommand({ yes: true, services: control.services });
  expect(control.stopped).toEqual(["sessions.api", "mcp.server", "disabled.web"]);
  expect(control.started).toEqual(control.stopped);
  expect(control.roots).toEqual(control.started.map(() => activeStoreRoot()));
  expect(existsSync(legacy)).toBe(false); expect(row(current)).toBe("changed");
});
it("reports a completed switch and failed service restarts without reverting it", async () => {
  const { current } = await switchedHome(), control = serviceFixture();
  const start = control.services.start;
  control.services.start = async key => { if (key === "sessions.api") throw Error("start rejected"); await start(key); };
  await expect(dbRollbackCommand({ yes: true, services: control.services })).rejects.toThrow(/Rolled back to .*previous generation kept at .*could not restart services: .*sessions.api.*start rejected/);
  expect(activeStoreRoot()).not.toBe(current); expect(row(activeStoreRoot())).toBe("kept");
  expect(control.started).toEqual(["mcp.server"]);
});
