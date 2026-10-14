#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [task, ...args] = process.argv.slice(2);
if (!task) {
  console.error("Usage: node .github/ci/run.mjs <task> [args...]");
  process.exit(2);
}
if (task === "check:monorepo") {
  const licenses = spawnSync(process.execPath, [join(repoRoot, ".github/ci/checks/workspace-licenses.mjs")], { cwd: repoRoot, stdio: "inherit" });
  if (licenses.status !== 0) process.exit(licenses.status ?? 1);
}
// Repository layout checks follow the single SDK contract; generic checks remain pinned.
const localChecks = { "check:stale-references": "stale-references.mjs", "check:monorepo": "monorepo.mjs", "check:prompt-instructions": "prompt-instructions.mjs", "check:node-version": "node-version.mjs", "check:workflow-security": "workflow-security.mjs", "check:bag-data-dirs": "bag-data-dirs.mjs", "check:service-addresses": "service-addresses.mjs", "check:stale-paths": "stale-paths.mjs", "check:doc-links": "doc-links.mjs", "check:bag-host-reach": "bag-host-reach.mjs", "check:barry-home": "barry-home.mjs", "check:vendor-neutral": "vendor-neutral.mjs", "check:workflow-triggers": "workflow-test-triggers.mjs", "check:package-consumers": "sdk-consumers.mjs" };
if (task === "check:doc-links") {
  const bags = spawnSync(process.execPath, [join(repoRoot, ".github/ci/checks/readme-bags.mjs")], { cwd: repoRoot, stdio: "inherit" });
  if (bags.status !== 0) process.exit(bags.status ?? 1);
  const inventory = spawnSync(process.execPath, [join(repoRoot, ".github/ci/checks/verification-inventory.mjs")], { cwd: repoRoot, stdio: "inherit" });
  if (inventory.status !== 0) process.exit(inventory.status ?? 1);
}
if (localChecks[task]) {
  const result = spawnSync(process.execPath, [join(repoRoot, ".github/ci/checks", localChecks[task]), ...args], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (["check:prompt-instructions", "check:service-addresses", "check:bag-data-dirs", "check:bag-host-reach", "check:workflow-triggers", "check:stale-paths", "check:node-version", "check:workflow-security", "check:stale-references"].includes(task) && result.status === 0) {
    const files = [join(repoRoot, `.github/ci/checks/${localChecks[task].replace(".mjs", ".test.mjs")}`)];
    if (task === "check:workflow-triggers") files.push(join(repoRoot, ".github/ci/checks/workflow-matrix.test.mjs"));
    if (task === "check:stale-paths") files.push(join(repoRoot, ".github/ci/checks/tooling-paths.test.mjs"));
    if (task === "check:workflow-security") files.push(join(repoRoot, ".github/ci/validate-release-health.test.mjs"), join(repoRoot, ".github/ci/render-release-formula.test.mjs"));
    const tests = spawnSync(process.execPath, ["--test", ...files], { cwd: repoRoot, stdio: "inherit" });
    process.exit(tests.status ?? 1);
  }
  process.exit(result.status ?? 1);
}

// An explicit upstream checkout is opt-in; a fresh clone uses reviewed vendored bytes.
const devopsRoot = process.env.BARRY_DEVOPS_DIR ? resolve(process.env.BARRY_DEVOPS_DIR) : join(repoRoot, ".github/ci/vendor");
const runner = join(devopsRoot, "checks/run.mjs");
if (!existsSync(runner)) throw new Error(`Checks runner missing at ${runner}`);
const checked = spawnSync(process.execPath, [runner, repoRoot, task, ...args], { cwd: repoRoot, stdio: "inherit" });
if (checked.error) console.error(checked.error.message);
process.exitCode = checked.status ?? 1;
