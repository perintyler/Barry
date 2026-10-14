import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { discoverBuiltinBags } from "@barry-rocks/sdk/internal/bags";
import { activeStoreRoot, loadSqlMigrations, prepareStoreGeneration, sqliteProvider } from "@barry-rocks/sdk/internal/stores";
import { managedStoreRegistry } from "../commands/db-stores.js";
import { coreProvider } from "../services/configuration/index.js";
import { migrateCandidate, storeSchemas, storeVersions } from "./schemas.js";
import { fixtureBag, fixtureRelease, repository, scratchEnvironment, sourceHome } from "./__tests__/release-home.js";
beforeEach(scratchEnvironment);
it("counts checkout schemas the same way as the release probe", async () => {
  const { registry, warning } = await managedStoreRegistry("release-check", join(process.env.BARRY_HOME!, "stores"));
  expect(warning).toBeUndefined();
  const builtin = discoverBuiltinBags(join(repository, "bags")), expected: Record<string, number> = {};
  for (const { bag, store, declaration } of registry.declarationsFor()) expected[`${bag}/${store}`] = bag === "core" ? coreProvider.migrations.length : loadSqlMigrations(join(repository, "bags", builtin.local[bag]), declaration.migrations).length;
  expect(storeSchemas(repository)).toEqual(expected);
});
it("reads the highest version across identities without changing database bytes", () => {
  const root = process.env.BARRY_HOME!, paths: string[] = [];
  for (const [identity, pragma, migration] of [["one", 2, 1], ["two", 1, 3]] as const) {
    const path = join(root, "identities", identity, "fixture/things.db");
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${pragma}; CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(${migration});`); db.close(); paths.push(path);
  }
  const bytes = paths.map(path => readFileSync(path));
  expect(storeVersions(root)).toEqual({ "fixture/things": 3 });
  expect(paths.map(path => readFileSync(path))).toEqual(bytes);
});
it("migrates only the candidate, leaving the source at its old schema", async () => {
  const { root } = await sourceHome(), source = activeStoreRoot();
  const fixture = fixtureRelease("2.0.0", { "fixture/things": 2 });
  const bag = fixtureBag(fixture.root), path = join(source, "node/fixture/things.db");
  mkdirSync(join(path, ".."), { recursive: true });
  (await sqliteProvider(loadSqlMigrations(bag, "migrations").slice(0, 1)).open(path, {})).close();
  const candidate = await prepareStoreGeneration({ root, previousId: "g1", servicesStopped: true, build: migrateCandidate(join(fixture.root, "bags")) });
  expect(storeVersions(candidate.directory)["fixture/things"]).toBe(2);
  expect(storeVersions(source)["fixture/things"]).toBe(1);
});
