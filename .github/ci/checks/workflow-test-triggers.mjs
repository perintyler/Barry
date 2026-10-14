import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { parse } from "yaml";
import { installVerifierProblems } from "./install-verifier-coverage.mjs";
import { matrixProblems } from "./workflow-matrix.mjs";

const read = file => readFileSync(file, "utf8");
const inventory = JSON.parse(read("workspace-entries.json"));
const workspaceKeys = Object.keys(inventory).filter(key => {
  const scripts = JSON.parse(read(`${key}/package.json`)).scripts ?? {};
  return Boolean(scripts.test || scripts["test:unit"] || scripts["test:ci:unit"]);
});
const failures = matrixProblems(parse(read(".github/workflows/test.yml")), workspaceKeys);
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const sources = [];
for (const name of readdirSync(".github/workflows").filter(name => /\.ya?ml$/.test(name))) {
  const source = read(`.github/workflows/${name}`); sources.push(source);
  const document = parse(source);
  for (const trigger of document.on?.push?.paths ?? []) if (!tracked.some(file => matchesGlob(file, trigger))) failures.push(`${name}: trigger ${trigger} selects no tracked file`);
}
failures.push(...installVerifierProblems(read(".github/workflows/test-install.yml")));
const runbook = read("cli/scripts/acceptance/README.md");
for (const directory of ["cli/scripts", "cli/scripts/acceptance"]) for (const name of readdirSync(directory)) {
  if (!(directory.endsWith("acceptance") ? name.endsWith(".ts") : /^verify-.*\.ts$/.test(name))) continue;
  const file = `${directory}/${name}`;
  if (![...sources, runbook].some(source => source.includes(file))) failures.push(`${file}: no workflow or acceptance runbook runs this verifier`);
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Workflow matrix covers ${workspaceKeys.length} test-bearing workspaces; trigger and install-verifier inventory valid.`);
