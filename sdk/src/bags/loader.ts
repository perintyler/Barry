import { createLogger } from "../logging/emit.js";
import { loadBagToolSummaries } from "./tool-definitions.js";
import { homedir } from "os";
import { createRequire } from "module";
import { existsSync, statSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { loadRegistry, getBagSource, isBuiltinBag } from "./registry.js";
import { getBagBuildDir, getRegistrySnapshotPath } from "./paths.js";
import { registeredName, parseManifest, getSkillsDirs, findManifest } from "./manifest.js";
import { resolveBagHooks } from "../hooks/hooks.js";
import { getActionsDirs } from "../actions/action-manifest.js";
import { getInstructionsDirs } from "../instructions/instruction-manifest.js";
import { expandComposition } from "../traits/auto-traits.js";
import type { Bag, BagRegistrySnapshot, BagTrait, BagMcpServer, LocalBagSource, RemoteBagSource } from "./types.js";
import { resolveBagAccess } from "./types.js";

const log = createLogger("sdk-bags", { transport: "stderr" });

/**
 * Bag loader — resolves bag entries into fully loaded bags
 */













// auto-traits imports only types, so this direction introduces no cycle.




function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

/**
 * Re-resolve an npm-installed bag whose absolute path has gone missing.
 * pnpm install can move packages around (especially inside.pnpm/); this
 * keeps registry entries resilient to that churn.
 */
function reResolveNpmPath(entry: LocalBagSource): string | null {
  if (!entry.npm) return null;
  try {
    const req = createRequire(join(process.cwd(), "package.json"));
    try {
      return dirname(req.resolve(`${entry.npm}/bag.yaml`));
    } catch {
      const main = req.resolve(entry.npm);
      let dir = dirname(main);
      for (let depth = 0; depth < 8; depth++) {
        if (existsSync(join(dir, "bag.yaml"))) return dir;
        if (existsSync(join(dir, "package.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    // npm package no longer installed
  }
  return null;
}

function loadLocalBag(name: string, entry: LocalBagSource): Bag {
  let bagDir = resolvePath(entry.path);

  if (!existsSync(bagDir) && entry.npm) {
    const reResolved = reResolveNpmPath(entry);
    if (reResolved) {
      bagDir = reResolved;
      entry.path = reResolved;
    }
  }

  // A registry entry pointing at a path that does not exist is always a broken
  // entry, not a bag without a manifest. Without this warning the bag loads
  // as an empty husk — no tools, no traits — and every trait granting its
  // namespace silently resolves to nothing (filterTools iterates tools, so a
  // namespace with no provider is never consulted). Bags relocating on disk
  // is the common cause; `barry bag doctor` reports and repairs it.
  if (!existsSync(bagDir)) {
    // A git-sourced bag knows where it came from, so say so. Deliberately NOT
    // cloned here: loading happens at session start and on every hook firing,
    // where a network call would stall the session, and re-materializing a
    // checkout is a side effect the user should ask for rather than discover.
    // `barry install` does the fetching; this only names the way back.
    const recovery = entry.git
      ? ` — re-fetch it with: barry install ${entry.git.repo}`
      : "";
    log.warn(
      `warning: bag "${name}" points at "${entry.path}", which does not exist — it will contribute no tools or traits${recovery}`,
    );
  }

  /**
   * A manifest that fails validation degrades this bag, not the whole install.
   *
   * `loadAllBags` walks every registered bag, so an unguarded throw here
   * means one typo — or one third-party bag written against an older schema —
   * takes down tool loading, the launchd emitter, and `bag doctor` for every
   * other bag. That failure reads as "Barry is broken", not "this bag is
   * broken", and the offending name only appears if you read the stack.
   *
   * Treated the same as a missing manifest, which already degrades gracefully
   * above: warn with the bag name and return a husk.
   */
  let manifest: ReturnType<typeof parseManifest>;
  try {
    manifest = parseManifest(bagDir);
    if (manifest?.extends && name !== registeredName(manifest)) {
      throw new Error(`extension is registered as ${name}, but must be ${registeredName(manifest)}; run barry bag doctor --fix`);
    }
    invalidManifests.delete(name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    invalidManifests.set(name, reason);
    log.warn(`warning: bag "${name}" has an invalid manifest — it will contribute no tools or traits: ${reason}`);
    manifest = null;
  }

  if (!manifest) {
    return {
      name,
      description: "",
      builtin: false,
      source: entry,
      manifest: null,
      skillsDirs: getSkillsDirs(bagDir),
      actionsDirs: getActionsDirs(bagDir),
      instructionsDirs: getInstructionsDirs(bagDir),
      traits: [],
      mcpServers: {},
      tools: [],
      dependencies: [],
      slashCommands: [],
    hooks: [],
    requires: [],
      services: [],
      apps: [],
      schedules: [],
      jobs: [],
    };
  }

  const traits: BagTrait[] = [];
  for (const [traitName, traitDef] of Object.entries(manifest.traits)) {
    traits.push({
      name: traitName,
      includes: traitDef.includes,
      harnessTraits: traitDef.harnessTraits,
      nativeTools: traitDef.nativeTools,
      description: traitDef.description,
      access: traitDef.access,
      bags: traitDef.bags,
      skills: traitDef.skills ?? [],
      instructions: traitDef.instructions ?? [],
      boundNames: traitDef.boundNames ?? [],
      // Preserve validated inline bounds when reconstructing authored traits.
      bound: traitDef.bound,
    });
  }

  return {
    name: registeredName(manifest),
    description: manifest.description,
    builtin: false,
    source: entry,
    manifest,
    skillsDirs: getSkillsDirs(bagDir),
    actionsDirs: getActionsDirs(bagDir),
    instructionsDirs: getInstructionsDirs(bagDir),
    traits,
    mcpServers: manifest.mcpServers,
    tools: manifest.tools,
    dependencies: manifest.dependencies,
    slashCommands: manifest.slashCommands?.commands ?? [],
    hooks: resolveBagHooks(bagDir, manifest.hooks, registeredName(manifest)),
    requires: Object.entries(manifest.requires ?? {}).map(([target, r]) => ({ target, ...r })),
    services: Object.entries(manifest.services).map(([svcName, s]) => ({ name: svcName, ...s })),
    apps: Object.entries(manifest.apps).map(([appName, a]) => ({ ...a, name: appName })),
    schedules: Object.entries(manifest.schedules).map(([scheduleName, sc]) => ({ name: scheduleName, dir: bagDir, ...sc })),
    jobs: Object.entries(manifest.jobs ?? {}).map(([jobName, job]) => ({ name: jobName, dir: bagDir, ...job })),
  };
}

function loadRemoteBag(name: string, entry: RemoteBagSource): Bag {
  const mcpServers: Record<string, BagMcpServer> = {};

  // The bag itself IS the MCP server
  const serverDef: BagMcpServer = {};
  if (entry.url) {
    serverDef.type = "http";
    serverDef.url = entry.url;
  }
  if (entry.command) {
    serverDef.command = entry.command;
    serverDef.args = entry.args;
    serverDef.env = entry.env;
  }
  // Registry entries have no manifest, so this is the only place the flag can
  // come from. Dropping it silently made `session-scoped` a no-op for every
  // remote bag, which left them connected eagerly for the server's lifetime.
  if (entry["session-scoped"]) {
    serverDef.sessionScoped = true;
  }

  if (serverDef.type || serverDef.command) {
    mcpServers[name] = serverDef;
  }

  return {
    name,
    description: "",
    builtin: false,
    source: entry,
    manifest: null,
    skillsDirs: [],
    actionsDirs: [],
    instructionsDirs: [],
    traits: [],
    mcpServers,
    tools: entry.tools ?? [],
    // Remote bags can still need a launcher binary (e.g. npx for mcp-remote)
    dependencies: entry.command ? [{ name: entry.command }] : [],
    slashCommands: [],
    hooks: [],
    requires: [],
    services: [],
    apps: [],
    schedules: [],
    // A remote bag is an MCP server; it ships no code for Barry to run.
    jobs: [],
  };
}

function loadBagSource(name: string): Bag | null | Promise<Bag | null> {
  const source = getBagSource(name);
  if (!source || resolveBagAccess(source) === "disabled") return null;

  if (source.type === "local") {
    const bag = loadLocalBag(name, source);
    bag.builtin = isBuiltinBag(name);
    return bag;
  }

  if (source.resources) {
    return loadRemoteBagWithResources(name, source);
  }

  const bag = loadRemoteBag(name, source);
  bag.builtin = isBuiltinBag(name);
  return bag;
}

/**
 * How long resource discovery may take before falling back.
 *
 * Discovery makes a live MCP connection, and nothing else on this path bounds
 * it — an unreachable or hung server would otherwise stall bag loading
 * indefinitely. Override with BARRY_BAG_DISCOVERY_TIMEOUT_MS.
 */
function discoveryTimeoutMs(): number {
  return Number(process.env.BARRY_BAG_DISCOVERY_TIMEOUT_MS) || 5000;
}

/** Inject live remote discovery so read-only bag loading does not import MCP transport code. */
type RemoteResourceDiscoverer = (name: string, source: RemoteBagSource) => Promise<Bag>;

let discoverRemoteBagResources: RemoteResourceDiscoverer | null = null;

/** Install host discovery; null removes it, and missing discovery retains the registry fallback with a warning. */
export function setRemoteResourceDiscoverer(fn: RemoteResourceDiscoverer | null): void {
  discoverRemoteBagResources = fn;
}

/**
 * Bags that loaded as husks because their manifest failed validation, with
 * the validation error.
 *
 * The warning above is correct and names the offending key, but it is printed
 * by whatever process happened to load the bag -- for a service, a launchd
 * stdout log nobody reads. The bag then looks exactly like one that declares no
 * tools, which is how six bag.yaml files once ran invalid against the pushed
 * schema with nothing surfacing it. Recording the failure lets a diagnostic
 * people actually run (`barry bag doctor`) count it as a problem. Cleared when
 * the bag later loads cleanly, so a fixed manifest stops being reported.
 */
const invalidManifests = new Map<string, string>();

export function getInvalidManifests(): ReadonlyMap<string, string> {
  return invalidManifests;
}

/** Whether a host has installed the discoverer. Exported for diagnostics. */
export function hasRemoteResourceDiscoverer(): boolean {
  return discoverRemoteBagResources !== null;
}

async function loadRemoteBagWithResources(name: string, source: RemoteBagSource): Promise<Bag | null> {
  const discover = discoverRemoteBagResources;
  if (!discover) {
    // No host installed a discoverer. Degrade exactly as a failed discovery
    // does — tools from the registry entry, no skills or traits — and say so,
    // because a remote bag quietly missing its resources is indistinguishable
    // from one that declares none.
    log.warn(
      `[bags] remote bag '${name}': declares resources but no discoverer is installed, ` +
        `falling back to tools only — the host must call setRemoteResourceDiscoverer()`,
    );
    const bag = loadRemoteBag(name, source);
    bag.builtin = isBuiltinBag(name);
    return bag;
  }
  try {
    const timeoutMs = discoveryTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bag = await Promise.race([
      discover(name, source),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`resource discovery timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));

    bag.builtin = isBuiltinBag(name);
    return bag;
  } catch (error) {
    // Fall back to the bag's tools alone. Reported rather than swallowed: the
    // bag still works, but its skills and traits are missing, and a
    // silent fallback made that indistinguishable from a bag that has none.
    log.warn(
      `[bags] remote bag '${name}': resource discovery failed, falling back to tools only — ` +
        (error instanceof Error ? error.message : String(error)),
    );
    const bag = loadRemoteBag(name, source);
    bag.builtin = isBuiltinBag(name);
    return bag;
  }
}

/** Synchronous manifest discovery for command registration; tool metadata requires loadBag. */
export function loadBagSync(name: string): Bag | null {
  const result = loadBagSource(name);
  if (result instanceof Promise) return null;
  return result;
}

/** Report each tool-load failure once and retain the bag with toolsError so one broken import does not reject the whole registry load; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */
const toolLoadFailures = new Map<string, string>();

function describeToolLoadError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // tool-definitions wraps import failures; the cause is the useful part.
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`.replace(/\s+/g, " ").trim();
}

export async function loadBag(name: string): Promise<Bag | null> {
  const bag = await loadBagSource(name);
  if (!bag) return null;
  let tools: Awaited<ReturnType<typeof loadBagToolSummaries>>;
  try {
    tools = await loadBagToolSummaries(bag);
  } catch (error) {
    const reason = describeToolLoadError(error);
    // Once per process per reason: a single command can load the same bag
    // several times (identity sync loads the composition frontier, then the
    // closure), and repeating the warning says nothing new.
    if (toolLoadFailures.get(name) !== reason) {
      log.warn(`warning: bag "${name}" could not load its tools — they are unavailable until this is fixed: ${reason}`);
    }
    toolLoadFailures.set(name, reason);
    bag.toolsError = reason;
    return bag;
  }
  toolLoadFailures.delete(name);
  if (tools) bag.tools = tools;
  return bag;
}

export async function loadBags(names: string[]): Promise<Bag[]> {
  const loaded = await Promise.all(names.map((name) => loadBag(name)));
  const bags: Bag[] = [];
  for (const bag of loaded) {
    if (bag) bags.push(bag);
  }
  return bags;
}

export async function loadAllBags(): Promise<Bag[]> {
  const registry = loadRegistry();
  return loadBags(Object.keys(registry));
}

/** `mtimeMs:size` of a path, or "-" when it does not exist. */
function statStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** Bump when trait derivation changes shape, so stamps it wrote stop matching. */
const LOAD_STAMP_VERSION = 4;

/**
 * Fingerprint of what syncing traits for `names` would derive from, cheap
 * enough to check on every CLI invocation: stats and manifest parses, no
 * builds and no imports.
 *
 * Covers, for each bag in the composition closure, its registry entry, the
 * manifest (traits, bounds, `bags:`), the built tools bundle (its code stamps
 * the namespaces), and the skills directories (their entries become trait
 * skills). Only the closure's registry entries, not the whole snapshot: every
 * install or unregister rewrites the snapshot, and stamping it made each one
 * re-sync every identity on its next command. A tool source edit therefore registers once something
 * rebuilds the bundle — a session, `barry bag build` — not before.
 */
export function bagLoadStamp(names: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ version: LOAD_STAMP_VERSION, names }));
  const visited = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    hash.update(`\n${name}=${JSON.stringify(getBagSource(name) ?? null)}`);
    const bag = loadBagSync(name);
    // A remote or unregistered bag changes only through its registry entry.
    if (!bag || bag.source.type !== "local") continue;
    const bagDir = resolvePath(bag.source.path);
    const manifest = findManifest(bagDir);
    hash.update(`\n${name}:${manifest ? statStamp(manifest) : "-"}:${statStamp(join(getBagBuildDir(bag.name, bagDir), "tools.js"))}`);
    for (const dir of bag.skillsDirs) hash.update(`:${statStamp(dir)}`);
    queue.push(...(bag.manifest?.bags ?? []));
  }
  return hash.digest("hex");
}

let cachedSnapshot: Promise<BagRegistrySnapshot> | null = null;
let cachedStamp: string | null = null;

/**
 * Fingerprint of the on-disk registry snapshot, or null when it is absent.
 *
 * Cheap enough (one stat) to check on every call. The registry file is written
 * atomically via rename, so size+mtime moves together with content.
 */
function snapshotStamp(): string | null {
  try {
    const st = statSync(getRegistrySnapshotPath());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Resolve builtin and user bags once so every consumer observes the same
 * overrides.
 *
 * Memoized for resident consumers, but keyed on the snapshot's mtime. The config store is authoritative
 * and every
 * mutation rewrites the snapshot, so without this a resident process (MCP, API)
 * would serve the registry it read at boot forever: register a bag from the web
 * UI and the running server never sees it. Per-firing hook dispatch is immune
 * either way, being a fresh process each time.
 */
export function loadBagRegistrySnapshot(): Promise<BagRegistrySnapshot> {
  const stamp = snapshotStamp();
  if (cachedSnapshot && stamp !== cachedStamp) {
    cachedSnapshot = null;
  }
  if (!cachedSnapshot) {
    cachedStamp = stamp;
    cachedSnapshot = (async () => {
      const registry = loadRegistry();
      const bags = await loadBags(Object.keys(registry));
      return {
        registry: Object.freeze({ ...registry }),
        bags: Object.freeze(bags),
        byName: new Map(bags.map((bag) => [bag.name, bag])),
      };
    })();
  }
  return cachedSnapshot;
}

export function clearBagRegistrySnapshot(): void {
  cachedSnapshot = null;
  cachedStamp = null;
}

/**
 * Expand bag names through `bags:` composition, resolved from the memoized
 * registry snapshot.
 *
 * Returns NAMES, not bags, so a caller keeps whatever load it already does —
 * the point is to widen the name list feeding an existing `loadBags`, not to
 * add a second load. The snapshot is keyed on the registry file's mtime and is
 * already read on every session turn, so this costs nothing on the hot path.
 *
 * Composition is resolved at LOAD time rather than baked into a stored list:
 * a manifest `bags:` edit takes effect on the next load instead of waiting for
 * someone to re-pack the parent.
 */
export async function expandCompositionFromSnapshot(names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  try {
    const { byName } = await loadBagRegistrySnapshot();
    return expandComposition(names, byName);
  } catch {
    // Composition is a widening; if the snapshot is unreadable the caller is
    // better off loading exactly what it asked for than failing outright.
    return [...names];
  }
}
