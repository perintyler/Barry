import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { workspaceManifests } from "./workspace-manifests.mjs";
import { packageNameProblems } from "./package-names.mjs";

const assets = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "assets"], { encoding: "utf8" }).split("\0").filter(Boolean);
const invalid = assets.filter(file => /[^\x20-\x7e]|\s/.test(file));
if (invalid.length) { console.error(`Artwork names must be ASCII without spaces:\n${invalid.join("\n")}`); process.exit(1); }
const naming = packageNameProblems(workspaceManifests());
if (naming.length) { console.error(naming.join("\n")); process.exit(1); }
const inventory = spawnSync(process.execPath, [".github/ci/checks/workspace-entries.mjs"], { stdio: "inherit" });
if (inventory.status !== 0) process.exit(inventory.status ?? 1);
const root = process.env.BARRY_DEVOPS_DIR ? resolve(process.env.BARRY_DEVOPS_DIR) : resolve(".github/ci/vendor");
const result = spawnSync(process.execPath, [resolve(root, "checks/run.mjs"), process.cwd(), "check:monorepo"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
