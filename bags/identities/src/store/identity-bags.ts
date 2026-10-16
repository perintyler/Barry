/** Resolve bag expansion and dependency checks consistently for every identity writer, leaving metadata writes, presentation, and service control to their owners. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRegistry, loadBags, bagLoadStamp, checkBagDependencies, bagNeedsInstall } from "@barry-rocks/sdk/internal/bags";
import { barryCacheDir } from "@barry-rocks/sdk/services";
import type { Bag } from "@barry-rocks/sdk/bags";

export interface BagSyncWarning {
  kind:
    | "unregistered-bag"
    | "unregistered-subbag"
    | "missing-dependency"
    | "npm-not-installed"
    | "bag-load-failed";
  bag: string;
  message: string;
  hint?: string;
}

export interface ResolveBagsResult {
  /**
   * What to PERSIST: the explicitly requested, registered bags — deduped,
   * input order preserved. Sub-bags are deliberately NOT folded in.
   *
   * Composition is resolved wherever bags are loaded (see
   * `expandCompositionFromSnapshot`), so baking children into the stored list
   * would freeze a manifest's `bags:` at pack time: editing it would then have
   * no effect until someone re-packed the parent, and unpacking a parent would
   * strand its children in the list forever.
   */
  bags: string[];
  /**
   * The transitive closure — `bags` plus every reachable non-optional sub-bag.
   */
  composedBags: string[];
  addedSubBags: string[];
  /** @deprecated Always empty; retained for compatibility until Stage 5/8. */
  syncedTraits: string[];
  warnings: BagSyncWarning[];
  /**
   * A load hit LOAD_TIMEOUT_MS, so this result reflects fewer bags than were
   * asked for. Transient by nature: a caller caching "already synced" must not
   * cache this one.
   */
  timedOut: boolean;
}

export interface ResolveBagsOptions {
  /** Throw UnregisteredBagError instead of warning-and-dropping unknown names. */
  strict?: boolean;
  /** @deprecated Retained for compatibility until Stage 5/8. */
  skipTraitSync?: boolean;
  /**
   * How deep to follow `manifest.bags`. Default unbounded (the visited set
   * makes cycles terminate) — composition means "the parent gets all the
   * stuff", and a depth cap silently drops a grand-child's bags.
   */
  maxDepth?: number;
}

export class UnregisteredBagError extends Error {
  readonly bags: string[];

  constructor(bags: string[]) {
    super(`Unknown bags: ${bags.join(", ")}`);
    this.name = "UnregisteredBagError";
    this.bags = bags;
  }
}

/**
 * Ceiling on loading every resolved bag.
 *
 * A remote bag's resource discovery waits for up to 5s each (see
 * sdk/src/bags/loader.ts), so an identity with a few unreachable remote bags
 * could hold an Express handler open for tens of seconds. Past the deadline we
 * report what didn't load and continue with what did.
 */
const LOAD_TIMEOUT_MS = 10_000;

async function loadWithTimeout(
  names: string[],
): Promise<{ bags: Bag[]; timedOut: boolean }> {
  if (names.length === 0) return { bags: [], timedOut: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
  });

  try {
    const loaded = await Promise.race([loadBags(names), timeout]);
    if (loaded === null) return { bags: [], timedOut: true };
    return { bags: loaded, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a desired bag list into the set that should actually be persisted,
 * expanding sub-bags from manifests and reporting missing dependencies.
 */
export async function resolveBags(
  desired: string[],
  options: ResolveBagsOptions = {},
): Promise<ResolveBagsResult> {
  const { strict = false, maxDepth = Number.POSITIVE_INFINITY } = options;

  const registry = loadRegistry();
  const warnings: BagSyncWarning[] = [];

  const requested: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const name of desired) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (name in registry) {
      requested.push(name);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    if (strict) throw new UnregisteredBagError(unknown);
    for (const name of unknown) {
      warnings.push({
        kind: "unregistered-bag",
        bag: name,
        message: `Bag "${name}" is not registered`,
        hint: `barry install <path-or-url> --name ${name}`,
      });
    }
  }

  // Expand sub-bags breadth-first. `visited` covers the requested names too,
  // so a manifest cycle (a → b → a) terminates.
  const composed = [...requested];
  const addedSubBags: string[] = [];
  const visited = new Set(requested);
  let frontier = requested;

  let anyTimedOut = false;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const { bags: frontierBags, timedOut: frontierTimedOut } = await loadWithTimeout(frontier);
    anyTimedOut ||= frontierTimedOut;
    const next: string[] = [];
    for (const bag of frontierBags) {
      for (const entry of bag.manifest?.bags ?? []) {
        const subBag = typeof entry === "string" ? entry : (entry as { name: string; optional?: boolean }).optional ? null : (entry as { name: string }).name;
        if (!subBag || visited.has(subBag)) continue;
        visited.add(subBag);
        if (!(subBag in registry)) {
          warnings.push({
            kind: "unregistered-subbag",
            bag: subBag,
            message: `Sub-bag "${subBag}" (required by "${bag.name}") is not registered, skipping`,
          });
          continue;
        }
        composed.push(subBag);
        addedSubBags.push(subBag);
        next.push(subBag);
      }
    }
    frontier = next;
  }

  const { bags: loaded, timedOut } = await loadWithTimeout(composed);
  anyTimedOut ||= timedOut;
  const loadedNames = new Set(loaded.map((b) => b.name));
  for (const name of composed) {
    if (loadedNames.has(name)) continue;
    warnings.push({
      kind: "bag-load-failed",
      bag: name,
      message: timedOut
        ? `Bag "${name}" did not load within ${LOAD_TIMEOUT_MS}ms`
        : `Bag "${name}" could not be loaded (it may be disabled)`,
    });
  }

  // Missing binaries and uninstalled node_modules never block enabling — the
  // bag is registered, it just won't work until the host is fixed.
  for (const { bag, dependency } of checkBagDependencies(loaded)) {
    const reason = dependency.reason ? ` (${dependency.reason})` : "";
    warnings.push({
      kind: "missing-dependency",
      bag,
      message: `missing dependency "${dependency.name}"${reason}`,
      ...(dependency.install ? { hint: dependency.install } : {}),
    });
  }

  for (const bag of loaded) {
    if (bag.source.type !== "local") continue;
    if (!bagNeedsInstall(bag.source.path)) continue;
    warnings.push({
      kind: "npm-not-installed",
      bag: bag.name,
      message: `npm dependencies not installed — run \`pnpm install\` in ${bag.source.path}`,
    });
  }

  return {
    bags: requested,
    composedBags: composed,
    addedSubBags,
    syncedTraits: [],
    warnings,
    timedOut: anyTimedOut,
  };
}

/** @deprecated Use `resolveBags` instead. Retained for Stage 4–5 compatibility. */
export const resolveAndSyncBags = resolveBags;

function readSyncStamp(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function writeSyncStamp(path: string, stamp: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${stamp}\n`);
  renameSync(tmp, path);
}

/** @deprecated Use `resolveBags` instead. Retained for Stage 4–5 compatibility. */
export async function resolveAndSyncBagsIfChanged(
  key: string,
  desired: string[],
  options: { force?: boolean; strict?: boolean } = {},
): Promise<ResolveBagsResult | null> {
  const stampPath = join(barryCacheDir(), "bag-sync", `${key}.stamp`);
  if (!options.force && readSyncStamp(stampPath) === bagLoadStamp(desired)) return null;
  const result = await resolveBags(desired, { strict: options.strict ?? false });
  if (!result.timedOut) writeSyncStamp(stampPath, bagLoadStamp(desired));
  return result;
}
