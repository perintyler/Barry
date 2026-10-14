import path from "node:path";
import { pathLike } from "./path-like.mjs";

/** Concrete install instructions and digest inputs, including the retired root. */
export function installPathProblems(source, relative, rootEntries, tracked, repoRoot) {
  const roots = new Set([...rootEntries, "runtime"]);
  const problems = [];
  const check = (value, line) => {
    if (pathLike(value, roots) && !tracked(path.join(repoRoot, value))) problems.push(`${relative}:${line}: install path "${value}" is not tracked`);
  };
  let fenced = false;
  source.split("\n").forEach((line, index) => {
    if (relative.endsWith(".md")) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
      if (!fenced || /^\s*#/.test(line)) return;
      // A vitest path is relative to pnpm's selected workspace, not repo root.
      const workspaceTest = /\bpnpm\s+--dir\s+([\w/-]+)\s+exec\s+vitest\s+run\s+([^\s]+)/.exec(line);
      if (workspaceTest && !workspaceTest[2].startsWith("-")) check(path.posix.join(workspaceTest[1], workspaceTest[2]), index + 1);
      for (const word of line.split(/\s+/)) check(word.replace(/^["'`(]+|["'`),;]+$/g, ""), index + 1);
      return;
    }
    // git ls-files digest scopes are otherwise silently ignored by Git when gone.
    if (/execFileSync\(\s*["']git["']\s*,/.test(line) && /["']ls-files["']/.test(line)) {
      for (const match of line.matchAll(/["']([^"']+)["']/g)) check(match[1], index + 1);
    }
    // Parenthesized source paths in documentation comments name runnable helpers.
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) {
      for (const match of line.matchAll(/\(([\w./-]+\.(?:ts|mts|js|mjs))\)/g)) check(match[1], index + 1);
    }
  });
  return problems;
}
