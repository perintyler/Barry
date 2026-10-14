import { Bounds } from "../config/bounds.js";
/** Resolve bag expansion and trait registration consistently for every identity writer, leaving metadata writes, presentation, and service control to their owners; see docs/decisions/0012-credentials-action-runs-and-traits.md. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRegistry, loadBags, bagLoadStamp, getAllTraits, checkBagDependencies, bagNeedsInstall } from "@barry-rocks/sdk/internal/bags";

import { barryCacheDir } from "@barry-rocks/sdk/services";


import type { Bag } from "@barry-rocks/sdk/bags";
import { Traits } from "../config/traits.js";

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
   * The transitive closure — `bags` plus every reachable sub-bag. Use this for
   * anything that must act on what will actually be LOADED (trait sync),
   * never for what to store.
   */
  composedBags: string[];
  addedSubBags: string[];
  /**
   * Traits whose rows were touched. A DO UPDATE counts as one affected row
   * even when nothing changed, so this means "synced", never
   * "newly created" — don't present it to users as a creation count.
   */
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
 * A remote bag's resource discovery bags for up to 5s each (see
 * sdk/src/bags/loader.ts), so a barry with a few unreachable remote bags
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
 * syncing the traits those bags declare.
 *
 * Ordering matters: unknown names are rejected (or dropped) first, then
 * sub-bags are expanded, then everything — including sub-bags — gets its
 * traits registered in one call. The CLI historically expanded sub-bags
 * *after* syncing traits, so a sub-bag's traits never reached the DB; folding
 * both into one pass fixes that.
 */
export async function resolveAndSyncBags(
  desired: string[],
  options: ResolveBagsOptions = {},
): Promise<ResolveBagsResult> {
  const { strict = false, skipTraitSync = false, maxDepth = Number.POSITIVE_INFINITY } = options;

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
  //
  // This closure drives trait sync — everything that acts on what
  // will be LOADED. It is deliberately not what gets persisted; `requested` is.
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
      for (const subBag of bag.manifest?.bags ?? []) {
        if (visited.has(subBag)) continue;
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

  // Trait absorption requires the full transitive composition closure, without importing unrelated installed bags.
  // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-014
  const absorptionByName = new Map(loaded.map((b) => [b.name, b]));

  let syncedTraits: string[] = [];
  if (!skipTraitSync && loaded.length > 0) {
    await Traits.assertOwnership(loaded.flatMap((bag) => getAllTraits(bag, absorptionByName).map((trait) => ({ name: trait.name, bag: bag.name }))));
    await Bounds.assertOwnership(loaded.flatMap((bag) => Object.keys(bag.manifest?.bounds ?? {}).map((name) => ({ name, bag: bag.name }))));
    for (const bag of loaded) {
      for (const [name, definition] of Object.entries(bag.manifest?.bounds ?? {})) {
        await Bounds.upsertBound({ name, description: definition.description, bound: definition.bound, bag: bag.name });
      }
    }
    const traitInputs = loaded.flatMap((bag) =>
      getAllTraits(bag, absorptionByName).map((t) => ({
        name: t.name,
        description: t.description,
        namespaces: t.bags,
        access: t.access === "readwrite" ? ("readwrite" as const) : ("read" as const),
        skills: t.skills,
        instructions: t.instructions,
        // Enabling a bag must not hand out an unrestricted version of a trait
        // its manifest declared as scoped — that would be the fail-open
        // direction, and this is the path most sessions take.
        boundNames: t.boundNames,
        includes: t.includes,
        harnessTraits: t.harnessTraits,
        nativeTools: t.nativeTools,
        // Same reasoning for the inline form. A trait restricted by a `bound:`
        // block rather than a named one is no less restricted, and dropping it
        // here fails open just as quietly.
        bound: t.bound,
        // Stamp the owning bag. Without it the traits table cannot tell a
        // trait of an installed bag from one orphaned by an uninstall, so
        // every trait ever synced stays on offer forever.
        bag: bag.name,
      })),
    );
    /** Preserve curated namespaces against this partial bag view; only a full-registry sync can safely prune unprovided grants; see docs/decisions/0012-credentials-action-runs-and-traits.md. */
    syncedTraits = await Traits.ensureTraits(traitInputs, { namespaceMode: "keep" });
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
    // Explicit only — composition is resolved at load time. See the docs on
    // ResolveBagsResult.bags.
    bags: requested,
    composedBags: composed,
    addedSubBags,
    syncedTraits,
    warnings,
    timedOut: anyTimedOut,
  };
}

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

/**
 * `resolveAndSyncBags`, skipped when nothing it derives from has changed since
 * the last complete sync recorded under `key`.
 *
 * For callers that sync on every run rather than on an edit: the identity CLI
 * shims and session start. The full sync builds and imports the tool code of
 * every bag in the closure — about 5s for a 36-bag barry — and the shim paid
 * it before `<identity> --help` could print. The check is `bagLoadStamp`,
 * stats and manifest parses only.
 *
 * Returns null when skipped. A sync that timed out or threw records nothing,
 * so the next call retries it. `force` syncs regardless and records the
 * result, for a row that was just created and so has no trait history.
 *
 * The stamp lives in the cache dir: losing it costs one resync.
 */
export async function resolveAndSyncBagsIfChanged(
  key: string,
  desired: string[],
  options: { force?: boolean } = {},
): Promise<ResolveBagsResult | null> {
  const stampPath = join(barryCacheDir(), "bag-sync", `${key}.stamp`);
  if (!options.force && readSyncStamp(stampPath) === bagLoadStamp(desired)) return null;
  const result = await resolveAndSyncBags(desired, { strict: false });
  // Re-stamped after the sync, not reused from before it: loading may have
  // rebuilt stale bundles, and a pre-sync stamp would miss once more for it.
  if (!result.timedOut) writeSyncStamp(stampPath, bagLoadStamp(desired));
  return result;
}
