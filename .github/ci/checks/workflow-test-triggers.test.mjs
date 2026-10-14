import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installVerifierProblems } from "./install-verifier-coverage.mjs";
import { mirrorGuard } from "./mirror-workflows.mjs";

const actual = readFileSync(new URL("../../workflows/test-install.yml", import.meta.url), "utf8");
test("the install gate executes both required verifiers", () => assert.deepEqual(installVerifierProblems(actual), []));
for (const script of ["verify-install.ts", "verify-nodes.ts"]) test(`removing ${script} fails despite a comment or another job mentioning it`, () => {
  const command = `node --import tsx cli/scripts/${script}`;
  const changed = actual.replace(`run: ${command}`, `run: echo skipped\n        # ${command}`) + `\n  unrelated:\n    steps:\n      - run: ${command}\n`;
  assert.deepEqual(installVerifierProblems(changed), [`test-install.yml: disposable job must run ${command} unconditionally`]);
});
test("a conditional verifier cannot certify every disposable run", () => {
  const changed = actual.replace("run: node --import tsx cli/scripts/verify-nodes.ts", "if: false\n        run: node --import tsx cli/scripts/verify-nodes.ts");
  assert.equal(installVerifierProblems(changed).length, 1);
});
test("a disabled disposable job cannot certify installation", () => {
  assert.equal(installVerifierProblems(actual.replace(`    if: ${mirrorGuard}`, "    if: false")).length, 2);
});
for (const replacement of ["continue-on-error: true\n        run: node --import tsx cli/scripts/verify-nodes.ts", "run: node --import tsx cli/scripts/verify-nodes.ts || true"]) test(`swallowing a verifier failure is refused: ${replacement.split("\n")[0]}`, () => {
  assert.equal(installVerifierProblems(actual.replace("run: node --import tsx cli/scripts/verify-nodes.ts", replacement)).length, 1);
});
