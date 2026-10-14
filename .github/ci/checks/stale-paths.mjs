// Adapted from the pinned barry-devops checks for the single SDK package.
/** Validate concrete tooling references against tracked repository paths. */
import { readdir, readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { trackedPaths } from "./tracked-paths.mjs";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { toolingPathProblems } from "./tooling-paths.mjs";
import { installPathProblems } from "./install-path-references.mjs";

const repoRoot = process.cwd();
const checksRoot = fileURLToPath(new URL(".", import.meta.url));
const { barryAppSupportDir } = await import(pathToFileURL(path.join(repoRoot, "sdk/src/services/home.mjs")));
/** References resolve to what the checkout tracks (see tracked-paths.mjs). */
const tracked = trackedPaths(repoRoot);
const errors = [];

/** Directories never worth walking. */
// `.claude` holds other sessions' scratch worktrees — gitignored, not repo
// content. Walking it made this check's result depend on whatever a parallel
// session happened to have checked out, which is both flaky and not this
// check's business. `venv`/`tmp` are the same kind of local-only noise, and so
// is `.barry-dev`, the contributor instance `pnpm dev` keeps in the checkout.
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".wrangler", ".build",
  ".claude", ".worktrees", "venv", "tmp", ".barry-dev",
]);

async function walk(relativeDir, match, onFile) {
  await walkDir(repoRoot, relativeDir, match, onFile);
}

/** Walk an arbitrary root directory, calling onFile(rel) for each match. */
async function walkDir(root, relativeDir, match, onFile) {
  let entries;
  try {
    entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDir(root, rel, match, onFile);
    } else if (match(entry.name, rel)) {
      await onFile(rel);
    }
  }
}
/**
 * 1. GitHub workflow matrix paths.
 *
 * `path:`/`package-path:`/`working-directory:` naming a repo-relative directory.
 * Values with an expression (`${{ … }}`) are skipped — they are resolved from a
 * matrix entry elsewhere in the same file, which this check sees on its own line.
 */
async function checkWorkflowPaths() {
  await walk(".github", (name) => /\.ya?ml$/.test(name), async (rel) => {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      const m = /^\s*(?:-\s+)?(path|package-path|working-directory):\s*["']?([^"'\s#]+)["']?\s*$/.exec(line);
      if (!m) return;
      const value = m[2];
      if (value.includes("${{") || value.startsWith("~") || value.startsWith("/")) return;
      // `path: |` opens a block scalar (actions/cache lists several paths, each
      // typically templated); the entries land on their own lines.
      if (value === "|" || value === ">" || value === "|-" || value === ">-") return;
      // `path:` under actions/cache is a cache key glob, not a source directory.
      if (value.includes("*") || value.includes("node_modules/.cache/")) return;
      if (!tracked(path.join(repoRoot, value))) {
        errors.push(`${rel}:${i + 1}: ${m[1]} "${value}" does not exist`);
      }
    });
  });
}

/**
 * 2. Allowlist prefixes in check scripts.
 *
 * An allowlist entry naming a path that no longer exists is worse than useless:
 * it silently stops exempting whatever it was written to exempt, so the next run
 * reports deliberate survivors as fresh violations.
 */
async function checkAllowlistPrefixes() {
  await walkDir(checksRoot, ".", (name) => /\.mjs$/.test(name), async (rel) => {
    if (rel.endsWith("stale-paths.mjs")) return;
    const content = await readFile(path.join(checksRoot, rel), "utf8");
    // Validate both object prefixes and bare strings in skip lists.
    let inSkipList = false;
    content.split("\n").forEach((line, i) => {
      const report = (value) => {
        if (!value.includes("/")) return;
        if (!tracked(path.join(repoRoot, value))) {
          errors.push(`${rel}:${i + 1}: allowlist prefix "${value}" does not exist`);
        }
      };

      const objectForm = /prefix:\s*"([^"]+)"/.exec(line);
      if (objectForm) report(objectForm[1]);

      // SKIPPED_PREFIXES, on one line or spread across several.
      if (/SKIPPED_PREFIXES\s*=/.test(line)) inSkipList = true;
      if (inSkipList) {
        for (const m of line.matchAll(/"([^"]+)"/g)) report(m[1]);
        if (line.includes("]")) inSkipList = false;
      }
    });
  });
}

/**
 * 4. Repo-relative directory arguments in shell scripts.
 *
 * A wrapper script handing a directory to a helper — `deploy-worker.sh
 * sdks/links` — names a path nothing type-checks and nothing resolves until
 * the script runs. When sdks/links moved out to its own bag, two such wrappers
 * kept passing a directory that no longer existed, and this check reported
 * clean throughout: it did not read .sh files at all. That is the exact class
 * the header describes, so the omission made a green here mean less than it
 * looked like it did.
 *
 * Matches only an argument that follows an invoked *.sh and looks like a
 * repo-relative directory (`a/b`, no leading ./ ~ / $ and no glob), which is
 * the position those wrappers used. Quoted, variable and flag arguments are
 * left alone rather than guessed at.
 *
 * Note what this does and does not buy: as of writing it scans 36 .sh files
 * and matches ZERO lines, because the two scripts that used this shape were
 * deleted with the directories they named. So it currently passes by matching
 * nothing, which is the same thing a broken check looks like. It is here as a
 * tripwire for the next wrapper written in that shape, not as evidence about
 * today's tree — verified by recreating the deleted deploy-links.sh, which it
 * catches by file, line and path, and by a valid path, which it ignores. If
 * this grows a third failure mode, widen the match rather than trusting the
 * green.
 */
async function checkShellScriptPathArgs() {
  await walk(".", (name) => name.endsWith(".sh"), async (rel) => {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("#")) return;
      const m = /\.sh"?\s+([a-z][a-z0-9_-]*(?:\/[a-z0-9_.-]+)+)\s*$/.exec(line);
      if (!m) return;
      const value = m[1];
      if (value.includes("*") || value.includes("$")) return;
      if (!tracked(path.join(repoRoot, value))) {
        errors.push(`${rel}:${i + 1}: passes "${value}" to a script, but that path does not exist`);
      }
    });
  });
}

/** Validate documentation citations across source extensions, including line ranges. */
const CITING_SOURCE = /\.(mjs|js|ts|tsx|sql|sh|swift|yaml|yml)$/;

/** Fixture paths describe test inputs rather than repository citations. */
const IS_TEST = /\.(test|spec)\.[a-z]+$|(^|\/)(test|tests|__tests__)\//;

async function checkDocCitations() {
  const lineCounts = new Map();
  await walk(".", (name, rel) => CITING_SOURCE.test(name) && !IS_TEST.test(rel), async (rel) => {
    // Skip self, as checkAllowlistPrefixes does: this file's prose discusses
    // citations and would otherwise match its own examples.
    if (rel.endsWith("stale-paths.mjs")) return;
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    content.split("\n").forEach((line, i) => {
      // Include nested docs and their full repo-relative prefix: checking only
      // the docs/ suffix misreads a bag doc as a missing root doc.
      // `docs/` only. `principles/` was scanned here until those four
      // documents became the coding-principles bag; nothing in this repo can
      // cite them by path any more. Dropping the alternative rather than
      // guarding it with a word boundary also removes a false positive: the
      // pattern has no left anchor, so the bag's own name written in prose —
      // `coding-principles/naming.md` — matched on the substring and failed a
      // check for a file that was never claimed to be here.
      for (const m of line.matchAll(/\b(?:[a-z0-9-]+\/)*docs\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.md(?::(\d+)(?:-\d+)?)?/g)) {
        const [cited, lineNo] = [m[0], m[1]];
        const file = cited.split(":")[0];
        const abs = path.join(repoRoot, file);
        if (!tracked(abs)) {
          errors.push(`${rel}:${i + 1}: cites ${file}, which does not exist`);
          continue;
        }
        if (!lineNo) continue;
        if (!lineCounts.has(file)) {
          lineCounts.set(file, readFileSync(abs, "utf8").split("\n").length);
        }
        if (Number(lineNo) > lineCounts.get(file)) {
          errors.push(
            `${rel}:${i + 1}: cites ${cited}, but that file has only ${lineCounts.get(file)} lines`,
          );
        }
      }
    });
  });
}

/** Resolve relative tooling imports because untyped scripts still need valid module paths. */
const TOOLING_DIRS = [".github/ci", "sdk/scripts"];
async function checkToolingImports() {
  let checked = 0;
  const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  const roots = [...TOOLING_DIRS.map((dir) => [repoRoot, dir]), [checksRoot, "."]];
  for (const [root, dir] of roots) {
    await walkDir(root, dir, (name) => /\.(?:[cm]?[jt]s)$/.test(name), async (rel) => {
      const content = await readFile(path.join(root, rel), "utf8");
      content.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        for (const m of line.matchAll(specifier)) {
          const value = m[1];
          if (value.includes("${")) continue;
          checked += 1;
          const target = path.resolve(path.dirname(path.join(root, rel)), value);
          const candidates = [target];
          if (/\.m?js$/.test(target)) candidates.push(target.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts"));
          if (!candidates.some((c) => tracked(c))) {
            errors.push(`${rel}:${i + 1}: imports "${value}", which resolves to ${path.relative(repoRoot, target)} -- not tracked`);
          }
        }
      });
    });
  }
  if (checked === 0) errors.push(`${TOOLING_DIRS.join(", ")}: no relative imports matched -- rule 7 is not inspecting anything`);
}

/** Validate concrete repository paths in shell scripts, including extensionless shebang entries. */
const SHELL_DIRS = [".github/ci", "bags", "sdk/scripts", "cli/scripts", "scripts"];
const ROOT_VARS = /\$\{?(?:ROOT|ROOT_DIR|REPO_ROOT|BARRY_DIR|BARRY_ROOT)\}?\/([A-Za-z0-9_./-]+)/g;
const QUOTED_FILE = /["']((?:[a-z][a-z0-9_.-]*\/)+[A-Za-z0-9_.-]+\.(?:ts|mts|mjs|js|sh|json|ya?ml|py))["']/g;
async function checkShellScriptPaths() {
  let scripts = 0;
  for (const dir of SHELL_DIRS) {
    await walk(dir, (name) => name.endsWith(".sh") || !name.includes("."), async (rel) => {
      const content = await readFile(path.join(repoRoot, rel), "utf8");
      if (!rel.endsWith(".sh") && !/^#!.*\b(?:ba)?sh\b/.test(content.split("\n", 1)[0])) return;
      scripts += 1;
      content.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("#")) return;
        const seen = new Set();
        for (const m of line.matchAll(ROOT_VARS)) seen.add(m[1].replace(/[./]+$/, ""));
        for (const m of line.matchAll(QUOTED_FILE)) seen.add(m[1]);
        for (const value of seen) {
          if (!value || value.includes("$") || value.includes("*")) continue;
          // .env files are the operator's secrets, never tracked, and scripts
          // test for them before sourcing -- absent is a normal state.
          if (path.basename(value).startsWith(".env")) continue;
          // Runtime artifacts: log files, hidden dirs (.worktrees), and
          // other paths that are created at runtime, not checked-in source.
          // The monorepo rules avoid these via narrow directory scope;
          // external bags need explicit filtering.
          if (path.basename(value).endsWith(".log")) continue;
          if (value.split("/").some((s) => s.startsWith("."))) continue;
          if (!tracked(path.join(repoRoot, value))) {
            errors.push(`${rel}:${i + 1}: names "${value}", which the checkout does not track`);
          }
        }
      });
    });
  }
  if (scripts === 0) errors.push(`${SHELL_DIRS.join(", ")}: found no shell scripts -- rule 8 is not inspecting anything`);
}


/** Discover installed local bags and validate their repository references; unavailable or remote entries are skipped. */
function loadExternalBags() {
  const registryPath =
    process.env.BARRY_BAGS_SNAPSHOT ?? path.join(barryAppSupportDir(), "bags.snapshot.json");
  // A bare clone (CI) has no instance, so no external bags to check.
  if (!existsSync(registryPath)) return [];
  const { bags: entries = {} } = JSON.parse(readFileSync(registryPath, "utf8"));
  const bags = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.type !== "local" || !entry.path || entry.disabled || entry.access === "disabled") continue;
    const resolved = entry.path.startsWith("~") ? path.join(homedir(), entry.path.slice(1)) : entry.path;
    bags.push({ name, path: resolved });
  }
  return bags;
}

async function checkExternalBagPaths() {
  const bags = loadExternalBags();
  let scanned = 0;
  for (const bag of bags) {
    if (!existsSync(bag.path)) continue;
    scanned += 1;
    await walkDir(bag.path, ".", (name) => name.endsWith(".sh") || !name.includes("."), async (rel) => {
      const abs = path.join(bag.path, rel);
      // A symlink to a directory passes the name filter; only files hold paths.
      if (!statSync(abs).isFile()) return;
      const content = await readFile(abs, "utf8");
      if (!rel.endsWith(".sh") && !/^#!.*\b(?:ba)?sh\b/.test(content.split("\n", 1)[0])) return;
      content.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("#")) return;
        const seen = new Set();
        for (const m of line.matchAll(ROOT_VARS)) seen.add(m[1].replace(/[./]+$/, ""));
        for (const m of line.matchAll(QUOTED_FILE)) seen.add(m[1]);
        for (const value of seen) {
          if (!value || value.includes("$") || value.includes("*")) continue;
          if (path.basename(value).startsWith(".env")) continue;
          // Runtime artifacts: log files, hidden dirs (.worktrees), and
          // other paths that are created at runtime, not checked-in source.
          // The monorepo rules avoid these via narrow directory scope;
          // external bags need explicit filtering.
          if (path.basename(value).endsWith(".log")) continue;
          if (value.split("/").some((s) => s.startsWith("."))) continue;
          if (!tracked(path.join(repoRoot, value))) {
            errors.push(`[bag:${bag.name}] ${rel}:${i + 1}: names "${value}", which the barry checkout does not track`);
          }
        }
      });
    });
  }
  if (scanned > 0) {
    console.log(`stale-paths: scanned ${scanned} external bag(s) for repo-path references.`);
  }
}

async function checkMarkdownCodePaths() {
  const rootEntries = new Set(readdirSync(repoRoot));
  const roots = ["cli", "sdk", "bags", "adapters", "docs"];
  async function check(rel) {
    const source = await readFile(path.join(repoRoot, rel), "utf8");
    errors.push(...installPathProblems(source, rel, rootEntries, tracked, repoRoot));
  }
  await check("README.md");
  for (const root of roots) await walk(root, name => name.endsWith(".md"), check);
  for (const root of ["cli", "sdk", "bags", "adapters"]) await walk(root, (name, rel) => CITING_SOURCE.test(name) && !IS_TEST.test(rel), async rel => {
    errors.push(...installPathProblems(await readFile(path.join(repoRoot, rel), "utf8"), rel, rootEntries, tracked, repoRoot));
  });
}


function checkToolingSourcePrefixes() {
  const negations = readFileSync(".gitignore", "utf8").split("\n").filter(line => line.startsWith("!"));
  errors.push(...toolingPathProblems(".gitignore", negations, value => tracked(path.join(repoRoot, value))));
  const configs = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(file => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(file));
  for (const file of configs) {
    const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
    if (parsed.error) errors.push(`${file}: invalid TypeScript configuration`);
    else errors.push(...toolingPathProblems(file, parsed.config.include ?? [], value => tracked(path.join(repoRoot, value))));
  }
}

checkToolingSourcePrefixes();

await checkMarkdownCodePaths();
await checkWorkflowPaths();
await checkAllowlistPrefixes();
await checkShellScriptPathArgs();
await checkDocCitations();
await checkToolingImports();
await checkShellScriptPaths();
await checkExternalBagPaths();

if (errors.length > 0) {
  console.error("Stale path references:\n");
  for (const error of errors) console.error(`- ${error}`);
  console.error("\nEach reference names a path the checkout does not track (a file that is only on\ndisk, like an ignored leftover, does not count). Either the");
  console.error("target moved (repoint it) or it left the repo (drop it).");
  process.exit(1);
}

console.log("stale-paths: clean — every referenced path exists.");
