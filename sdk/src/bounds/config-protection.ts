import { canonicalFilePath, isFileAllowed } from "./bound-guards.js";

const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
const nodeOs = getBuiltin?.("node:os") as typeof import("node:os") | undefined;
const nodePath = getBuiltin?.("node:path") as typeof import("node:path") | undefined;

function homedir(): string {
  return nodeOs?.homedir?.() ?? process.env.HOME ?? "/";
}
function basename(p: string): string {
  if (nodePath) return nodePath.basename(p);
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
function join(...parts: string[]): string {
  return nodePath ? nodePath.join(...parts) : parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/**
 * Built-in patterns protecting Barry configuration files from accidental or
 * unauthorized writes. Enforced in MCP file/bash write guards and harness
 * permission rules without counting as a `bound.files` restriction in
 * `nativeToolsTakenBack`, so unrestricted sessions keep native tools.
 */
export const BARRY_CONFIG_WRITE_DENY_PATTERNS = [
  "~/.barry/identities/**",
  "**/identity.yaml",
  "**/bag.yaml",
] as const;

function normalizeCase(filePath: string): string {
  return process.platform === "darwin" ? filePath.toLowerCase() : filePath;
}

/**
 * Returns the protected pattern matched by `filePath`, or `null` when the path
 * is not a Barry identity or bag configuration file.
 */
export function isProtectedConfigPath(filePath: string): string | null {
  const canonical = normalizeCase(canonicalFilePath(filePath));
  const name = basename(canonical);
  if (name === "identity.yaml") return "**/identity.yaml";
  if (name === "bag.yaml") return "**/bag.yaml";

  const roots = [join(homedir(), ".barry", "identities")];
  if (process.env.BARRY_HOME) {
    roots.push(join(process.env.BARRY_HOME, "identities"));
  }
  for (const root of roots) {
    const canonicalRoot = normalizeCase(canonicalFilePath(root)).replace(/\/+$/, "");
    if (canonical === canonicalRoot || canonical.startsWith(`${canonicalRoot}/`)) {
      return "~/.barry/identities/**";
    }
  }
  return null;
}

import type { Bound } from "./types.js";

/**
 * Checks whether a write to `filePath` is blocked by Barry's built-in config
 * write protection. Only an explicit `files.allow` entry matching the config
 * path lifts the guard.
 */
export function isConfigWriteBlocked(
  filePath: string,
  allowOrBound?: readonly string[] | Bound,
  allowClauses?: readonly (readonly string[])[],
): string | null {
  const protectedPattern = isProtectedConfigPath(filePath);
  if (!protectedPattern) return null;

  let allow: readonly string[] | undefined;
  let clausesInput = allowClauses;
  if (Array.isArray(allowOrBound)) {
    allow = allowOrBound;
  } else if (allowOrBound && typeof allowOrBound === "object") {
    const bound = allowOrBound as Bound;
    allow = bound.files?.allow;
    clausesInput ??= bound.files?.allowClauses;
  }

  const clauses = clausesInput?.length
    ? clausesInput
    : allow !== undefined
      ? [allow]
      : [];
  if (clauses.length === 0) return protectedPattern;

  const allClausesMatch = clauses.every((clause) => {
    const matched = isFileAllowed(filePath, [...clause]);
    return matched !== null && matched !== "**" && matched !== "/**";
  });
  return allClausesMatch ? null : protectedPattern;
}

export const BARRY_CONFIG_PROTECTION_BOUND: Bound = {
  files: { deny: [...BARRY_CONFIG_WRITE_DENY_PATTERNS] },
};

/**
 * Return the built-in config file write protection path globs for `barryHome`
 * (including `~/.barry/identities/`, `identity.yaml`, `bag.yaml`, and
 * `${barryHome}/identities/` when a custom `barryHome` is provided).
 */
export function protectedConfigPaths(barryHome?: string): readonly string[] {
  const deny = new Set<string>(BARRY_CONFIG_WRITE_DENY_PATTERNS);
  const home = barryHome ?? process.env.BARRY_HOME;
  if (home) {
    deny.add(`${home.replace(/\/+$/, "")}/identities/**`);
  }
  return [...deny];
}

