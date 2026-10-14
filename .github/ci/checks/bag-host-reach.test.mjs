import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bagSourceFiles, checkBagImports } from "./bag-host-reach.mjs";
const packages = new Map([
  ["@barry-rocks/actions-bag", { dir: "bags/actions" }],
  ["@barry-rocks/events-bag", { dir: "bags/events" }],
  ["@barry-rocks/artifacts-bag", { dir: "bags/artifacts" }],
  ["@barry-rocks/scheduler-service", { dir: "bags/schedules/scheduler" }],
]);
const scan = (source, path = "bags/actions/src/test.ts", map = packages) => checkBagImports(map, [{ path, source }]);
test("a cross-bag import fails", () => assert.equal(scan('import { events } from "@barry-rocks/events-bag";').length, 1));
test("a composition root may import a bag", () => assert.deepEqual(scan('import { events } from "@barry-rocks/events-bag";', "bags/schedules/scheduler/src/service.ts"), []));
test("the named artifacts exception passes", () => assert.deepEqual(scan('export { createArtifact } from "@barry-rocks/artifacts-bag";'), []));
test("a relative escape fails", () => assert.ok(scan('import "../../events/src/index.js";').length));
test("a Vitest mock fails", () => {
  for (const method of ["mock", "doMock"]) assert.equal(scan(`vi.${method}("@barry-rocks/events-bag", () => ({}));`).length, 1);
});
test("a bag cannot import a composition root", () => assert.equal(scan('import("@barry-rocks/scheduler-service");').length, 1));
test("dependencies and devDependencies are checked", () => {
  for (const field of ["dependencies", "devDependencies"]) {
    const map = new Map(packages); map.set("@barry-rocks/actions-bag", { dir: "bags/actions", [field]: { "@barry-rocks/events-bag": "workspace:*" } });
    assert.equal(scan("", undefined, map).length, 1);
  }
});
test("a relative import into CLI or adapters fails", () => {
  for (const dir of ["cli", "adapters"]) assert.equal(scan(`import "../../../${dir}/index.js";`).length, 1);
});

test("re-exports, require and literal dynamic imports are checked", () => {
  for (const source of ['export * from "@barry-rocks/events-bag";', 'require("@barry-rocks/events-bag");', 'import(`@barry-rocks/events-bag`);']) assert.equal(scan(source).length, 1);
});

test("bag sources are listed where ripgrep is not installed", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const bin = mkdtempSync(join(tmpdir(), "bag-host-reach-path-"));
  const path = process.env.PATH;
  try {
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    process.env.PATH = bin;
    const files = bagSourceFiles(root);
    assert.ok(files.includes("bags/actions/src/subject.ts"));
    assert.ok(files.every(file => file.startsWith("bags/") && !/(?:^|\/)(?:node_modules|dist)\//.test(file)));
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("the search extension may reach the embeddings library, and nothing else may", () => {
  const map = new Map(packages);
  map.set("@barry-rocks/embeddings-bag", { dir: "bags/embeddings" });
  map.set("@barry-rocks/sessions-bag", { dir: "bags/sessions" });
  map.set("@barry-rocks/search-bag", { dir: "bags/sessions/extensions/search" });
  const source = 'import { embedOne } from "@barry-rocks/embeddings-bag/embed";';
  assert.deepEqual(scan(source, "bags/sessions/extensions/search/src/tools.ts", map), []);
  // Only from the extension: its parent and other bags still fail.
  assert.equal(scan(source, "bags/sessions/src/tools.ts", map).length, 1);
  assert.equal(scan(source, "bags/actions/src/tools.ts", map).length, 1);
  // Only to embeddings: the extension reaching any other bag still fails.
  assert.equal(scan('import { events } from "@barry-rocks/events-bag";', "bags/sessions/extensions/search/src/tools.ts", map).length, 1);
});
