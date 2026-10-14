// Adapted from the pinned barry-devops checks for the single SDK package.
/** Validate tracked files and their parent directories; ignored leftovers cannot satisfy references. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function trackedPaths(repoRoot) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tracked = new Set();
  for (const file of out.split("\0").filter(Boolean)) {
    if (!existsSync(path.join(repoRoot, file))) continue;
    tracked.add(file);
    for (let dir = path.posix.dirname(file); dir !== "." && !tracked.has(dir); dir = path.posix.dirname(dir)) {
      tracked.add(dir);
    }
  }
  return (abs) => {
    const rel = path.relative(repoRoot, abs);
    if (rel === "") return true;
    if (rel.startsWith("..") || path.isAbsolute(rel)) return existsSync(abs);
    return tracked.has(rel.split(path.sep).join("/"));
  };
}
