import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-checks-local-"));
  mkdirSync(join(root, ".github/ci/vendor/checks"), { recursive: true });
  cpSync(join(import.meta.dirname, "run.mjs"), join(root, ".github/ci/run.mjs"));
  writeFileSync(join(root, ".github/ci/vendor/checks/run.mjs"), 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(process.argv[3] === "fail" ? 7 : 0);\n');
  const env = { ...process.env }; delete env.BARRY_DEVOPS_DIR;
  const run = (args, override = {}) => spawnSync(process.execPath, [join(root, ".github/ci/run.mjs"), ...args], { env: { ...env, ...override }, cwd: tmpdir(), encoding: "utf8" });
  return { root, run };
}
test("a fresh clone runs without git, credentials, or a fetch and preserves failures", () => {
  const f = fixture();
  try {
    const result = f.run(["test:ci:unit", "--scope=sdk"], { PATH: "/nonexistent" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /test:ci:unit.*--scope=sdk/);
    assert.equal(f.run(["fail"]).status, 7);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("an explicit upstream override must contain a runner", () => {
  const f = fixture();
  try {
    const result = f.run(["test:ci:unit"], { BARRY_DEVOPS_DIR: f.root });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /runner missing/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
