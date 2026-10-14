import { createLogger } from "../logging/emit.js";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  rmSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from "fs";
import { join, dirname, basename, resolve, sep } from "path";
import { createRequire } from "module";
import { pathToFileURL, fileURLToPath } from "url";
import { installationPath } from "../services/home.mjs";
import { bagBuildExternals } from "./build-configuration.js";
import { loadRegistry } from "./registry.js";
import { builtinBagsDir, shareBuiltinDirWithBundles } from "./builtin.js";
import { parseManifest, registeredName } from "./manifest.js";
import { resolveBagAccess } from "./types.js";
import { getBagBuildDir, getBagsBuildRoot } from "./paths.js";
import type { BagSource } from "./types.js";

const log = createLogger("sdk-bags", { transport: "stderr" });

/**
 * Bundle local bags to plain JavaScript so installed and development loading agree; missing regenerable cache output requires rebuilding rather than treating a bag as absent.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */














/**
 * Packages esbuild must not inline.
 *
 * Native addons (better-sqlite3) cannot be bundled at all. playwright and the
 * agent SDK ship their own runtime assets and browser binaries. googleapis is
 * excluded to keep bag bundles small.
 */
const DEFAULT_EXTERNALS = [
  "better-sqlite3",
  "playwright",
  "playwright-core",
  "puppeteer",
  "puppeteer-core",
  "md-to-pdf",
  "@anthropic-ai/claude-agent-sdk",
  "googleapis",
];

export interface BuildableBag {
  name: string;
  bagDir: string;
  /** Absolute path to the bag's TypeScript tools entry */
  entry?: string;
  /** Absolute path to the bag's computed prompt entry. */
  promptsEntry?: string;
  /** Extra packages to treat as external during bundling (from package.json `barry.build.externals`) */
  externals?: string[];
}

/** One esbuild diagnostic, kept structured so callers can format it themselves. */
export interface BagBuildError {
  text: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface BagBuildResult {
  name: string;
  ok: boolean;
  outFile?: string;
  bytes?: number;
  /**
   * esbuild's own summary. Its FIRST line is only a header ("Build failed with
   * 2 errors:") — the diagnostics follow on later lines, so never report this
   * truncated to one line; prefer `errors` when present.
   */
  error?: string;
  /** Per-diagnostic detail. Empty for failures esbuild did not produce. */
  errors?: BagBuildError[];
}

function expandHome(p: string): string {
  return p.replace(/^~/, process.env.HOME || "");
}

/**
 * Repo root, derived from this module's own location rather than cwd.
 *
 * External resolution must not depend on where the process was started: the MCP
 * server runs with cwd=engine (and from a bundle in dist/), where several
 * externals are invisible. Walks up to the directory owning node_modules/.pnpm.
 */
function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(current, "node_modules", ".pnpm"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Every local, non-disabled bag in the merged registry that declares a tools
 * entry. Covers in-repo and out-of-repo bags identically — both are `local`.
 */
export function discoverBuildableBags(): BuildableBag[] {
  const registry = loadRegistry();
  const bags: BuildableBag[] = [];

  for (const [name, source] of Object.entries(registry)) {
    if (!isLocalSource(source)) continue;
    if (resolveBagAccess(source) === "disabled") continue;

    const bagDir = expandHome(source.path);
    if (!existsSync(bagDir)) continue;

    // One unparseable manifest must not take down a build of every other bag.
    // This sweep runs inside `barry install`, where the bag being installed is
    // usually not the broken one — an unguarded throw here made an unrelated
    // install look like it had failed, when registration had already landed.
    // Matches loadBag's posture: warn with the bag name, skip, keep going.
    let manifest: ReturnType<typeof parseManifest>;
    let externals: string[];
    try {
      manifest = parseManifest(bagDir);
      externals = bagBuildExternals(bagDir);
    } catch (err) {
      log.warn(
        `warning: bag "${name}" has an invalid manifest — it will not be built: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    if (manifest?.extends && name !== registeredName(manifest)) continue;

    const entry = manifest?.toolsEntry?.entry ? join(bagDir, manifest.toolsEntry.entry) : undefined;
    const promptsEntry = manifest?.promptsEntry?.entry ? join(bagDir, manifest.promptsEntry.entry) : undefined;
    if ((!entry || !existsSync(entry)) && (!promptsEntry || !existsSync(promptsEntry))) continue;

    bags.push({ name, bagDir, ...(entry && existsSync(entry) ? { entry } : {}),
      ...(promptsEntry && existsSync(promptsEntry) ? { promptsEntry } : {}),
      externals });
  }

  return bags.sort((a, b) => a.name.localeCompare(b.name));
}

function isLocalSource(source: BagSource): source is Extract<BagSource, { type: "local" }> {
  return source.type === "local";
}

/**
 * Files that change what a build produces without being TypeScript source.
 *
 * `bag.yaml` selects the tools entry, so editing it to point at a different
 * (already-present) module changes the bundle with no source file touched.
 * `package.json` and the lockfiles decide which dependency version gets
 * inlined. Leaving these out of the freshness check meant a stale bundle
 * served the previous implementation indefinitely — the same silent-staleness
 * shape that once dropped every builtin pack when `dist/bundle.cjs` went stale.
 */
const BUILD_INPUT_FILENAMES = new Set([
  "bag.yaml",
  "bag.yml",
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

/** Does this file change the bundle if it changes? */
function isBuildInput(filename: string): boolean {
  if (BUILD_INPUT_FILENAMES.has(filename)) return true;
  return filename.endsWith(".ts") && !filename.endsWith(".test.ts");
}

/** Newest mtime across a bag's build inputs, used for staleness checks. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "skills") continue;
      const full = join(current, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
      } else if (isBuildInput(entry)) {
        newest = Math.max(newest, stat.mtimeMs);
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Newest mtime across the bag's linked workspace dependencies.
 *
 * A bag bundles its `@barry-rocks/*` dependencies in, so a change to one of them
 * makes the bundle stale even though nothing under the bag's own src/ moved.
 * Missing that is not cosmetic: a bundle kept serving a tool its dependency had
 * since removed, and the duplicate registration took down the MCP server.
 *
 * Only linked (symlinked) dependencies are followed — a real installed package
 * changes only via a version bump, which rewrites package.json anyway.
 */
function newestLinkedDepMtime(bagDir: string): number {
  const scopeDir = join(bagDir, "node_modules", "@barry-rocks");
  let newest = 0;

  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const link = join(scopeDir, entry);
    try {
      // Only follow symlinks: those point at live source in the monorepo.
      if (!lstatSync(link).isSymbolicLink()) continue;
      newest = Math.max(newest, newestSourceMtime(realpathSync(link)));
    } catch {
      // Broken link — the build itself will report it.
    }
  }

  return newest;
}

export function isBagBuildStale(bag: BuildableBag): boolean {
  const outDir = getBagBuildDir(bag.name, bag.bagDir);
  const outputs = [
    ...(bag.entry ? [join(outDir, "tools.js")] : []),
    ...(bag.promptsEntry ? [join(outDir, "prompt.js")] : []),
  ];
  if (outputs.some((outFile) => !existsSync(outFile))) return true;

  const builtAt = Math.min(...outputs.map((outFile) => statSync(outFile).mtimeMs));
  const recorded = outputs.map(readBuildInputs);
  if (recorded.every((inputs): inputs is string[] => inputs !== null)) {
    return newestMtimeOf([...recorded.flat(), ...bagManifestFiles(bag.bagDir)]) > builtAt;
  }
  // Built before its inputs were recorded: walk everything that could be one.
  if (newestSourceMtime(bag.bagDir) > builtAt) return true;
  return newestLinkedDepMtime(bag.bagDir) > builtAt;
}

// Use recorded build inputs instead of scanning native build trees on every launch; legacy bundles use the fallback scan.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-009
function readBuildInputs(outFile: string): string[] | null {
  try {
    const recorded = JSON.parse(readFileSync(inputsFileFor(outFile), "utf-8")) as { files?: unknown };
    return Array.isArray(recorded.files) && recorded.files.every((file) => typeof file === "string") ? recorded.files : null;
  } catch {
    return null;
  }
}

function inputsFileFor(outFile: string): string {
  return outFile.replace(/\.js$/, ".inputs.json");
}

/**
 * What decides a build besides its source files: the bag's own manifest,
 * package.json and lockfiles (see BUILD_INPUT_FILENAMES), and the package.json
 * of each linked workspace dependency, whose exports decide what resolves.
 */
function bagManifestFiles(bagDir: string): string[] {
  const files = [...BUILD_INPUT_FILENAMES].map((name) => join(bagDir, name)).filter((file) => existsSync(file));
  const scopeDir = join(bagDir, "node_modules", "@barry-rocks");
  let links: string[] = [];
  try {
    links = readdirSync(scopeDir);
  } catch {
    return files;
  }
  for (const entry of links) {
    try {
      const link = join(scopeDir, entry);
      if (lstatSync(link).isSymbolicLink()) files.push(join(realpathSync(link), "package.json"));
    } catch {
      // Broken link — the build itself will report it.
    }
  }
  return files.filter((file) => existsSync(file));
}

/** Newest mtime among `files`; a missing one makes the bundle stale, so its absence surfaces in a rebuild. */
function newestMtimeOf(files: readonly string[]): number {
  let newest = 0;
  for (const file of files) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return newest;
}

/**
 * The source files esbuild read for one bundle, from its metafile, as absolute
 * paths. Installed packages are left out: one changes only with a version
 * bump, which rewrites the package.json or lockfile checked beside these.
 * Linked workspace packages resolve to their real paths, so they stay in.
 */
function bundledSourceFiles(metafile: unknown, workingDir: string): string[] {
  const inputs = (metafile as { inputs?: Record<string, unknown> } | undefined)?.inputs ?? {};
  return Object.keys(inputs)
    .filter((input) => !/[:(]/.test(input))
    .map((input) => resolve(workingDir, input))
    .filter((file) => !file.split(sep).includes("node_modules"));
}

/**
 * Locate esbuild's entry inside the pnpm store.
 *
 * Walks up from this module looking for node_modules/.pnpm, so it works from a
 * compiled host bundle as well as from source.
 */
function findEsbuildInPnpmStore(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const store = join(current, "node_modules", ".pnpm");
    if (existsSync(store)) {
      const candidates = readdirSync(store)
        .filter((entry) => entry.startsWith("esbuild@"))
        .sort()
        .reverse();
      for (const entry of candidates) {
        const main = join(store, entry, "node_modules", "esbuild", "lib", "main.js");
        if (existsSync(main)) return main;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function resolveEsbuild(): Promise<{ build: (options: Record<string, unknown>) => Promise<unknown> }> {
  try {
    const mod = await import("esbuild") as { build: (options: Record<string, unknown>) => Promise<unknown> };
    return mod;
  } catch {
    // esbuild needs its external runtime assets; bundled hosts resolve it from the pnpm store.
    const fromStore = findEsbuildInPnpmStore();
    if (!fromStore) throw new Error("esbuild not found (needed to build bags)");
    const mod = await import(pathToFileURL(fromStore).href) as { build: (options: Record<string, unknown>) => Promise<unknown> };
    return mod;
  }
}

/**
 * esbuild's ESM output keeps CJS dependencies' `require()` calls intact, which
 * throws "Dynamic require of X is not supported" under Node's ESM loader. This
 * banner reinstates a working `require` in module scope.
 */
const ESM_REQUIRE_BANNER = [
  'import { createRequire as __barryCreateRequire } from "node:module";',
  "const require = __barryCreateRequire(import.meta.url);",
].join("\n");

/**
 * Banner for a built bag: the ESM `require` shim plus pinned paths to the repo
 * config files that bundled code would otherwise resolve against its own
 * location.
 *
 * A bag that reads the bag registry — the actions bag enumerates actions
 * across every bag — locates the builtin directory by walking up from its own
 * module inside @barry-rocks/sdk. In a built bundle that is the flat build
 * cache directory, not the repo, so the walk finds nothing and every *builtin*
 * bag disappears from the registry while user bags still resolve (their
 * registry carries absolute paths). The bag just sees a partial world.
 *
 * The model catalog was the same bug, found later: it was a YAML file read at
 * MODULE SCOPE off `import.meta.url`, so any bag pulling it in resolved it to
 * `~/Library/Caches/config/models.yaml` and threw ENOENT on import —
 * contributing ZERO tools behind a warning that read as cosmetic. It is
 * TypeScript data beside its bundle now, bundled like any other module, so
 * it needs no pin.
 *
 * Pinning here is the narrowest fix: the builder knows the repo root, and
 * the runtime env vars still take precedence. Any future repo-config read from
 * bundled code belongs in this list — resolving a repo path from the code's own
 * location is precisely what bundling invalidates.
 */
function pinBuiltinDir(): string[] {
  const dir = builtinBagsDir();
  return dir ? [`globalThis.process.env.BARRY_BUILTIN_DIR ||= ${JSON.stringify(dir)};`] : [];
}

function buildBannerFor(): string {
  return [
    ESM_REQUIRE_BANNER,
    // Via globalThis: the banner shares module scope with the bundle, and a
    // bundled dependency exporting a top-level `process` function (zod v4 has
    // one) hoists over the global — `process.env` is then undefined and the
    // whole bundle throws at import.
    // Omitted when the builder itself has no builtin directory: pinning a
    // bogus path would read as "no builtins" with no warning, where omitting it
    // leaves the bundle's own lookup to warn.
    ...pinBuiltinDir(),
  ].join("\n");
}

export async function buildBag(bag: BuildableBag): Promise<BagBuildResult> {
  const outDir = getBagBuildDir(bag.name, bag.bagDir);
  const outFile = bag.entry ? join(outDir, "tools.js") : join(outDir, "prompt.js");

  try {
    const { build } = await resolveEsbuild();
    mkdirSync(dirname(outFile), { recursive: true });

    const options = {
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      sourcemap: true,
      external: bag.externals?.length
        ? [...DEFAULT_EXTERNALS, ...bag.externals]
        : DEFAULT_EXTERNALS,
      banner: { js: buildBannerFor() },
      // Resolve only from the bag's own tree. esbuild otherwise also searches
      // upward from its own binary — which lives inside this monorepo — so a
      // bag with no installed dependencies still "builds", silently inlining
      // the whole workspace graph. That masks a broken dependency locally and
      // breaks on any other machine.
      absWorkingDir: bag.bagDir,
      nodePaths: [],
      logLevel: "silent",
      // What the bundle was built from, recorded for isBagBuildStale.
      metafile: true,
    } as const;
    mkdirSync(outDir, { recursive: true });
    // Built one at a time, and a failure names which entry broke: with both a
    // tools and a prompt entry, a bare esbuild summary cannot say which.
    for (const [label, entryPoint, file] of [
      ["tools entry", bag.entry, "tools.js"],
      ["prompts entry", bag.promptsEntry, "prompt.js"],
    ] as const) {
      if (!entryPoint) continue;
      try {
        const result = await build({ ...options, entryPoints: [entryPoint], outfile: join(outDir, file) }) as { metafile?: unknown };
        writeFileSync(
          inputsFileFor(join(outDir, file)),
          JSON.stringify({ files: bundledSourceFiles(result.metafile, bag.bagDir) }),
        );
      } catch (error) {
        if (error instanceof Error) error.message = `${label} ${entryPoint}: ${error.message}`;
        throw error;
      }
    }

    linkBagExternals(bag, outDir);

    // The bundle is ESM, and nothing above it in the cache says so. Plain Node
    // detects that; tsx loads it as CommonJS, turning its imports into
    // require() calls that run before the banner's `const require` exists.
    // That only stays hidden while esbuild renames the binding, and a bundled
    // dependency with a direct eval() stops the rename: amazon-commerce
    // (bottleneck) then loaded in production but threw "Cannot access
    // 'require' before initialization" under tsx. Declared, both hosts agree.
    writeFileSync(join(outDir, "package.json"), '{ "type": "module" }\n');

    return { name: bag.name, ok: true, outFile, bytes: statSync(outFile).size };
  } catch (error) {
    // esbuild throws a BuildFailure carrying `errors: Message[]` (file, line,
    // column, text). Keeping only `.message` discards every location, and its
    // first line is just a count header — so a caller that truncates to one
    // line reports a failure with no detail at all. Carry both.
    const esbuildErrors = (error as { errors?: { text?: string; location?: { file?: string; line?: number; column?: number } | null }[] }).errors;
    return {
      name: bag.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(Array.isArray(esbuildErrors) && esbuildErrors.length > 0
        ? {
            errors: esbuildErrors.map((e) => ({
              text: e.text ?? "",
              ...(e.location?.file ? { file: e.location.file } : {}),
              ...(e.location?.line ? { line: e.location.line } : {}),
              ...(e.location?.column !== undefined ? { column: e.location.column } : {}),
            })),
          }
        : {}),
    };
  }
}

/**
 * A bag's own `barry.build.externals`, linked beside its bundle.
 *
 * esbuild leaves an external out of the bundle, so the bundle imports it at
 * runtime from the build cache — where `linkExternals` links only
 * DEFAULT_EXTERNALS. A bag-declared external was therefore left out and then
 * unresolvable, failing the whole bag at load. Linked into the bag's own build
 * directory, so two bags pinning different versions cannot collide. One that
 * cannot be found fails the build by name rather than the load by surprise.
 */
function linkBagExternals(bag: BuildableBag, outDir: string): void {
  for (const name of bag.externals ?? []) {
    const target = findPackageDir(name, bag.bagDir);
    if (!target) {
      throw new Error(`external "${name}" is not installed where ${bag.bagDir} can resolve it`);
    }
    const linkPath = join(outDir, "node_modules", name);
    mkdirSync(dirname(linkPath), { recursive: true });
    if (existsSync(linkPath) || isBrokenSymlink(linkPath)) rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(installationPath(target), linkPath, "dir");
  }
}

export interface BuildBagsOptions {
  /** Rebuild even when the existing output is newer than every source file. */
  force?: boolean;
  /** Restrict the build to these bag names. */
  only?: string[];
  onProgress?: (result: BagBuildResult) => void;
}

export async function buildBags(options: BuildBagsOptions = {}): Promise<BagBuildResult[]> {
  const { force = false, only, onProgress } = options;
  let bags = discoverBuildableBags();
  if (only?.length) {
    const wanted = new Set(only);
    bags = bags.filter((p) => wanted.has(p.name));
  }

  const results: BagBuildResult[] = [];
  for (const bag of bags) {
    if (!force && !isBagBuildStale(bag)) {
      const outFile = join(getBagBuildDir(bag.name, bag.bagDir), bag.entry ? "tools.js" : "prompt.js");
      const cached: BagBuildResult = {
        name: bag.name,
        ok: true,
        outFile,
        bytes: statSync(outFile).size,
      };
      results.push(cached);
      onProgress?.(cached);
      continue;
    }

    const result = await buildBag(bag);
    results.push(result);
    onProgress?.(result);
  }

  return results;
}

/**
 * Build anything missing or stale. Called at MCP startup: the build directory is
 * a cache and may be purged by macOS or a cleanup tool at any time, so its
 * absence must self-heal rather than silently drop every bag's tools.
 */
export async function ensureBagsBuilt(): Promise<BagBuildResult[]> {
  // Resolve externals from the repo root rather than process.cwd(): the MCP
  // server runs with cwd=engine, where several externals are invisible.
  const { missing } = linkExternals(repoRoot());
  // An unlinked external is not cosmetic — every bag importing it fails at
  // load with "Cannot find package", and the caller only sees a smaller tool
  // count. Surfacing it here is what turns a silent 310 -> 288 into a signal.
  if (missing.length > 0) {
    log.error(`[bags] externals could not be linked: ${missing.join(", ")}`);
  }

  const results = await buildBags({ force: false });
  // Full build — the discovered set is authoritative, so anything else under
  // the build root is orphaned output that nothing will read again.
  try {
    pruneOrphanedBagBuilds(discoverBuildableBags());
  } catch {
    // Pruning is housekeeping; never let it fail a build.
  }
  return results;
}

/**
 * Resolved path of a bag's built entry, or null when it has not been built.
 *
 * `bagDir` identifies the checkout: build output is keyed by source directory
 * so two checkouts of one bag cannot collide.
 */
export function getBuiltBagEntry(bagName: string, bagDir: string): string | null {
  const outFile = join(getBagBuildDir(bagName, bagDir), "tools.js");
  if (!existsSync(outFile)) return null;
  // Every in-process bundle load goes through here, so the running checkout's
  // builtin directory is made visible first: the bundle's pinned path is only a
  // fallback, and it goes stale when the directory moves.
  shareBuiltinDirWithBundles();
  return outFile;
}

/**
 * Path to a bag's built prompt entry, building it first when missing or stale.
 *
 * Builds the prompt entry ALONE: this runs on the session-start path, where
 * rebuilding a bag's whole tool surface would be cost with no reader. Staleness
 * is judged against prompt.js only for the same reason — measured against the
 * older of both outputs, a bag whose tools.js lags would rebuild every session.
 *
 * Links the shared externals first. The bundle lives in the build cache and
 * resolves native packages (better-sqlite3) from there; only the MCP server's
 * startup linked them, so a prompt built from the CLI could not load.
 */
export async function ensureToolsBuilt(bag: BuildableBag): Promise<string> {
  if (!bag.entry) throw new Error(`bag "${bag.name}" declares no tools entry`);
  const toolsOnly: BuildableBag = { name: bag.name, bagDir: bag.bagDir, entry: bag.entry, externals: bag.externals };
  const existing = getBuiltBagEntry(bag.name, bag.bagDir);
  if (existing && !isBagBuildStale(toolsOnly)) return existing;
  linkExternals(repoRoot());
  const result = await buildBag(toolsOnly);
  if (!result.ok) throw new Error(`[bag "${bag.name}"] ${result.errors?.map(error => `${error.file ? error.file + ": " : ""}${error.text}`).join("; ") || result.error || "tools build failed"}`);
  const built = getBuiltBagEntry(bag.name, bag.bagDir);
  if (!built) throw new Error(`tools build for "${bag.name}" produced no output`);
  return built;
}

export async function ensurePromptBuilt(bag: BuildableBag): Promise<string> {
  if (!bag.promptsEntry) throw new Error(`bag "${bag.name}" declares no prompts entry`);
  const promptOnly: BuildableBag = { name: bag.name, bagDir: bag.bagDir, promptsEntry: bag.promptsEntry };
  const existing = getBuiltPromptEntry(bag.name, bag.bagDir);
  if (existing && !isBagBuildStale(promptOnly)) return existing;
  linkExternals(repoRoot());
  const result = await buildBag(promptOnly);
  if (!result.ok) throw new Error(result.errors?.map((e) => e.text).join("; ") || result.error || "prompt build failed");
  const built = getBuiltPromptEntry(bag.name, bag.bagDir);
  if (!built) throw new Error(`prompt build for "${bag.name}" produced no output`);
  return built;
}

/** Resolve a built prompt contributor entry. */
export function getBuiltPromptEntry(bagName: string, bagDir: string): string | null {
  const outFile = join(getBagBuildDir(bagName, bagDir), "prompt.js");
  return existsSync(outFile) ? outFile : null;
}

export function clearBagBuilds(): void {
  const root = getBagsBuildRoot();
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

/**
 * Remove build directories no longer claimed by a registered bag.
 *
 * Build dirs are keyed by bag name *and* source directory, so they accumulate:
 * a removed bag, a deleted worktree, or the pre-scoping name-only layout all
 * leave output behind that nothing will ever read again. Harmless but unbounded
 * — this had grown to 160MB, half of it orphans.
 *
 * Returns the directory names it removed.
 */
export function pruneOrphanedBagBuilds(bags: BuildableBag[]): string[] {
  const root = getBagsBuildRoot();
  if (!existsSync(root)) return [];

  const live = new Set(bags.map((p) => basename(getBagBuildDir(p.name, p.bagDir))));
  // node_modules holds the external symlinks every built bag resolves through
  // (linkExternals). Named explicitly rather than relying on the shape check
  // below, since a package inside it can legitimately be called tools.js.
  live.add("node_modules");

  const removed: string[] = [];

  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (live.has(entry)) continue;

    // Delete only what is recognisably bag build output: a directory holding a
    // tools.js. This runs on every build, so it must not be a general "remove
    // anything unrecognised" sweep — node_modules lives here too (the external
    // symlinks every bag resolves through), and removing it took eight bags
    // down. Opt-in beats opt-out for anything that deletes on a hot path.
    if (!statSync(full).isDirectory()) continue;
    if (!existsSync(join(full, "tools.js")) && !existsSync(join(full, "prompt.js"))) continue;

    rmSync(full, { recursive: true, force: true });
    removed.push(entry);
  }

  return removed;
}

/**
 * Externals are not bundled, so Node must be able to resolve them from the
 * build directory. Node walks up from the importing file looking for
 * node_modules, so one shared directory at the build root serves every bag.
 *
 * Symlinking to the already-installed copies avoids a second install and keeps
 * native addons (better-sqlite3) working, since they are used in place.
 */
export function linkExternals(resolveFrom: string = process.cwd()): { linked: string[]; missing: string[] } {
  const root = getBagsBuildRoot();
  const nodeModules = join(root, "node_modules");
  mkdirSync(nodeModules, { recursive: true });

  const linked: string[] = [];
  const missing: string[] = [];

  for (const name of DEFAULT_EXTERNALS) {
    const target = findPackageDir(name, resolveFrom);
    if (!target) {
      missing.push(name);
      continue;
    }
    const linkPath = join(nodeModules, name);
    // Scoped packages need their @scope/ parent to exist first.
    if (name.includes("/")) mkdirSync(dirname(linkPath), { recursive: true });
    try {
      if (existsSync(linkPath) || isBrokenSymlink(linkPath)) rmSync(linkPath, { recursive: true, force: true });
      symlinkSync(installationPath(target), linkPath, "dir");
      linked.push(name);
    } catch {
      missing.push(name);
    }
  }

  return { linked, missing };
}

function isBrokenSymlink(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate an installed package's directory.
 *
 * A plain directory walk is not enough under pnpm: dependencies live in
 * node_modules/.pnpm and are only visible via the symlink farm of whichever
 * package declares them. So try Node's resolver from each candidate origin
 * first, then fall back to walking up for the hoisted layout.
 */
function findPackageDir(name: string, from: string): string | null {
  const origins = [from, ...bagDirsForResolution()];

  for (const origin of origins) {
    try {
      const require = createRequire(join(origin, "package.json"));
      // Some packages restrict "exports" and refuse package.json; resolving the
      // entry point and walking up to its package root works regardless.
      let resolved: string;
      try {
        resolved = require.resolve(`${name}/package.json`);
        return realpathSync(dirname(resolved));
      } catch {
        resolved = require.resolve(name);
      }
      let dir = dirname(resolved);
      for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // try the next origin
    }
  }

  let current = from;
  for (;;) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return findInPnpmStore(name, from);
}

/**
 * Last-resort lookup straight in pnpm's content store.
 *
 * Some externals are declared only by an individual bag, so they are invisible
 * from the repo root and from `engine` — which is the cwd the MCP server
 * runs under. Whether they resolve then depends on bag discovery succeeding,
 * and on a cold cache it does not: four externals silently failed to link and
 * eight bags came up missing, dropping the tool count 310 -> 288.
 *
 * The store layout is `<store>/<name>@<version>[_peers]/node_modules/<name>`,
 * so a prefix match finds it regardless of who declared it.
 */
function findInPnpmStore(name: string, from: string): string | null {
  const encoded = name.replace("/", "+");
  let current = from;

  for (let depth = 0; depth < 12; depth++) {
    const store = join(current, "node_modules", ".pnpm");
    if (existsSync(store)) {
      let entries: string[];
      try {
        entries = readdirSync(store);
      } catch {
        entries = [];
      }
      // Newest version wins when a package is installed at several.
      const candidates = entries.filter((e) => e.startsWith(`${encoded}@`)).sort().reverse();
      for (const entry of candidates) {
        const dir = join(store, entry, "node_modules", name);
        if (existsSync(join(dir, "package.json"))) return realpathSync(dir);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/** Bag directories are valid resolution origins for their own dependencies. */
function bagDirsForResolution(): string[] {
  try {
    return discoverBuildableBags().map((p) => p.bagDir);
  } catch {
    return [];
  }
}

/** Marker so a stray build directory is identifiable on disk. */
export function writeBuildMarker(): void {
  const root = getBagsBuildRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "README.txt"),
    "Generated by `barry bag build`. Safe to delete — Barry rebuilds on demand.\n",
    "utf-8",
  );
}
