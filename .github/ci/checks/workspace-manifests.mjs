import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import YAML from "yaml";

/** Discover manifests from workspace globs, rather than trusting the generated inventory. */
export function workspaceManifests() {
  const patterns = YAML.parse(readFileSync("pnpm-workspace.yaml", "utf8")).packages;
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*/package.json"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const packages = {};
  for (const file of [...new Set(files)].sort()) {
    const directory = file.slice(0, -"/package.json".length);
    if (!patterns.some(pattern => !pattern.startsWith("!") && matchesGlob(directory, pattern))) continue;
    if (patterns.some(pattern => pattern.startsWith("!") && matchesGlob(directory, pattern.slice(1)))) continue;
    packages[directory] = JSON.parse(readFileSync(file, "utf8"));
  }
  return packages;
}
