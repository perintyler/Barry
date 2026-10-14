import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { packageNameFor, packageNameProblems } from "./package-names.mjs";

test("bag, adapter and composition-root roles have deterministic names", () => {
  equal(packageNameFor("bags/sessions"), "@barry-rocks/sessions-bag");
  equal(packageNameFor("bags/filesystem/tracker"), "@barry-rocks/tracker-bag");
  equal(packageNameFor("bags/sessions/extensions/search"), "@barry-rocks/search-bag");
  equal(packageNameFor("adapters/sessions/codex"), "@barry-rocks/session-codex");
  equal(packageNameFor("adapters/completions/anthropic"), "@barry-rocks/completion-anthropic");
  equal(packageNameFor("bags/identities/server"), "@barry-rocks/identities-service");
  equal(packageNameFor("bags/workflows/runtime"), "@barry-rocks/workflows-runtime");
  equal(packageNameFor("bags/schedules/scheduler"), "@barry-rocks/scheduler-service");
});
test("misnamed and misleadingly versioned private packages fail", () => {
  equal(packageNameProblems({ "bags/decisions": { name: "@barry-bags/decisions", private: true, version: "1.0.0" } }).length, 2);
  deepEqual(packageNameProblems({ "bags/decisions": { name: "@barry-rocks/decisions-bag", private: true, version: "0.0.0" } }), []);
});
test("a leaf-name collision fails instead of generating ambiguous imports", () => {
  equal(packageNameProblems({ "bags/a/shared": { name: "@barry-rocks/shared-bag" }, "bags/b/shared": { name: "@barry-rocks/shared-bag" } }).length, 1);
});
