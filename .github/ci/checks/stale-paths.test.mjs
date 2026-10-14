import assert from "node:assert/strict";
import test from "node:test";
import { installPathProblems } from "./install-path-references.mjs";

// Exact contexts repaired by 311313baa2ae2b2979e63db5c22c6f2ac7a10c86.
// Stored here so shallow CI checkouts can run the historical negative control.
const cases = [
  { file: "cli/scripts/acceptance/README.md", before: "node --import tsx runtime/scripts/acceptance/verify-services.ts run /private/tmp/barry-acceptance-services", bad: "runtime/scripts/acceptance/verify-services.ts", good: "cli/scripts/acceptance/verify-services.ts" },
  { file: "cli/scripts/acceptance/README.md", before: "pnpm --dir sdk exec vitest run test/acceptance/identity-policy.test.ts", bad: "sdk/test/acceptance/identity-policy.test.ts", good: "cli/test/acceptance/identity-policy.test.ts" },
  { file: "bags/workflows/src/load-probe.ts", before: 'const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z", "sdk", "bags/workflows", "sdk/src/auth/workflow-actor.ts", "sdk/src/nodes", "sdk/src/stores/context.ts", "runtime/src/mcp/index.ts", "pnpm-lock.yaml"], { encoding: "utf8" })', bad: "runtime/src/mcp/index.ts", good: "bags/mcp/src/index.ts" },
  { file: "cli/src/bags/registration.ts", before: " * (runtime/scripts/cli/seed-bag-registry.mts) runs it standalone for repair.", bad: "runtime/scripts/cli/seed-bag-registry.mts", good: "cli/scripts/seed-bag-registry.mts" },
];
const roots = new Set(["cli", "sdk", "bags"]);
const root = "/fixture";
const valid = new Set(cases.map(entry => `${root}/${entry.good}`));
for (const value of ["sdk/src/auth/workflow-actor.ts", "sdk/src/nodes", "sdk/src/stores/context.ts", "bags/workflows"]) valid.add(`${root}/${value}`);
const check = (source, file) => installPathProblems(file.endsWith(".md") ? `\`\`\`sh\n${source}\n\`\`\`` : source, file, roots, target => valid.has(target), root);
for (const entry of cases) test(`detects historical ${entry.bad} and accepts its correction`, () => {
  assert.ok(check(entry.before, entry.file).some(problem => problem.includes(entry.bad)));
  const corrected = entry.before.startsWith("pnpm --dir sdk") ? entry.before.replace("--dir sdk", "--dir cli") : entry.before.replace(entry.bad, entry.good);
  assert.deepEqual(check(corrected, entry.file), []);
});
test("external links, placeholders and non-command prose are not guessed as install paths", () => {
  assert.deepEqual(installPathProblems("See runtime/scripts/example.ts outside a code block.", "docs/install.md", roots, target => valid.has(target), root), []);
  assert.deepEqual(check("node https://example.com/path\nnode cli/<helper>.ts\n# node runtime/missing.ts", "docs/install.md"), []);
});
