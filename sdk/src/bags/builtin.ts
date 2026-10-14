/**
 * Barry's own bags: every folder under the repository's `bags/` with a
 * `bag.yaml`.
 */

import { installationRoot } from "../services/home.mjs";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { parseManifest, registeredName } from "./manifest.js";
import { parseIdentityBags } from "../identities/bags.js";
import { parseTraits, requiredNames } from "../identities/entries.js";

/** The builtin bags' directory name, beside the base identity at the repo root. */
export const BUILTIN_DIRNAME = "bags";

const MANIFEST = "bag.yaml";
const IDENTITY = "identity.yaml";

let warnedNotFound = false;
let warnedOverrideMissing = false;

/**
 * Resolve builtins from the pinned installation root or explicit override; a nonexistent override is an error, while an existing empty directory means no builtins.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
export function builtinBagsDir(): string | null {
  const override = process.env.BARRY_BUILTIN_DIR;
  if (override) {
    const dir = resolve(override);
    if (!existsSync(dir) && !warnedOverrideMissing) {
      warnedOverrideMissing = true;
      process.stderr.write(
        `barry: BARRY_BUILTIN_DIR is ${dir}, which does not exist; builtin bags are unavailable. ` +
          `A bag bundle built before the builtin directory moved pins the old path: ` +
          `rebuild it with \`barry bag build --force <bag>\`.\n`,
      );
    }
    return dir;
  }
  let found: string | null = null;
  try {
    const root = installationRoot();
    if (existsSync(join(root, IDENTITY)) && existsSync(join(root, BUILTIN_DIRNAME))) found = join(root, BUILTIN_DIRNAME);
  } catch { /* Discovery outside an installation stays fail-soft. */ }
  if (!found && !warnedNotFound) {
    // Not a throw: hook dispatch reaches this through the registry, and it is
    // contractually fail-soft. But never silent either -- an empty builtin set
    // looks exactly like a healthy one to every caller.
    warnedNotFound = true;
    process.stderr.write(
      `barry: no ${IDENTITY} with ${BUILTIN_DIRNAME}/ beside it above ${fileURLToPath(import.meta.url)}; ` +
        `builtin bags are unavailable. Set BARRY_BUILTIN_DIR if this code runs outside the repo.\n`,
    );
  }
  return found;
}

/**
 * Make this process's builtin directory the one a bag bundle will see.
 *
 * A bundle's banner pins `BARRY_BUILTIN_DIR` with `||=`, so it applies only
 * when the variable is unset. Setting it from the running checkout before a
 * bundle loads means the live path wins over whatever path the bundle was
 * built with, so a bundle built before a move keeps working in-process. An
 * existing value (a sandbox, a test) is left alone.
 */
export function shareBuiltinDirWithBundles(): void {
  if (process.env.BARRY_BUILTIN_DIR) return;
  const dir = builtinBagsDir();
  if (dir) process.env.BARRY_BUILTIN_DIR = dir;
}

/** What the builtin directory holds. */
export interface BuiltinBags {
  /** The directory it was read from, or null when there is none. */
  dir: string | null;
  /** Every builtin bag, by name, with its path relative to `dir`. */
  local: Record<string, string>;
}

/** Folders the walk never enters: dependencies, build output, and test fixtures. */
const SKIPPED = new Set(["node_modules", "dist", "__tests__", "__fixtures__", "fixtures"]);

/** Discover nested bag manifests under root and reject duplicate names; see docs/decisions/0017-sdk-discovery-and-wire-contracts.md. */
export function findBags(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (dir: string): void => {
    if (existsSync(join(dir, MANIFEST)) && dir !== root) {
      const manifest = parseManifest(dir);
      if (!manifest) throw new Error(`${join(dir, MANIFEST)} does not parse as a bag manifest`);
      const rel = relative(root, dir);
      const parentDir = dirname(dirname(dir));
      const inExtensions = basename(dirname(dir)) === "extensions";
      const parent = inExtensions ? parseManifest(parentDir) : null;
      if (manifest.extends && (!inExtensions || parent?.name !== manifest.extends || dir !== join(parentDir, "extensions", manifest.name))) {
        throw new Error(`${rel}: extension must live at its parent ${manifest.extends}'s extensions/${manifest.name}/`);
      }
      if (inExtensions && (!manifest.extends || parent?.name !== manifest.extends)) {
        throw new Error(`${rel}: a folder under extensions/ must declare extends: ${parent?.name ?? "<parent>"}`);
      }
      const name = registeredName(manifest);
      if (name in found) throw new Error(`bag ${name} is declared twice: ${found[name]} and ${rel}`);
      found[name] = rel;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED.has(entry.name)) visit(join(dir, entry.name));
    }
  };
  visit(root);
  return found;
}

/** What the base identity selects: the bags it packs and the traits it grants. */
export interface BaseIdentitySelection {
  bags: string[];
  traits: string[];
}

const selections = new Map<string, BaseIdentitySelection>();

/** Derive default bag and trait grants from the root identity rather than duplicating them in code, with empty grants when no builtin directory exists; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */
export function baseIdentitySelection(dir: string | null = builtinBagsDir()): BaseIdentitySelection {
  if (!dir) return { bags: [], traits: [] };
  const cached = selections.get(dir);
  if (cached) return cached;
  const file = join(dirname(dir), IDENTITY);
  const raw: unknown = existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : null;
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const selection = { bags: parseIdentityBags(doc.bags).bags, traits: requiredNames(parseTraits(doc.traits, file)) };
  selections.set(dir, selection);
  return selection;
}

/** The traits every session is granted unless it selects otherwise: the base identity's. */
export function defaultTraits(): string[] {
  return baseIdentitySelection().traits;
}

/** Barry's own bags. */
export function discoverBuiltinBags(dir: string | null = builtinBagsDir()): BuiltinBags {
  if (!dir || !existsSync(dir)) return { dir, local: {} };
  return { dir, local: findBags(dir) };
}

// Relative registry paths survive foundation moves without rewriting stored data.
export function resolveBuiltinPath(stored: string, dir: string | null = builtinBagsDir()): string {
  if (!dir || isAbsolute(stored) || stored.startsWith("~")) return stored;
  if (stored.split(/[\\/]/).includes(".."))
    throw new Error("shipped bag paths must remain inside bags/; re-seed the bag registry explicitly");
  return join(dir, stored);
}
