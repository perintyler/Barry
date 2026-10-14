import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { directory, sourceHome, serviceFixture } from "../../commands/__tests__/db-home.js";
import * as specs from "../../services/specs.js";
import type { Release } from "../release.js";
export { sourceHome, serviceFixture };
export const repository = resolve(import.meta.dirname, "../../../..");
export function fixtureRelease(version = "1.0.0", stores: Record<string, number> = {}, commit = "a".repeat(40)) {
  const root = join(directory("barry-release-"), "Application Support", version);
  mkdirSync(join(root, "cli/bin"), { recursive: true });
  mkdirSync(join(root, "runtime/bin"), { recursive: true });
  cpSync(join(repository, "bin"), join(root, "bin"), { recursive: true });
  symlinkSync(process.execPath, join(root, "runtime/bin/node"));
  writeFileSync(join(root, "cli/bin/barry.js"), `console.log(process.argv.includes('--version') ? ${JSON.stringify(version)} : JSON.stringify({args:process.argv.slice(2),node:process.env.BARRY_NODE}));process.exitCode=Number(process.env.FIXTURE_EXIT ?? 0);`);
  writeFileSync(join(root, "identity.yaml"), "name: Barry\n");
  const release: Release = { version, commit, platform: "darwin-arm64", node: { version: "26.5.0", sha256: "1".repeat(64) }, stores, built: "2026-10-08T00:00:00.000Z" };
  writeFileSync(join(root, "release.json"), JSON.stringify(release));
  return { root, release };
}
export function fixtureBag(root: string, second = "ALTER TABLE things ADD COLUMN extra TEXT;") {
  const bag = join(root, "bags/fixture");
  mkdirSync(join(bag, "migrations"), { recursive: true });
  writeFileSync(join(bag, "bag.yaml"), "name: fixture\ndescription: Fixture stores\nstores:\n  things:\n    owned_by: node\n    engine: sqlite\n    migrations: migrations\n");
  writeFileSync(join(bag, "migrations/001_things.sql"), "CREATE TABLE things(value TEXT);");
  writeFileSync(join(bag, "migrations/002_extra.sql"), second);
  return bag;
}
export function scratchEnvironment() {
  vi.spyOn(specs, "checkoutCommit").mockReturnValue(undefined);
  vi.stubEnv("HOME", directory("barry-user-"));
  vi.stubEnv("BARRY_HOME", directory("barry-home-"));
}
