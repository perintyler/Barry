import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredLabels, referenceLines, referenceProblems } from "./stale-references.mjs";

test("checks actual comments without treating quoted tool examples as comments", () => {
  const text = 'const value = "// engine/deleted.ts";\n// engine/deleted.ts\n/* ruling §8 */\n';
  const lines = referenceLines("sdk/src/example.ts", text);
  const problems = referenceProblems("sdk/src/example.ts", lines, { exists: () => false, commits: [] });
  assert.equal(problems.length, 2);
  assert.equal(problems[0].line, 2);
});
test("validates tracked paths and actual commit prefixes", () => {
  const problems = referenceProblems("README.md", [{ line: 1, text: "sdk/src/current.ts abc1234 deadbee" }], { exists: (_file, value) => value === "sdk/src/current.ts", commits: ["abc1234" + "0".repeat(33)] });
  assert.deepEqual(problems.map(problem => problem.message), ["Commit reference is absent from git history: deadbee"]);
});
test("preserves frozen review evidence while checking current plan prose", () => {
  const text = "## Why\nengine/deleted.ts\n## Tasks\nengine/missing.ts\n```ts\nengine/example.ts\n```\n";
  assert.equal(referenceLines("plans/review-resolution/review/findings.md", text).length, 0);
  const lines = referenceLines("plans/review-resolution/tier-2-this-month/13-gating.md", text);
  assert.deepEqual(referenceProblems("plan.md", lines, { exists: () => false, commits: [] }).map(problem => problem.line), [4]);
});

test("version suffixes are not bare commit references", () => {
  assert.deepEqual(referenceProblems("README.md", [{ line: 1, text: "2026.10.01-14929f9, 2026.09.23-86fc751" }], { exists: () => false, commits: [] }), []);
});

test("rejects historical citation spelling variants in real comments", () => {
  for (const label of ["research E8", "Ruling §3", "Astra review F10", "astra review SR2"]) {
    const lines = referenceLines("bags/example/src/index.ts", `// ${label}: historical observation\n`);
    const problems = referenceProblems("bags/example/src/index.ts", lines, { exists: () => false, commits: [] });
    assert.equal(problems.length, 1, label);
    assert.match(problems[0].message, /Untracked historical citation/);
  }
});

test("rejects undeclared invariant and work-package labels", () => {
  const lines = referenceLines("adapters/example.ts", "// Invariant I9\n// WP-C4\n// AP-09\n");
  const problems = referenceProblems("adapters/example.ts", lines, { exists: () => false, commits: [] });
  assert.deepEqual(problems.map(problem => problem.message), [
    "Untracked historical citation: Invariant I9",
    "Untracked historical citation: WP-C4",
    "Untracked historical citation: AP-09",
  ]);
});

test("only current explicit definitions resolve a citation", () => {
  const definitions = "**Invariant I10 — declared credentials.**\n## WP-C4: installation registry\n```text\n**Invariant I9 — historical example.**\n```\n";
  const labels = declaredLabels("adapters/README.md", definitions);
  assert.deepEqual([...labels], ["I10", "WP-C4"]);
  assert.equal(declaredLabels("plans/review-resolution/review/findings.md", definitions).size, 0);
  const lines = referenceLines("adapters/example.ts", "// Invariant I10\n// Invariant I9\n// WP-C4\n// AP-09\n");
  const problems = referenceProblems("adapters/example.ts", lines, { exists: () => false, commits: [], labels });
  assert.deepEqual(problems.map(problem => problem.message), [
    "Untracked historical citation: Invariant I9",
    "Untracked historical citation: AP-09",
  ]);
});
