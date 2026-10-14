import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { barryAppSupportDir, barryCurrentDir, barryReleasesDir } from "@barry-rocks/sdk/services";
import { openInstance, acquireLock } from "@barry-rocks/sdk/internal/services";
import { activeStoreRoot, loadSqlMigrations, previousStoreGeneration, sqliteProvider } from "@barry-rocks/sdk/internal/stores";
import { dbRollbackCommand } from "../commands/db-rollback.js";
import { coreProvider } from "../services/configuration/index.js";
import { copyRelease, linkedNode, pointCurrent } from "./current.js";
import { readReceipts, receiptId, writeReceipt, type Receipt } from "./receipts.js";
import { storeVersions } from "./schemas.js";
import { releaseState } from "./state.js";
import { upgradeCommand } from "./upgrade.js";
import { fixtureBag, fixtureRelease, repository, scratchEnvironment, serviceFixture, sourceHome } from "./__tests__/release-home.js";
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor); else Reflect.deleteProperty(stream, "isTTY");
  }
});
beforeEach(() => { scratchEnvironment(); vi.spyOn(console, "log").mockImplementation(() => {}); });
async function fixture(schema = false, second?: string) {
  const home = await sourceHome(), services = serviceFixture();
  const a = fixtureRelease("1.0.0", schema ? { "fixture/things": 1 } : {});
  const b = fixtureRelease("2.0.0", schema ? { "fixture/things": 2 } : {}, "b".repeat(40));
  if (schema) {
    const bag = fixtureBag(b.root, second), path = join(activeStoreRoot(), "node/fixture/things.db");
    mkdirSync(join(path, ".."), { recursive: true });
    (await sqliteProvider(loadSqlMigrations(bag, "migrations").slice(0, 1)).open(path, {})).close();
  }
  pointCurrent(copyRelease(a.root, a.release));
  const run = vi.fn(async () => {}), waitForHealth = vi.fn(async () => {}), runningSessions = vi.fn(async () => [{ id: "turn", status: "running" }]);
  const options = { yes: true, release: b, services: services.services, run, waitForHealth, runningSessions };
  return { ...home, a, b, services, options, run, waitForHealth };
}
it("switches code without changing the generation, snapshots and force builds while user services are stopped", async () => {
  const f = await fixture(), marker = readFileSync(join(f.root, "active.json"));
  const c = fixtureRelease("3.0.0", {}, "c".repeat(40)); copyRelease(c.root, c.release);
  mkdirSync(join(barryReleasesDir(), ".3.0.0-x"));
  f.run.mockImplementation(async () => { expect(f.services.states.get("sessions.api")).toBe(false); expect(f.services.states.get("vault.api")).toBe(true); });
  vi.stubEnv("BARRY_DIR", "/old"); vi.stubEnv("BARRY_BUILTIN_DIR", "/old/bags"); vi.stubEnv("BARRY_NODE", process.execPath);
  await upgradeCommand(f.options);
  expect(readlinkSync(barryCurrentDir())).toBe("releases/2.0.0");
  expect(readFileSync(join(f.root, "active.json"))).toEqual(marker);
  const receipt = readReceipts()[0];
  expect(receipt.state).toBe("complete"); expect(receipt.generations).toEqual({ before: "g1", after: null }); expect(existsSync(receipt.snapshot!)).toBe(true);
  expect(f.run.mock.calls.map(call => call[1])).toEqual([["setup", "--no-start"], ["bag", "build", "--force"]]);
  const child = f.run.mock.calls[0][2];
  expect(child.cwd).toBe(barryCurrentDir());
  for (const name of ["BARRY_DIR", "BARRY_BUILTIN_DIR", "BARRY_HOOK_DISPATCHER", "BARRY_NODE"]) expect(child.env[name]).toBeUndefined();
  expect(f.services.stopped).toEqual(["sessions.api", "mcp.server"]); expect(f.services.started).toEqual(f.services.stopped);
  expect(f.waitForHealth).toHaveBeenCalledWith(["sessions.api", "mcp.server"]);
  expect(readdirSync(barryReleasesDir()).sort()).toEqual(["1.0.0", "2.0.0", "upgrades"]);
});
it("migrates a private generation and records its unchanged predecessor", async () => {
  const f = await fixture(true);
  await upgradeCommand(f.options);
  expect(storeVersions(activeStoreRoot())["fixture/things"]).toBe(2);
  expect(storeVersions(join(f.root, "generations/g1"))["fixture/things"]).toBe(1);
  expect(previousStoreGeneration(f.root)?.id).toBe("g1");
  expect(readReceipts()[0].generations).toEqual({ before: "g1", after: previousStoreGeneration(f.root)?.replacedBy });
});
it("reverts a failed migration without touching source versions or migration rows", async () => {
  const f = await fixture(true, "INVALID SQL"), marker = readFileSync(join(f.root, "active.json")), versions = storeVersions(activeStoreRoot());
  const path = join(activeStoreRoot(), "node/fixture/things.db"), bytes = readFileSync(path);
  await expect(upgradeCommand(f.options)).rejects.toThrow("services restarted on the previous release");
  expect(readlinkSync(barryCurrentDir())).toBe("releases/1.0.0"); expect(readFileSync(join(f.root, "active.json"))).toEqual(marker);
  expect(readReceipts()[0].state).toBe("reverted"); expect(f.services.started).toEqual(f.services.stopped);
  expect(storeVersions(activeStoreRoot())).toEqual(versions); expect(readFileSync(path)).toEqual(bytes);
});
it("keeps a switched receipt after setup fails and finishes it without a second preparation", async () => {
  const f = await fixture(true);
  f.run.mockRejectedValueOnce(new Error("setup broke"));
  await expect(upgradeCommand(f.options)).rejects.toThrow("Run `barry upgrade` again to finish, or `barry upgrade --rollback`");
  const receipt = readReceipts()[0], generation = activeStoreRoot();
  expect(receipt.state).toBe("switched"); expect(receipt.problem).toContain("setup broke"); expect(f.services.started).toEqual(f.services.stopped);
  await upgradeCommand(f.options);
  expect(activeStoreRoot()).toBe(generation); expect(readReceipts()[0].id).toBe(receipt.id); expect(readReceipts()[0].state).toBe("complete");
  expect(readReceipts()[0].problem).toBeUndefined();
});
it("recovers a selector flipped before activation and includes the saved restart set", async () => {
  const f = await fixture(true);
  pointCurrent(copyRelease(f.b.root, f.b.release));
  f.services.states.set("sessions.api", false);
  const receipt: Receipt = { format: 1, id: receiptId(), kind: "upgrade", state: "started", from: { kind: "release", version: "1.0.0", commit: f.a.release.commit }, to: { kind: "release", version: "2.0.0", commit: f.b.release.commit }, generations: { before: "g1", after: null }, snapshot: null, services: ["sessions.api"], started: new Date().toISOString() };
  writeReceipt(receipt);
  await upgradeCommand(f.options);
  expect(readReceipts().find(entry => entry.id === receipt.id)?.state).toBe("reverted");
  expect(readReceipts()[0].state).toBe("complete"); expect(f.services.started).toContain("sessions.api");
});
it("rolls back through a copy and snapshots writes made since the upgrade", async () => {
  const f = await fixture(true); await upgradeCommand(f.options);
  const outgoing = activeStoreRoot(), path = join(outgoing, "node/fixture/things.db");
  const database = new DatabaseSync(path); database.exec("INSERT INTO things(value) VALUES('new write')"); database.close();
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const confirm = vi.fn(async () => true);
  await upgradeCommand({ ...f.options, yes: false, rollback: true, confirm });
  expect(confirm.mock.calls[0][0]).toContain("Writes since"); expect(confirm.mock.calls[0][0]).toContain("stop being used");
  expect(readlinkSync(barryCurrentDir())).toBe("releases/1.0.0"); expect(activeStoreRoot()).not.toBe(join(f.root, "generations/g1"));
  const db = new DatabaseSync(join(activeStoreRoot(), "node/fixture/things.db"), { readOnly: true }); expect(db.prepare("SELECT * FROM things").all()).toEqual([]); db.close();
  const receipt = readReceipts()[0]; expect(receipt.kind).toBe("rollback"); expect(receipt.state).toBe("complete");
  let backup = join(receipt.snapshot!, "stores-unmanaged/node/fixture/things.db");
  if (!existsSync(backup)) {
    const stores = join(receipt.snapshot!, "stores"), directory = join(stores, readdirSync(stores)[0]);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    const entry = manifest.stores.find((entry: { manifest: { bag: string; store: string } }) => entry.manifest.bag === "fixture" && entry.manifest.store === "things");
    backup = join(directory, entry.file);
  }
  const saved = new DatabaseSync(backup, { readOnly: true }); expect(saved.prepare("SELECT value FROM things").get()?.value).toBe("new write"); saved.close();
  expect(existsSync(join(barryReleasesDir(), "2.0.0"))).toBe(true);
});
it("refuses rollback as a whole after a database rollback", async () => {
  const f = await fixture(true); await upgradeCommand(f.options);
  await dbRollbackCommand({ yes: true, services: f.services.services });
  const marker = readFileSync(join(f.root, "active.json")), receipt = readReceipts()[0];
  await expect(upgradeCommand({ ...f.options, rollback: true })).rejects.toThrow("The stores changed since the upgrade");
  expect(readFileSync(join(f.root, "active.json"))).toEqual(marker); expect(readReceipts()[0]).toEqual(receipt); expect(readlinkSync(barryCurrentDir())).toBe("releases/2.0.0");
});
/** current names a checkout whose Node only setup --link's service definitions record. */
async function linkedFixture() {
  const f = await fixture(), checkout = fixtureRelease("0.0.0").root;
  rmSync(join(checkout, "release.json")); rmSync(join(checkout, "runtime"), { recursive: true });
  mkdirSync(join(checkout, "cli/src/services/configuration"), { recursive: true });
  cpSync(join(repository, "cli/src/services/configuration/migrations"), join(checkout, "cli/src/services/configuration/migrations"), { recursive: true });
  f.b.release.stores = { "core/config": coreProvider.migrations.length }; writeFileSync(join(f.b.root, "release.json"), JSON.stringify(f.b.release));
  pointCurrent(checkout); vi.stubEnv("BARRY_NODE", undefined);
  const definitions = (environment: Record<string, string>) => writeFileSync(join(barryAppSupportDir(), "managed-definitions.json"), JSON.stringify([{ name: "fixture.api", command: [process.execPath], domain: "gui/501", environment }]));
  definitions({ BARRY_NODE: process.execPath });
  return { f, checkout, definitions };
}
it("records a linked Node, returns to the checkout and reuses the release going forward", async () => {
  const { f, checkout } = await linkedFixture();
  await upgradeCommand(f.options);
  expect(readReceipts()[0].from).toEqual({ kind: "link", target: checkout, commit: null, node: process.execPath });
  await upgradeCommand({ ...f.options, rollback: true });
  expect(readlinkSync(barryCurrentDir())).toBe(checkout); expect(f.run.mock.calls.at(-1)![2].env.BARRY_NODE).toBe(process.execPath);
  await upgradeCommand(f.options); expect(readlinkSync(barryCurrentDir())).toBe("releases/2.0.0");
});
it.each(["checkout", "missing current", "unattended", "newer stores", "no generation", "lock"])("refuses %s without changing the selectors or receipts", async refusal => {
  const f = await fixture(true), marker = readFileSync(join(f.root, "active.json"));
  let options = f.options, unlock: (() => void) | undefined;
  if (refusal === "checkout") { rmSync(join(f.b.root, "release.json")); options = { ...options, release: undefined }; }
  if (refusal === "missing current") rmSync(barryCurrentDir());
  if (refusal === "unattended") options = { ...options, yes: false };
  if (refusal === "newer stores") { f.b.release.stores["fixture/things"] = 0; }
  if (refusal === "no generation") rmSync(join(f.root, "active.json"));
  if (refusal === "lock") unlock = acquireLock(barryReleasesDir(), "upgrade");
  const selector = existsSync(barryCurrentDir()) ? readlinkSync(barryCurrentDir()) : null;
  try { await expect(upgradeCommand(options)).rejects.toThrow(); } finally { unlock?.(); }
  expect(readReceipts()).toEqual([]); expect(existsSync(barryCurrentDir()) ? readlinkSync(barryCurrentDir()) : null).toBe(selector);
  if (refusal !== "no generation") expect(readFileSync(join(f.root, "active.json"))).toEqual(marker);
});
it("does nothing when already on the installed release", async () => {
  const f = await fixture(); await upgradeCommand(f.options);
  const receipt = readReceipts()[0]; f.run.mockClear();
  await upgradeCommand(f.options); expect(f.run).not.toHaveBeenCalled(); expect(readReceipts()[0]).toEqual(receipt);
});

it("refuses an unfinished store switch before making a receipt or stopping services", async () => {
  const f = await fixture(true), marker = readFileSync(join(f.root, "active.json"));
  writeFileSync(join(f.root, "activation.json"), JSON.stringify({ format: 1, root: f.root, id: "g2", previousId: "g1", state: "prepared", previousChecksum: "a".repeat(64), nextChecksum: "b".repeat(64) }));
  await expect(upgradeCommand(f.options)).rejects.toThrow("run `barry db recover`");
  expect(readReceipts()).toEqual([]); expect(readFileSync(join(f.root, "active.json"))).toEqual(marker); expect(f.services.stopped).toEqual([]);
});
it("keeps switched code and unpruned releases when health fails", async () => {
  const f = await fixture(), c = fixtureRelease("3.0.0", {}, "c".repeat(40)); copyRelease(c.root, c.release);
  f.waitForHealth.mockRejectedValue(new Error("unhealthy sessions.api"));
  await expect(upgradeCommand(f.options)).rejects.toThrow("barry upgrade --rollback");
  expect(readlinkSync(barryCurrentDir())).toBe("releases/2.0.0"); expect(existsSync(join(barryReleasesDir(), "3.0.0"))).toBe(true);
  expect(readReceipts()[0].state).toBe("complete");
});
it("records a bag build failure after activation and can finish it", async () => {
  const f = await fixture();
  f.run.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("bundle broke"));
  await expect(upgradeCommand(f.options)).rejects.toThrow("the bag build failed");
  expect(readReceipts()[0].state).toBe("switched"); expect(readlinkSync(barryCurrentDir())).toBe("releases/2.0.0");
  await upgradeCommand(f.options); expect(readReceipts()[0].state).toBe("complete");
});

it("refuses root and dangling selectors before acquiring an upgrade lock", async () => {
  const f = await fixture();
  const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
  await expect(upgradeCommand(f.options)).rejects.toThrow("not root"); uid.mockRestore();
  pointCurrent(join(f.b.root, "missing"));
  await expect(upgradeCommand(f.options)).rejects.toThrow("run barry setup --link <checkout>");
  expect(readReceipts()).toEqual([]); expect(f.services.stopped).toEqual([]); expect(existsSync(join(barryReleasesDir(), "upgrade.lock"))).toBe(false);
});

it("reverts the receipt when stopping fails before entering the switch callback", async () => {
  const f = await fixture(), stop = f.services.services.stop;
  f.services.services.stop = async key => { await stop(key); throw new Error("stop reported failure"); };
  await expect(upgradeCommand(f.options)).rejects.toThrow("stop reported failure");
  expect(readReceipts()[0].state).toBe("reverted"); expect(readlinkSync(barryCurrentDir())).toBe("releases/1.0.0"); expect(f.services.started).toEqual(["sessions.api"]);
});

it("starts newly registered enabled user services through the injected controller", async () => {
  const f = await fixture(), home = barryAppSupportDir(), instance = openInstance(home);
  f.run.mockImplementationOnce(async () => {
    writeFileSync(join(home, "managed-definitions.json"), JSON.stringify(["new.api", "new.web"].map(name => ({ name, command: [process.execPath], domain: `gui/${process.getuid!()}` }))));
    writeFileSync(join(home, "services.json"), JSON.stringify({ instance: instance.id, services: { "new.api": { registered: true, enabled: true }, "new.web": { registered: true, enabled: false } } }));
    f.services.states.set("new.api", false); f.services.states.set("new.web", false);
  });
  await upgradeCommand(f.options);
  expect(f.services.started).toEqual(["sessions.api", "mcp.server", "new.api"]);
  expect(f.waitForHealth).toHaveBeenCalledWith(["sessions.api", "mcp.server", "new.api"]);
});
it("rolls back code without copying or snapshotting unchanged stores", async () => {
  const f = await fixture(); await upgradeCommand(f.options);
  const marker = readFileSync(join(f.root, "active.json")), backups = readdirSync(join(barryAppSupportDir(), "backups"));
  await upgradeCommand({ ...f.options, rollback: true });
  expect(readReceipts()[0]).toEqual(expect.objectContaining({ kind: "rollback", state: "complete", snapshot: null, generations: { before: "g1", after: null } }));
  expect(readFileSync(join(f.root, "active.json"))).toEqual(marker); expect(readdirSync(join(barryAppSupportDir(), "backups"))).toEqual(backups);
});

it("finishes an interrupted rollback to a linked checkout with --rollback and the Node its receipt recorded", async () => {
  const { f, checkout, definitions } = await linkedFixture();
  await upgradeCommand(f.options);
  // The release's setup rewrote the definitions without BARRY_NODE, and the checkout's setup never ran.
  definitions({}); f.run.mockRejectedValueOnce(new Error("setup broke"));
  await expect(upgradeCommand({ ...f.options, rollback: true })).rejects.toThrow("Run `barry upgrade --rollback` again to finish.");
  expect(readlinkSync(barryCurrentDir())).toBe(checkout); expect(readReceipts()[0]).toEqual(expect.objectContaining({ kind: "rollback", state: "switched" }));
  expect(linkedNode()).toBe(process.execPath); expect(releaseState().problems.join()).toContain("run barry upgrade --rollback again");
  await expect(upgradeCommand(f.options)).rejects.toThrow("run `barry upgrade --rollback` to finish it");
  await upgradeCommand({ ...f.options, rollback: true });
  expect(readlinkSync(barryCurrentDir())).toBe(checkout); expect(readReceipts()[0]).toEqual(expect.objectContaining({ kind: "rollback", state: "complete" }));
  expect(f.run.mock.calls.at(-2)![1]).toEqual(["setup", "--no-start"]); expect(f.run.mock.calls.at(-2)![2].env.BARRY_NODE).toBe(process.execPath);
});
it("reverts a rollback interrupted before activation and rolls back afresh with --rollback", async () => {
  const f = await fixture(true); await upgradeCommand(f.options);
  const upgrade = readReceipts()[0], active = activeStoreRoot();
  pointCurrent(join(barryReleasesDir(), "1.0.0")); f.services.states.set("sessions.api", false);
  const interrupted: Receipt = { format: 1, id: receiptId(), kind: "rollback", state: "started", from: upgrade.to, to: upgrade.from, generations: { before: upgrade.generations.after, after: "unactivated" }, snapshot: null, services: ["sessions.api"], started: new Date().toISOString() };
  writeReceipt(interrupted);
  expect(activeStoreRoot()).toBe(active);
  await upgradeCommand({ ...f.options, rollback: true });
  expect(readReceipts().find(receipt => receipt.id === interrupted.id)?.state).toBe("reverted");
  expect(readReceipts()[0]).toEqual(expect.objectContaining({ kind: "rollback", state: "complete" }));
  expect(readlinkSync(barryCurrentDir())).toBe("releases/1.0.0"); expect(storeVersions(activeStoreRoot())["fixture/things"]).toBe(1);
  expect(f.services.started).toContain("sessions.api");
});
