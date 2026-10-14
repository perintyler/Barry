/**
 * Turn a bound into Node permission-model flags, for a bounded `node` job.
 *
 * Under `node --permission` a process may read only its own entry file and
 * may not write, spawn a child, start a worker, load an addon or open a
 * socket until a flag allows it. So a bound maps onto flags only where Node
 * can say the same thing, and every other restriction is REFUSED rather than
 * approximated — a bound that is silently weaker than it reads is worse than
 * a job that does not start.
 *
 * What maps (checked on Node 26.9):
 *
 * - `files.allowOnly` paths → `--allow-fs-read` / `--allow-fs-write` for each.
 *   A directory grants everything under it, so `/dir`, `/dir/*` and
 *   `/dir/**` all become `/dir`. `~/` is the home directory. An empty list
 *   grants no files at all. Without `allowOnly` the job may touch any file.
 * - `deniedAccess: [write]` → no `--allow-fs-write`.
 * - Node matches a grant against the path as the job spells it, without
 *   following symlinks (`/var` is `/private/var` on macOS), so a path that
 *   resolves elsewhere is granted under both spellings — the same file.
 * - Child processes, workers, addons and WASI are never granted, so a job
 *   cannot step outside the permission model; that also holds every `bash.*`
 *   restriction, since a job that cannot start a process runs no command.
 *
 * What is refused:
 *
 * - any `network.*` — Node's switch is all or nothing, and a job gets the
 *   network in v1 (`--allow-net`);
 * - `files.deny` — Node grants, it cannot carve an exception out of a grant;
 * - `allowOnly` patterns Node cannot express: relative paths, `*.ext`,
 *   `**` anywhere but the end, or any other wildcard.
 *
 * Tool restrictions (`deniedTools`, `nativeTools`) are about MCP tools and
 * harness tools, which a job process has neither of, and `nodes` is
 * placement, decided before a job runs anywhere; none of them change flags.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { Bound } from "../bounds/types.js";

export type NodeFlags = { flags: string[] } | { refused: string };

/** The directory or file a single allowOnly pattern names, or why Node cannot express it. */
function patternPath(pattern: string, home: string): { path: string } | { refused: string } {
  let path = pattern === "~" ? home : pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
  path = path.replace(/\/\*\*?$/, "");
  if (!isAbsolute(path)) return { refused: `files.allowOnly "${pattern}" is not an absolute or ~/ path` };
  if (/[*?[\]{}]/.test(path)) return { refused: `files.allowOnly "${pattern}" uses a wildcard Node's permission model cannot express` };
  return { path: normalize(path) };
}

function resolvedPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function boundToNodeFlags(bound: Bound | null | undefined, home = homedir(), realpath: (path: string) => string | undefined = resolvedPath): NodeFlags {
  const network = bound?.network;
  if (network && (network.actions?.length || network.domains?.length || network.allowDomains !== undefined || network.enforce !== undefined)) {
    return { refused: "a network restriction cannot be enforced on a node job yet; a job's network is all or nothing" };
  }
  if (bound?.files?.deny?.length) {
    return { refused: "files.deny cannot be enforced on a node job; name what it may touch with files.allowOnly instead" };
  }
  const write = !bound?.deniedAccess?.includes("write");
  const flags = ["--permission", "--allow-net"];
  const allowOnly = bound?.files?.allowOnly;
  if (allowOnly === undefined) {
    flags.push("--allow-fs-read=*");
    if (write) flags.push("--allow-fs-write=*");
    return { flags };
  }
  for (const pattern of allowOnly) {
    const resolved = patternPath(pattern, home);
    if ("refused" in resolved) return resolved;
    const real = realpath(resolved.path);
    for (const path of real && real !== resolved.path ? [resolved.path, real] : [resolved.path]) {
      flags.push(`--allow-fs-read=${path}`);
      if (write) flags.push(`--allow-fs-write=${path}`);
    }
  }
  return { flags };
}
