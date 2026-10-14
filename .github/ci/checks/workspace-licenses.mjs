import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const entries = JSON.parse(readFileSync(resolve(root, "workspace-entries.json"), "utf8"));
const directories = [".", ...Object.keys(entries)].filter(directory => existsSync(resolve(root, directory, "package.json")));
const errors = [];
for (const directory of directories) {
  const manifest = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
  if (typeof manifest.license !== "string" || !manifest.license.trim()) {
    errors.push(`${directory}: package.json must declare a license`);
    continue;
  }
  const file = manifest.license.match(/^SEE LICENSE IN (.+)$/)?.[1];
  if (!file) continue;
  const target = resolve(root, directory, file);
  // Generated local copies are prepared by the same explicit prepack helper;
  // source metadata still names the exact file that consumers receive.
  const prepack = manifest.scripts?.prepack ?? "";
  if (file === "LICENSE.md" && prepack.includes(".github/ci/prepare-package-license.mjs")) {
    const result = spawnSync(process.execPath, [resolve(root, ".github/ci/prepare-package-license.mjs"), resolve(root, directory)], { stdio: "inherit" });
    if (result.status !== 0) errors.push(`${directory}: license preparation failed`);
  }
  if (!existsSync(target) || !statSync(target).isFile()) errors.push(`${directory}: license reference does not resolve: ${file}`);
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`Workspace license references OK (${directories.length} manifests).`);
