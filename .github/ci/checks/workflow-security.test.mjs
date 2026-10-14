import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { mirrorGuard, hasMirrorGuard } from "./mirror-workflows.mjs";

function fixture(source, quarantine = []) {
  const root = mkdtempSync(join(tmpdir(), "barry-workflow-policy-"));
  for (const dir of [".github/workflows", ".github/actions/setup", ".github/ci"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, ".github/workflows/test.yml"), source);
  writeFileSync(join(root, ".github/actions/setup/action.yml"), "runs:\n  steps:\n    - uses: ./.github/actions/local\n");
  writeFileSync(join(root, ".github/ci/quarantine.json"), JSON.stringify(quarantine));
  try { return spawnSync(process.execPath, [join(import.meta.dirname, "workflow-security.mjs")], { cwd: root, encoding: "utf8" }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const pinned = `permissions:\n  contents: read\njobs:\n  test:\n    if: ${mirrorGuard}\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n`;
test("accepts SHA pins and rejects floating tags", () => {
  assert.equal(fixture(pinned).status, 0);
  const bad = fixture(pinned.replace("a".repeat(40), "v5"));
  assert.equal(bad.status, 1); assert.match(bad.stderr, /full commit SHA/);
});
test("rejects missing permissions and expired quarantines", () => {
  assert.equal(fixture(pinned.replace("permissions:\n  contents: read\n", "")).status, 1);
  const bad = fixture(pinned, [{ test: "flake", owner: "owner", issue: "https://github.com/perintyler/barry-dev/issues/1", since: "2020-01-01" }]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /expired quarantine/);
});
test("every runner and reusable caller excludes the development repository", () => {
  const missing = fixture(pinned.replace(`    if: ${mirrorGuard}\n`, ""));
  assert.equal(missing.status, 1); assert.match(missing.stderr, /mirror-only guard/);
  assert.equal(hasMirrorGuard(`${mirrorGuard} && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')`), true);
  for (const condition of [true, false, `${mirrorGuard} || true`, `${mirrorGuard} && (false) || (true)`]) assert.equal(hasMirrorGuard(condition), false);
});
test("the canonical guard runs only outside barry-dev in a public repository", () => {
  for (const [repository, privateRepository, expected] of [
    ["perintyler/barry-dev", true, false], ["perintyler/barry-dev", false, false],
    ["owner/public-mirror", false, true], ["owner/private-fork", true, false],
  ]) assert.equal(runInNewContext(mirrorGuard, { github: { repository, event: { repository: { private: privateRepository } } } }), expected);
  assert.equal(hasMirrorGuard("github.repository != 'perintyler/barry-dev'"), false);
});
