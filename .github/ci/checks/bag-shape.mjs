import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import ts from "typescript";
import { workspaceManifests } from "./workspace-manifests.mjs";

export function bagShapeProblems(root, packages, mappings) {
  const problems = [];
  const protocolVersions = new Set();
  for (const [directory, manifest] of Object.entries(packages)) {
    for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
      if (dependencies?.["@modelcontextprotocol/sdk"]) protocolVersions.add(dependencies["@modelcontextprotocol/sdk"]);
    }
    const bagRoot = resolve(root, directory);
    if (!existsSync(resolve(bagRoot, "bag.yaml"))) continue;
    const bag = YAML.parse(readFileSync(resolve(bagRoot, "bag.yaml"), "utf8"));
    if ("store" in bag) problems.push(`${directory}: use plural stores`);
    if ("version" in bag) problems.push(`${directory}: first-party bag versions are omitted; private package versions are canonical`);
    if (!existsSync(resolve(bagRoot, "README.md"))) problems.push(`${directory}: README.md is required`);
    if (!manifest.scripts?.typecheck) problems.push(`${directory}: typecheck script is required`);
    const config = resolve(bagRoot, "tsconfig.json");
    if (!existsSync(config) || resolve(bagRoot, JSON.parse(readFileSync(config, "utf8")).extends ?? "") !== resolve(root, "tsconfig.base.json")) {
      problems.push(`${directory}: tsconfig must extend the root base`);
    }
    const vitest = resolve(bagRoot, "vitest.config.ts");
    if (existsSync(vitest) && !readFileSync(vitest, "utf8").includes("vitest.base.config.ts")) problems.push(`${directory}: vitest config must import the TypeScript base`);
    for (const filename of readdirSync(bagRoot)) {
      if (!filename.endsWith(".ts") || filename.endsWith(".config.ts")) continue;
      const source = ts.createSourceFile(filename, readFileSync(resolve(bagRoot, filename), "utf8"), ts.ScriptTarget.Latest, true);
      if (source.statements.some(statement => !ts.isExportDeclaration(statement))) problems.push(`${directory}/${filename}: executable code belongs under src; root entries only re-export`);
    }
    for (const [store, declaration] of Object.entries(bag.stores ?? {})) {
      if (!declaration.migrations) continue;
      const mapping = mappings.find(entry => resolve(root, entry.directory) === resolve(bagRoot, declaration.migrations));
      if (!mapping) { problems.push(`${directory}/${store}: missing compiled migration mapping`); continue; }
      // Host-owned peers and workflow catalogs are compiled into the SDK that executes them.
      if (mapping.output.startsWith("sdk/src/") && ["bags/nodes", "bags/workflows"].includes(directory)) continue;
      const expected = `${directory}/src/generated/${relative(dirname(resolve(bagRoot, declaration.migrations)), resolve(bagRoot, declaration.migrations))}-migrations.ts`;
      if (mapping.output !== expected) problems.push(`${directory}/${store}: expected generated catalog ${expected}`);
    }
  }
  if (protocolVersions.size > 1) problems.push(`MCP SDK versions disagree: ${[...protocolVersions].join(", ")}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = bagShapeProblems(process.cwd(), workspaceManifests(), JSON.parse(readFileSync("sdk/scripts/store-migrations.json", "utf8")));
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else console.log("First-party bag contract verified");
}
