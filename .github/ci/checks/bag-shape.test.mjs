import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bagShapeProblems } from "./bag-shape.mjs";

test("bag shape accepts a source-owned store and rejects the original drift", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-bag-shape-"));
  try {
    const bag = join(root, "bags/example"); mkdirSync(bag, { recursive: true });
    const write = (name, text) => writeFileSync(join(bag, name), text);
    const packages = { "bags/example": { scripts: { typecheck: "tsc --noEmit" } } };
    const mappings = [{ directory: "bags/example/migrations/example", output: "bags/example/src/generated/example-migrations.ts" }];
    write("bag.yaml", "name: example\nstores:\n  example:\n    migrations: ./migrations/example\n");
    write("README.md", "Example\n"); write("tsconfig.json", '{"extends":"../../tsconfig.base.json"}');
    write("tools.ts", `export * ${"from"} "./src/tools.js";`);
    assert.deepEqual(bagShapeProblems(root, packages, mappings), []);
    write("bag.yaml", "name: example\nversion: v0.1\nstore: {}\n");
    write("tools.ts", "export const tool = () => 1;");
    write("vitest.config.ts", `export {default} ${"from"} "../../vitest.base.config.js";`);
    write("tsconfig.json", '{}'); rmSync(join(bag, "README.md"));
    const problems = bagShapeProblems(root, packages, mappings).join("\n");
    for (const expected of ["plural stores", "versions are omitted", "README", "root base", "TypeScript base", "code belongs under src"]) assert.ok(problems.includes(expected), expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a second protocol SDK version and a noncanonical migration catalog fail", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-bag-shape-"));
  try {
    const bag = join(root, "bags/example"); mkdirSync(bag, { recursive: true });
    writeFileSync(join(bag, "bag.yaml"), "name: example\nstores:\n  main:\n    migrations: ./migrations/example\n");
    writeFileSync(join(bag, "README.md"), "Example"); writeFileSync(join(bag, "tsconfig.json"), '{"extends":"../../tsconfig.base.json"}');
    const packages = { "bags/example": { scripts: { typecheck: "tsc" }, dependencies: { "@modelcontextprotocol/sdk": "1" } }, "sdk": { dependencies: { "@modelcontextprotocol/sdk": "2" } } };
    const problems = bagShapeProblems(root, packages, [{ directory: "bags/example/migrations/example", output: "bags/example/src/generated/db-migrations.ts" }]);
    assert.ok(problems.some(problem => problem.includes("versions disagree")));
    assert.ok(problems.some(problem => problem.includes("example-migrations.ts")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
