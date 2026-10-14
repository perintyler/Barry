import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repository = new URL("../../../", import.meta.url);
test("the runtime pin detects drift in every declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-node-version-"));
  try {
    for (const name of [".github/ci/checks/node-version.mjs", "cli/src/services/node-runtime.json", ".node-version", "package.json", "README.md", "cli/docs/services.md"]) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      cpSync(new URL(name, repository), join(root, name));
    }
    const run = () => spawnSync(process.execPath, [join(root, ".github/ci/checks/node-version.mjs")], { encoding: "utf8" });
    assert.equal(run().status, 0);
    writeFileSync(join(root, "cli/src/services/node-runtime.json"), JSON.stringify({ version: "27.11.1" }));
    const result = run();
    assert.equal(result.status, 1);
    for (const name of [".node-version", "package.json engines.node", "README.md prerequisites", "cli/docs/services.md"]) assert.ok(result.stderr.includes(name), result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
