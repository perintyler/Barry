import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { workspaceManifests } from "./workspace-manifests.mjs";
import { packageNameFor } from "./package-names.mjs";

export function workspaceEntries(packages) {
  return Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)).map(([directory, manifest]) => {
    const compiled = typeof manifest.exports?.["."]?.import === "string" && manifest.exports["."].import.startsWith("./dist/");
    return [directory, {
      name: packageNameFor(directory),
      class: existsSync(`${directory}/bag.yaml`) ? "bag" : "internal-package",
      ...(compiled ? { mode: "compiled" } : {}),
    }];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = JSON.stringify(workspaceEntries(workspaceManifests()), null, 2) + "\n";
  if (process.argv.includes("--write")) writeFileSync("workspace-entries.json", text);
  else if (readFileSync("workspace-entries.json", "utf8") !== text) {
    console.error("Workspace inventory is stale; run pnpm workspace:generate"); process.exitCode = 1;
  } else console.log("Workspace inventory matches the discovered tree");
}
