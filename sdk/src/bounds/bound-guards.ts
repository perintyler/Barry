import { homedir } from "os";
import { isAbsolute, join, normalize, resolve, dirname, basename } from "path";
import { realpathSync } from "node:fs";
import { resolveUserPath } from "../tools/paths.js";

/** Resolve existing links, or the nearest existing ancestor for a new path. */
export function canonicalFilePath(path: string, requireParent = false): string {
  const expanded = resolveUserPath(path.replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, process.env.HOME ?? ""));
  try { return realpathSync(expanded); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const suffix: string[] = [basename(expanded)];
  let parent = dirname(expanded);
  while (true) {
    try { return join(realpathSync(parent), ...suffix); }
    catch (error) {
      if (requireParent || !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent)); parent = dirname(parent);
    }
  }
}

function filesystemCase(path: string): string {
  return process.platform === "darwin" ? path.toLowerCase() : path;
}

/** Canonicalize the fixed root without asking the filesystem to resolve a glob. */
function canonicalPattern(pattern: string): string {
  const expanded = expandHomePattern(pattern);
  if (!isAbsolute(expanded)) return filesystemCase(expanded);
  const wildcard = expanded.indexOf("*");
  if (wildcard === -1) return filesystemCase(canonicalFilePath(expanded));
  const slash = expanded.lastIndexOf("/", wildcard);
  return filesystemCase(canonicalFilePath(expanded.slice(0, slash) || "/") + expanded.slice(slash));
}

/** A recursive search root must not encompass a fixed denied subtree. */
export function isFileSearchDenied(path: string, deny: string[]): string | null {
  const candidate = filesystemCase(canonicalFilePath(path)).replace(/\/+$/, "");
  for (const pattern of deny) {
    const expanded = expandHomePattern(pattern);
    // An unanchored pattern may occur anywhere below a recursive search.
    if (!isAbsolute(expanded)) return pattern;
    const wildcard = expanded.indexOf("*");
    const partialSegment = wildcard >= 0 && (expanded[wildcard - 1] !== "/" || !/^\*{1,2}(?:\/|$)/.test(expanded.slice(wildcard)));
    const prefix = (partialSegment ? expanded.slice(0, expanded.lastIndexOf("/", wildcard)) : expanded.split("*")[0]).replace(/\/+$/, "") || "/";
    if (!prefix) continue;
    const root = filesystemCase(canonicalFilePath(prefix));
    if (root === candidate || root.startsWith(candidate + "/") || partialSegment && candidate.startsWith(root.replace(/\/+$/, "") + "/")) return pattern;
  }
  return null;
}

/**
 * Expand a leading `~` in a PATTERN to the home directory.
 *
 * Candidates are normalized to absolute paths before matching, so a literal
 * `~` in a pattern never matches anything — `~/.ssh/**` would silently
 * deny/read nothing.
 */
function expandHomePattern(pattern: string): string {
  if (pattern === "~" || pattern.startsWith("~/")) {
    return join(homedir(), pattern.slice(1));
  }
  return pattern;
}

/**
 * One file-bound pattern against one path. Patterns support:
 *   - Exact prefix: "secrets/" matches "secrets/key.pem"
 *   - Wildcard extension: "*.env" matches "prod.env", "path/to/.env"
 *   - Double-star prefix: a recursive secret pattern matches "a/b/secret"
 */
function matchesFilePattern(filePath: string, pattern: string): boolean {
  filePath = filesystemCase(canonicalFilePath(filePath));
  const p = canonicalPattern(pattern);
  if (p.startsWith("*.")) {
    // Extension match: "*.env" → any path ending with ".env"
    const ext = p.slice(1); // ".env"
    return filePath.endsWith(ext);
  }
  if (p.endsWith("/**") || p.endsWith("/*")) {
    // Directory match: "secrets/**" → anything under "secrets/".
    // A leading "**/" means "at any depth", so strip it rather than
    // matching it literally — no real path contains the characters "**".
    const dir = p.replace(/\/\*+$/, "/").replace(/^\*\*\//, "");
    return filePath.includes(dir) || filePath === dir.replace(/\/$/, "") || filePath.endsWith("/" + dir.replace(/\/$/, ""));
  }
  if (p.includes("*")) {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(escaped).test(filePath);
  }
  return filePath.includes(p);
}

/**
 * Check if a file path matches any deny pattern. Returns the matching
 * pattern, or null when nothing denies it.
 */
export function isFileDenied(filePath: string, deny: string[]): string | null {
  for (const pattern of deny) {
    if (matchesFilePattern(filePath, pattern)) return pattern;
  }
  return null;
}

/** A glob over whole path segments: `*` stays inside one segment, `**` crosses them. */
function segmentGlob(glob: string): string {
  return glob
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
}

/**
 * One allowOnly pattern against one path. Unlike a deny pattern, which may
 * over-match because that only denies more, an allow pattern must name exactly
 * the paths it allows: an absolute (or `~/`) pattern is a root the path must
 * sit at or under, after `..` is resolved, so `/a/b/**` admits neither
 * `/tmp/a/b/x` nor `/a/b/../c`. A relative pattern resolves against the process cwd, so it cannot admit
 * an unrelated src directory elsewhere on the host.
 */
function allowsPath(filePath: string, pattern: string): boolean {
  filePath = filesystemCase(canonicalFilePath(filePath));
  const expanded = expandHomePattern(pattern);
  const p = canonicalPattern(isAbsolute(expanded) ? expanded : resolve(expanded));
  if (p.startsWith("*.")) return filePath.endsWith(p.slice(1));
  const root = p.replace(/\/\*+$/, "").replace(/\/+$/, "");
  const glob = segmentGlob(root);
  if (isAbsolute(p)) {
    if (!isAbsolute(filePath)) return false;
    return new RegExp(`^${glob}(/.*)?$`).test(normalize(filePath).replace(/(.)\/$/, "$1"));
  }
  return new RegExp(`(^|/)${glob.replace(/^\.\*\//, "")}(/|$)`).test(filePath);
}

/**
 * Check if a file path matches any allowOnly pattern. Returns the matching
 * pattern, or null when NOTHING allows it — under an allowOnly bound that
 * null is a denial, and the caller treats it as one.
 */
export function isFileAllowed(filePath: string, allowOnly: string[]): string | null {
  for (const pattern of allowOnly) {
    if (allowsPath(filePath, pattern)) return pattern;
  }
  return null;
}

/**
 * Check if a bash command matches any deny pattern.
 * Patterns are substrings matched against the command string.
 */
export function isBashDenied(command: string, deny: string[]): string | null {
  for (const pattern of deny) {
    if (command.includes(pattern)) return pattern;
  }
  return null;
}

// Re-export network guards from their module so consumers can import from
// either bound-guards or network-classifier.
export { isDomainDenied, isNetworkActionDenied } from "./network-classifier.js";
