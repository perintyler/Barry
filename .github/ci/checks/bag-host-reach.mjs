// Adapted from the pinned barry-devops checks for the single SDK package.
/**
 * Enforce dependency direction from bags/README.md through actual import
 * reachability: reading a bag cannot load host-only transports; SDK contracts
 * do not import adapters, and adapters receive bag-owned resolvers.
 */
import { createRequire } from "node:module";
const { build } = createRequire(new URL("../../../sdk/package.json", import.meta.url))("esbuild");
import { readFileSync, existsSync } from "fs";
import { join, resolve, posix } from "path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "child_process";

export const COMPOSITION_ROOT_PACKAGES = new Set([
  "@barry-rocks/cli", "@barry-rocks/sessions-api", "@barry-rocks/identities-service",
  "@barry-rocks/mcp-bag", "@barry-rocks/scheduler-service", "@barry-rocks/workflows-runtime",
]);

export const ALLOWED_BAG_EDGES = [
  { from: "bags/actions", to: "bags/artifacts", until: "Barry.artifacts after D4" },
  { from: "bags/instructions", to: "bags/artifacts", until: "Barry.artifacts after D4" },
  { from: "bags/sessions/extensions/search", to: "bags/embeddings", until: "a vectors surface (C4's decision for the author)" },
];

const bagOf = dir => /^bags\/[^/]+/.exec(dir)?.[0];
const inside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/**
 * The bag sources rule 5 reads: tracked or new, never ignored. Listed by git,
 * which every checkout has; CI's static job installs no ripgrep.
 */
export function bagSourceFiles(root) {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "bags"], { cwd: root, encoding: "utf8" });
  return [...new Set(listed.split("\0"))].filter(path =>
    /\.(?:ts|tsx|js|mjs)$/.test(path) && !/(?:^|\/)(?:node_modules|dist)\//.test(path) && existsSync(join(root, path)));
}

/** Rule 5 consumes source text and package metadata without reading disk. */
export function checkBagImports(packages, files, root = "") {
  const relative = path => root && inside(path, root) ? path.slice(root.length + 1) : path;
  const entries = [...packages].map(([name, info]) => ({ name, ...info, dir: relative(info.dir) }));
  const failures = [];
  const ownerOf = path => entries.filter(p => inside(path, p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const targetOf = spec => entries.filter(p => spec === p.name || spec.startsWith(`${p.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
  function check(from, target, place) {
    if (!bagOf(from.dir) || COMPOSITION_ROOT_PACKAGES.has(from.name)) return;
    if (COMPOSITION_ROOT_PACKAGES.has(target.name)) {
      failures.push(`${place}: rule 5: ${from.name} names composition root ${target.name}`);
      return;
    }
    if (!bagOf(target.dir) || bagOf(from.dir) === bagOf(target.dir)) return;
    if (ALLOWED_BAG_EDGES.some(edge => inside(from.dir, edge.from) && inside(target.dir, edge.to))) return;
    failures.push(`${place}: rule 5: ${from.name} reaches ${target.name}; ask Barry instead`);
  }
  for (const from of entries) {
    for (const dep of Object.keys({ ...from.dependencies, ...from.devDependencies })) {
      const target = targetOf(dep);
      if (target) check(from, target, `${from.dir}/package.json`);
    }
  }
  for (const file of files) {
    const path = relative(file.path), from = ownerOf(path);
    if (!from || !bagOf(from.dir)) continue;
    // Covers static imports and re-exports, side-effect imports, dynamic imports,
    // require, and Vitest mocks. Comments are not executable dependency edges.
    const source = file.source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*)["'`]([^"'`]+)["'`]/g;
    for (const match of source.matchAll(imports)) {
      const spec = match[1];
      if (spec.startsWith(".")) {
        const targetPath = posix.normalize(posix.join(posix.dirname(path), spec));
        if (!inside(targetPath, bagOf(from.dir)) && /^(bags|cli|adapters)\//.test(targetPath)) {
          failures.push(`${path}: rule 5: relative import ${spec} leaves ${bagOf(from.dir)}`);
        }
        const target = ownerOf(targetPath);
        if (target) check(from, target, path);
      } else {
        const target = targetOf(spec);
        if (target) check(from, target, path);
      }
    }
  }
  return failures;
}

async function main() {
const ROOT = process.cwd();

/** Modules a bag must never reach. */
const HOST_MODULES = [
  "sdk/src/mcp/remote.ts",
  "sdk/src/mcp/cache.ts",
  "sdk/src/mcp/transport.ts",
];

/**
 * Bag entrypoints that import the loader. Listed explicitly rather than
 * globbed: a glob that silently matches nothing is the same false pass as (1).
 */
const WITNESS = "sdk/src/bags/loader.ts";

/**
 * Each entrypoint with the workspace module it must be shown to traverse —
 * the proof that resolution worked, so an empty reach means something.
 *
 * The loader was once the witness for everything, because every entry listed
 * here imported it. A bag's prompt entry need not: memory's reaches the SDK
 * through `definePrompt` and has no business near the loader, so demanding it
 * would have forced either a pointless import or leaving the entry unchecked.
 */
const BAG_ENTRYPOINTS = [
  ["bags/actions/src/tools.ts", WITNESS],
  ["bags/identities/src/store/identity-bags.ts", WITNESS],
  ["bags/identities/src/selectable-traits.ts", WITNESS],
  ["bags/instructions/src/tools.ts", WITNESS],
  ["bags/sessions/api/src/routes/actions.ts", WITNESS],
  ["bags/sessions/api/src/session-runtime.ts", WITNESS],
  // Runs in a child process at every session start, in CLI and API alike.
  ["bags/memory/prompt.ts", "sdk/src/tools/define-prompt.ts"],
];

/**
 * Trees that hold workspace packages.
 *
 * Filtered against disk at startup rather than listed and hoped for: `find`
 * exits non-zero when any root is missing, so a dissolved directory turned
 * this check into a crash. Filtering alone would be the opposite failure — a
 * typo'd root would silently narrow the search — so the count of packages
 * found is asserted below.
 */
const WORKSPACE_ROOTS = ["bags", "sdk", "cli", "adapters", "engine"].filter((r) =>
  existsSync(join(ROOT, r)),
);

function workspacePackages() {
  // `packages/` is empty now -- everything moved to sdk/ or bags/ -- and find
  // exits non-zero on a root that does not exist, which took this check down
  // on any tree without the untracked leftover directory. Filtering to roots
  // that exist keeps that from being an error; the count assertion below is
  // what keeps it from silently becoming a no-op.
  const roots = WORKSPACE_ROOTS;
  const out = execFileSync(
    "find",
    [...roots, "-name", "package.json",
     "-not", "-path", "*/node_modules/*", "-maxdepth", "4"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const pkgs = new Map();
  for (const rel of out.trim().split("\n").filter(Boolean)) {
    try {
      const json = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
      if (json.name) pkgs.set(json.name, { ...json, dir: resolve(ROOT, rel, "..") });
    } catch {
      // A malformed package.json is not this check's business.
    }
  }
  // A resolver that resolves nothing reaches nothing, and would pass every
  // assertion below. The repo has ~38 workspace packages; a collapse to a
  // handful means the roots or the find broke, not that packages left.
  if (pkgs.size < 20) {
    console.error(
      `workspace resolution found only ${pkgs.size} packages under ` +
        `${WORKSPACE_ROOTS.join(", ")} — too few to be a real result. Every reach ` +
        `measurement below would be meaningless.`,
    );
    process.exit(1);
  }
  return pkgs;
}

/**
 * Resolves `@barry-rocks/*` to real files through each package's `exports`
 * map, so bag dependencies reach their actual workspace owners. Third-party
 * deps stay external; none are host-classed, so excluding them cannot hide
 * the edge under test.
 */
function workspacePlugin(pkgs) {
  return {
    name: "workspace",
    setup(b) {
      b.onResolve({ filter: /^@barry-rocks\// }, (a) => {
        let best = null;
        for (const name of pkgs.keys()) {
          if (a.path === name || a.path.startsWith(name + "/")) {
            if (!best || name.length > best.length) best = name;
          }
        }
        if (!best) return { external: true };
        const { dir, exports: exp } = pkgs.get(best);
        const sub = a.path === best ? "." : "./" + a.path.slice(best.length + 1);
        let target = exp?.[sub];
        if (target && typeof target === "object") target = target.import ?? target.default ?? target.types;
        if (typeof target !== "string") return { external: true };
        const p = resolve(dir, target);
        return existsSync(p) ? { path: p } : { external: true };
      });
    },
  };
}

async function reachOf(entry, witness, pkgs) {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true, write: false, metafile: true,
    platform: "node", format: "esm", logLevel: "silent",
    plugins: [workspacePlugin(pkgs)],
    packages: "external",
  });
  const inputs = Object.keys(result.metafile.inputs);
  const reaches = source => {
    const compiled = source.replace("sdk/src/", "sdk/dist/").replace(/\.ts$/, ".js");
    return inputs.some(input => input.endsWith(source) || input.endsWith(compiled));
  };
  return {
    hostHits: HOST_MODULES.filter(reaches),
    traversedWitness: reaches(witness),
    moduleCount: inputs.length,
  };
}

const pkgs = workspacePackages();
const failures = [];
for (const module of ["traits", "bounds", "identities", "sessions", "tools", "adapters/harnesses", "adapters/decisions"]) {
  const entry = `sdk/src/${module}/index.ts`;
  if (!existsSync(join(ROOT, entry))) { failures.push(`missing standalone module: ${entry}`); continue; }
  const result = await build({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, metafile: true, platform: "node", format: "esm", logLevel: "silent", plugins: [workspacePlugin(pkgs)], packages: "external" });
  const violations = Object.keys(result.metafile.inputs).filter(input => input.startsWith("adapters/") || input.startsWith("bags/") || input.startsWith("cli/") || input.startsWith("runtime/") || input.startsWith("engine/"));
  if (violations.length) failures.push(`${entry} reaches application implementation: ${violations.join(", ")}`);
}


for (const [entry, witness] of BAG_ENTRYPOINTS) {
  if (!existsSync(join(ROOT, entry))) {
    failures.push(`${entry}: listed entrypoint does not exist (update this check or restore the file)`);
    continue;
  }
  let reach;
  try {
    reach = await reachOf(entry, witness, pkgs);
  } catch (err) {
    failures.push(`${entry}: could not be analyzed — ${String(err).split("\n").slice(0, 3).join(" ")}`);
    continue;
  }
  if (!reach.traversedWitness) {
    failures.push(
      `${entry}: did not traverse ${witness} (${reach.moduleCount} modules bundled). ` +
        `Either it no longer imports that module — pick another witness — or workspace ` +
        `resolution broke and this measurement is meaningless.`,
    );
    continue;
  }
  if (reach.hostHits.length > 0) {
    failures.push(`${entry}: reaches host-only ${reach.hostHits.join(", ")}`);
  }
}

/** SDK contracts cannot depend on adapter implementations; see bags/README.md. */
/** Identify implementation packages by their adapter directory, independent of package names. */
const IMPLEMENTATION_PACKAGES = new Set(
  [...pkgs].filter(([, { dir }]) => dir.slice(ROOT.length + 1).startsWith("adapters/")).map(([name]) => name),
);
if (IMPLEMENTATION_PACKAGES.size === 0) {
  failures.push(
    "found no implementation packages under adapters/ — rules 2 and 3 cannot catch anything",
  );
}

// The SDK includes explicit adapter application composition, so rule 2 keeps
// its existing exemption; rule 5's process roots remain the six named above.
let sdkPackagesChecked = 0;
for (const [name, { dir }] of pkgs) {
  const rel = dir.slice(ROOT.length + 1);
  if (rel !== "sdk" && !rel.startsWith("sdk/")) continue;
  sdkPackagesChecked += 1;
  if (name === "@barry-rocks/sdk" || COMPOSITION_ROOT_PACKAGES.has(name)) continue;
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (IMPLEMENTATION_PACKAGES.has(dep)) {
      failures.push(
        `${rel}/package.json: ${name} depends on ${dep}. A contract must not name an ` +
          `implementation — take a resolver as an argument and let a composition root supply it.`,
      );
    }
  }
}
if (sdkPackagesChecked === 0) {
  failures.push("rule 2 inspected no sdk/ package — the rule is not running");
}

/**
 * RULE 3: a builtin bag must not depend on an implementation either.
 *
 * Same rule, one tree over, and the one that actually kept being violated:
 * four bags declared an LLM package they reached through a contract subpath,
 * and two named `@barry-rocks/ollama` outright. A bag that imports a
 * vendor has skipped the injection the composition root exists to perform, and
 * pins Barry to one backend for everyone who installs that bag.
 *
 * A service ENTRY POINT inside a bag is the exception, because it IS a
 * composition root — it is the process that starts, so it is entitled to name
 * what it ships. Listed by package, not waved through by filename, so a new
 * one is a deliberate decision.
 */
const COMPOSITION_ROOTS = COMPOSITION_ROOT_PACKAGES;
let builtinPackagesChecked = 0;
for (const [name, { dir }] of pkgs) {
  const rel = dir.slice(ROOT.length + 1);
  if (!rel.startsWith("bags/")) continue;
  builtinPackagesChecked += 1;
  if (COMPOSITION_ROOTS.has(name)) continue;
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (IMPLEMENTATION_PACKAGES.has(dep)) {
      failures.push(
        `${rel}/package.json: bag ${name} depends on ${dep}. Bags resolve an interface; ` +
          `the composition root injects the implementation at boot.`,
      );
    }
  }
}
if (builtinPackagesChecked === 0) {
  failures.push("rule 3 inspected no bags/ package — the rule is not running");
}

/**
 * RULE 4: the vendors package depends on the SDK and nothing else.
 *
 * Every process that hosts a bag loads it — the API, the engine, the CLI, each
 * job — so one vendor SDK added here would be paid by all of them. A vendor is
 * its models and a few `fetch` calls; anything more belongs in a harness.
 */
const KIND_PACKAGES = [...pkgs].filter(([, { dir }]) => {
  const relative = dir.slice(ROOT.length + 1);
  return relative.startsWith("adapters/completions/") || relative.startsWith("adapters/decisions/") || relative.startsWith("adapters/embeddings/");
});
const kindPackagesChecked = [];
for (const kind of ["completions", "decisions", "embeddings"]) {
  if (!KIND_PACKAGES.some(([, { dir }]) => dir.slice(ROOT.length + 1).startsWith(`adapters/${kind}`))) {
    failures.push(`rule 4 found no ${kind} implementation packages`);
  }
}
for (const [name, { dir }] of KIND_PACKAGES) {
  const kindDir = dir.slice(ROOT.length + 1);
  kindPackagesChecked.push(kindDir);
  const allowed = new Set(["@barry-rocks/sdk"]);
  if (["adapters/decisions/typesafe", "adapters/decisions/von"].includes(kindDir)) allowed.add("@barry-rocks/decision-systemone");
  if (kindDir === "adapters/decisions/anthropic") allowed.add("@barry-rocks/completion-anthropic");
  if (["adapters/decisions/ollama", "adapters/embeddings/ollama"].includes(kindDir)) allowed.add("@barry-rocks/completion-ollama");
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (!allowed.has(dep)) failures.push(`${kindDir}/package.json: ${name} depends on ${dep}; only SDK contracts and its specific shared transport are allowed`);
  }
}

// Rules 5 and 6: bag boundaries and deliberate package roots.
const bagPackages = [...pkgs].filter(([, p]) => bagOf(p.dir.slice(ROOT.length + 1)));
const paths = bagSourceFiles(ROOT);
if (bagPackages.length < 20) failures.push(`rule 5 scanned only ${bagPackages.length} bag packages`);
if (!paths.length) failures.push("rule 5 scanned no files");
failures.push(...checkBagImports(pkgs, paths.map(path => ({ path, source: readFileSync(join(ROOT, path), "utf8") })), ROOT));
const rootExports = new Map([
  ["@barry-rocks/actions-bag", [".", "./db"]],
  ["@barry-rocks/events-bag", [".", "./db"]],
  ["@barry-rocks/schedules-bag", ["."]],
  ["@barry-rocks/tracker-bag", ["."]],
  ["@barry-rocks/locks-bag", ["."]],
  ["@barry-rocks/workflows-bag", ["."]],
  ["@barry-rocks/identities-bag", [".", "./testing"]],
]);
for (const [name, allowed] of rootExports) {
  const pkg = pkgs.get(name);
  if (!pkg || JSON.stringify(Object.keys(pkg.exports ?? {}).sort()) !== JSON.stringify([...allowed].sort())) {
    failures.push(`rule 6: ${name} must export exactly ${allowed.join(", ")}`);
  }
}
console.log("Allowed bag edges (from | to | removed by):");
for (const edge of ALLOWED_BAG_EDGES) console.log(`${edge.from} | ${edge.to} | ${edge.until}`);
console.log("Temporary exports: actions ./db and events ./db belong to D2b's cli/src/commands/db.ts; identities ./testing supports tests.");
console.log(`rule 5 scanned ${bagPackages.length} bag packages and ${paths.length} files`);

if (failures.length > 0) {
  console.error("boundary check FAILED:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nA bag must not reach host-only machinery. If a bag genuinely needs remote bag\n` +
      `discovery, take it as an injection the host installs — see\n` +
      `sdk/lib/src/host/remote-loader.ts and the dissolution record in barry-history.`,
  );
  process.exit(1);
}

console.log(
  `boundaries OK — ${BAG_ENTRYPOINTS.length} entrypoints each traversing its witness; ${kindPackagesChecked.length} vendor call packages checked; ` +
    `${sdkPackagesChecked} sdk/ and ${builtinPackagesChecked} bags/ packages name none of the ` +
    `${IMPLEMENTATION_PACKAGES.size} implementation packages.`,
);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
