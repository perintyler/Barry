import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runWithEnv } from "./run-cli.js";

const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "barry-provider-cli-")); roots.push(home);
  const path = join(home, "package"); mkdirSync(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({
    name: "@fixture/completion", version: "1.0.0", type: "module",
    exports: { ".": { import: "./index.js" } },
    barry: { modelProvider: { contractVersion: 1, factoryExport: "FACTORIES" } },
  }));
  writeFileSync(join(path, "index.js"), "export const FACTORIES = { completion: { fixture: () => ({}) } };\n");
  const run = (...args: string[]) => runWithEnv({ BARRY_HOME: home }, "adapter", "model", ...args);
  return { home, path, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("selects, lists, checks and removes a model provider through the real CLI", () => {
  const { home, path, run } = fixture();
  const added = run("add", path); expect(added.stderr, added.stdout).not.toContain("Error:"); expect(added.exitCode).toBe(0);
  const file = join(home, "app-support", "model-providers.json");
  expect(JSON.parse(readFileSync(file, "utf8"))[0].packageName).toBe("@fixture/completion");
  const listed = run("list"); expect(listed.exitCode).toBe(0); expect(listed.stdout).toContain("@fixture/completion");
  expect(run("check").exitCode).toBe(0);
  expect(run("remove", "@fixture/completion").exitCode).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  expect(existsSync(join(path, "index.js"))).toBe(true);
});
it("rejects a non-provider package without creating a selection", () => {
  const { home, path, run } = fixture(); writeFileSync(join(path, "package.json"), '{"name":"ordinary","version":"1.0.0"}');
  const result = run("add", path); expect(result.exitCode).toBe(1); expect(result.stderr).toContain("unsupported model provider contract");
  expect(existsSync(join(home, "app-support", "model-providers.json"))).toBe(false);
});
