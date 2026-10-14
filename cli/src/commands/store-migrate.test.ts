import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { migrateBuiltinStores, storeMigrateCommand } from "./store-migrate.js";

vi.mock("@barry-rocks/mcp-bag", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/mcp-bag")>(),
  serviceRequest: async () => ({ services: [] }),
}));
const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it("journals a builtin migration and repeats the same id without changing stores", async () => {
  const home = mkdtempSync(join(tmpdir(), "barry-store-migrate-")); homes.push(home);
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(home, "identities.db"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  await storeMigrateCommand({ servicesStopped: true, id: "migration-test" });
  const root = barryStoresDir(), selected = activeStoreRoot();
  const receipt = readFileSync(join(root, "activations/migration-test.json"), "utf8");
  expect(JSON.parse(receipt).state).toBe("active");
  const repeated = await migrateBuiltinStores(true, "migration-test");
  expect(repeated.state).toBe("active");
  expect(JSON.parse(readFileSync(repeated.reportPath, "utf8")).state).toBe("active");
  expect(activeStoreRoot()).toBe(selected);
  expect(readFileSync(join(root, "activations/migration-test.json"), "utf8")).toBe(receipt);
  await expect(storeMigrateCommand({ servicesStopped: true })).rejects.toThrow(/already migrated/);
});
