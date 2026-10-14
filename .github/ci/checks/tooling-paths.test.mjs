import assert from "node:assert/strict";
import test from "node:test";
import { toolingPathProblems } from "./tooling-paths.mjs";

test("missing concrete negation targets cannot silently unignore nothing", () => {
  assert.equal(toolingPathProblems(".gitignore", ["!gone/source/**"], () => false).length, 1);
  assert.deepEqual(toolingPathProblems(".gitignore", ["!*secret*.ts", "!bags/backups/**"], p => p === "bags/backups"), []);
});
test("tsconfig include prefixes resolve relative to the declaring project", () => {
  assert.deepEqual(toolingPathProblems("sdk/tsconfig.json", ["src/**/*.ts"], p => p === "sdk/src"), []);
  assert.equal(toolingPathProblems("tsconfig.eslint.json", ["runtime/**/*.test.ts"], () => false).length, 1);
});
