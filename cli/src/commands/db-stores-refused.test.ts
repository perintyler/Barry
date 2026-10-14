import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { directory, sourceHome } from "./__tests__/db-home.js";

afterEach(() => {
  vi.doUnmock("@barry-rocks/sdk/internal/bags");
  vi.resetModules();
});

const noServices = { statuses: async () => [], isSystem: () => false, stop: async () => {}, start: async () => {} };

/** Two bags served as the registry snapshot: `bad` declares `ok` before `broken`, whose migrations are missing. */
function inventory() {
  const bags = directory("barry-refused-bags-");
  const good = join(bags, "good"), bad = join(bags, "bad");
  for (const [root, store] of [[good, "things"], [bad, "ok"]]) {
    mkdirSync(join(root, "migrations", store), { recursive: true });
    writeFileSync(join(root, "migrations", store, "001_initial.sql"), "CREATE TABLE items(id TEXT PRIMARY KEY);\n");
  }
  const snapshot = join(bags, "bags.snapshot.json");
  writeFileSync(snapshot, "{}");
  const node = (migrations: string) => ({ owned_by: "node" as const, engine: "sqlite" as const, migrations });
  return {
    snapshot,
    bags: [
      { name: "good", source: { type: "local", path: good }, manifest: { stores: { things: node("migrations/things") } } },
      { name: "bad", source: { type: "local", path: bad }, manifest: { stores: { ok: node("migrations/ok"), broken: node("migrations/broken") } } },
    ],
  };
}

it("copies only a refused bag's stores unmanaged, including the one it declared before failing", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { installation } = await sourceHome();
  const { snapshot, bags } = inventory();
  vi.doMock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
    ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
    getRegistrySnapshotPath: () => snapshot,
    loadBagRegistrySnapshot: async () => ({ bags }),
  }));
  vi.resetModules();
  const { managedStoreRegistry, backupManagedStores } = await import("./db-stores.js");

  const { registry, warning, refused } = await managedStoreRegistry(installation, activeStoreRoot());
  expect(refused.map(entry => entry.bag)).toEqual(["bad"]);
  expect(warning).toMatch(/^bad: /);
  // The registry still holds bad/ok, registered before bad/broken threw; the backup must not trust it.
  const declared = registry.declarationsFor().map(entry => `${entry.bag}/${entry.store}`);
  expect(declared).toEqual(expect.arrayContaining(["good/things", "bad/ok"]));
  for (const store of ["good/things", "bad/ok"] as const) {
    const [bag, name] = store.split("/");
    (await registry.open({ node: installation, bag, store: name })).close();
  }

  const backup = directory("barry-refused-backup-");
  const lines = await backupManagedStores(backup);
  const [id] = readdirSync(join(backup, "stores"));
  const manifest = JSON.parse(readFileSync(join(backup, "stores", id, "manifest.json"), "utf8")) as { stores: { manifest: { bag: string; store: string } }[] };
  const managed = manifest.stores.map(entry => `${entry.manifest.bag}/${entry.manifest.store}`);
  expect(managed).toContain("good/things");
  expect(managed.filter(store => store.startsWith("bad/"))).toEqual([]);
  expect(existsSync(join(backup, "stores-unmanaged", "node", "bad", "ok.db"))).toBe(true);
  expect(lines).toContain(`  bad: its store declarations could not be loaded, so its stores were copied to stores-unmanaged/ — ${refused[0].reason}`);
  expect(lines.some(line => line.includes("bag inventory unavailable"))).toBe(false);

  const { dbRestoreCommand } = await import("./db-restore.js");
  await expect(dbRestoreCommand(backup, { services: noServices })).rejects.toThrow(/bad: /);
}, 30000);
