import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { compiledPackageErrors } from "./compiled-package.mjs";
import { getUnitScript } from "./ci/unit-test-script.mjs";

const repoRoot = process.cwd();

const ENTRY_SPECS = JSON.parse(readFileSync(path.join(repoRoot, "workspace-entries.json"), "utf8"));

// Derived from workspace-entries.json rather than hand-written.
//
// The literal list this replaces had gone stale in the worst direction: it named
// `agents`, `apps`, `hooks`, `sdks`, `servers` and `tools` (all dissolved) while
// missing `sdk`, `engine` and `adapters` (all live). Note `sdks` vs `sdk` --
// one letter, and every sdk/* package fell out of scope. Measured when found:
// 19 of the 36 declared workspaces were never walked, so the repo's broadest
// policy gate was silently policing barely half the tree and passing.
//
// This file already reads workspace-entries.json above and cross-checks it
// against what is on disk, so deriving the roots from the same file is what
// makes the two halves structurally unable to disagree. A root cannot go stale
// without the inventory itself going stale, which is what the check reports.
const WORKSPACE_ROOTS = [...new Set(Object.keys(ENTRY_SPECS).map((entry) => entry.split("/")[0]))].sort();

const IGNORED_SEGMENTS = new Set(["node_modules", "dist", "build", ".wrangler", ".git"]);

// Directories that are a package AND hold nested packages, so the walk must not
// stop at the first package.json. Derived for the same reason as the roots: this
// named `tools`, which no longer exists, while `engine` -- a package that holds
// engine/secrets -- was absent, so that workspace stayed invisible even once the
// roots were right.
const CONTAINER_PACKAGES = new Set(
  Object.keys(ENTRY_SPECS).filter(
    (entry) =>
      existsSync(path.join(repoRoot, entry, "package.json")) &&
      Object.keys(ENTRY_SPECS).some((other) => other !== entry && other.startsWith(`${entry}/`)),
  ),
);

function isDistPath(value) {
  return typeof value === "string" && /(^|\/)dist\//.test(value.replace(/^\.\//, ""));
}

function collectStringLeaves(value, acc = []) {
  if (typeof value === "string") {
    acc.push(value);
    return acc;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, acc);
    }
    return acc;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectStringLeaves(entry, acc);
    }
  }

  return acc;
}

async function walkForPackageDirs(relativeDir, results) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  let entries;

  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  const hasPackageJson = entries.some((entry) => entry.isFile() && entry.name === "package.json");
  if (hasPackageJson) {
    results.add(relativeDir);
    // Continue recursing for directories that are both a package and a container (e.g. tools/)
    if (!CONTAINER_PACKAGES.has(relativeDir)) {
      return;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (IGNORED_SEGMENTS.has(entry.name)) {
      continue;
    }

    const childRelative = path.posix.join(relativeDir, entry.name);
    await walkForPackageDirs(childRelative, results);
  }
}

async function getWorkspacePackageDirs() {
  const results = new Set();

  for (const root of WORKSPACE_ROOTS) {
    await walkForPackageDirs(root, results);
  }

  return Array.from(results).sort();
}

function expect(condition, message, errors) {
  if (!condition) {
    errors.push(message);
  }
}

function checkSourceStart(pkg, relPath, errors) {
  expect(typeof pkg.scripts?.start === "string", `${relPath}: runtime edge must define scripts.start`, errors);
  expect(/\btsx\b/.test(pkg.scripts?.start ?? ""), `${relPath}: scripts.start should run through tsx for the source-first runtime path`, errors);
  expect(!isDistPath(pkg.main), `${relPath}: runtime edge should not advertise dist/* as main`, errors);
}

function checkSourceBin(pkg, relPath, errors) {
  const binLeaves = collectStringLeaves(pkg.bin);
  expect(binLeaves.length > 0, `${relPath}: runtime edge must define a bin entry`, errors);
  expect(binLeaves.every((value) => !isDistPath(value)), `${relPath}: bin entries should not point at dist/*`, errors);
  expect(!isDistPath(pkg.main), `${relPath}: runtime edge should not advertise dist/* as main`, errors);
}

function checkBundleSource(pkg, relPath, errors) {
  checkSourceStart(pkg, relPath, errors);
  expect(typeof pkg.scripts?.["build:http"] === "string", `${relPath}: bundled runtime edge must define scripts.build:http`, errors);
}

function checkContainer(pkg, relPath, errors) {
  expect(existsSync(path.join(repoRoot, relPath, "Dockerfile")), `${relPath}: container runtime edge must ship a Dockerfile`, errors);
  expect(!isDistPath(pkg.main), `${relPath}: container runtime edge should not advertise dist/* as main`, errors);
}

function checkWrangler(pkg, relPath, errors) {
  const dev = pkg.scripts?.dev ?? "";
  const deploy = pkg.scripts?.deploy ?? "";
  expect(/\bwrangler\b/.test(dev) || /\bwrangler\b/.test(deploy), `${relPath}: worker runtime edge must define a wrangler-based dev or deploy script`, errors);
}

function checkInternalPackage(pkg, relPath, errors) {
  expect(!isDistPath(pkg.main), `${relPath}: internal package main should stay source-first`, errors);
  const exportLeaves = collectStringLeaves(pkg.exports);
  expect(exportLeaves.every((value) => !isDistPath(value)), `${relPath}: internal package exports should not point at dist/*`, errors);
}

// Directories whose *source* is genuinely JavaScript (not TypeScript build output).
// A .js file here is real source, not a stale sibling of a .ts file.
//
// Empty as of the barry-web extraction. It held `packages/ui` and
// `packages/themes`, which are now their own repo, plus `sdks/` — a directory
// that never existed here at all. An allowlist entry for a path that is not on
// disk cannot fail; it just silently exempts nothing, so a stale one reads as
// coverage that was never there.
const REAL_JS_PREFIXES = [];

function isRealJsSource(relFile) {
  if (REAL_JS_PREFIXES.some((p) => relFile.startsWith(p))) return true;
  // Test fixtures legitimately ship parallel same-name files across languages
  // (e.g. sample.js next to sample.ts as syntax-highlighter inputs).
  if (/(^|\/)(fixtures|__fixtures__|__tests__\/fixtures)\//.test(relFile)) return true;
  return false;
}

// Source-first runtime: nothing should ship compiled .js next to its .ts source
// (no tsconfig sets outDir/noEmit locally — they all extend tsconfig.base.json's
// noEmit). A .js beside a .ts is stale tsc output; fail so it can't recur.
/**
 * Fails a workspace that ships test files no script runs.
 *
 * `run-unit-tests.mjs` discovers suites from workspace manifests, so a package
 * with test files but no test script is skipped in silence — its tests look
 * like coverage while never executing. This has happened three times
 * (`bags/git`, `bags/artifacts`, `bags/filesystem`), each caught by hand
 * long after the fact, so it is a policy check rather than a convention.
 *
 * The runner's own predicate is imported rather than reimplemented: if the two
 * disagreed, a package could pass this check and still be skipped.
 */
async function checkOrphanedTests(errors) {
  for (const relPath of Object.keys(ENTRY_SPECS).sort()) {
    const manifestPath = path.join(repoRoot, relPath, "package.json");
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }

    if (getUnitScript(manifest)) continue;

    const testFiles = [];
    async function walk(relativeDir) {
      let entries;
      try {
        entries = await readdir(path.join(repoRoot, relativeDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (IGNORED_SEGMENTS.has(entry.name)) continue;
          const childRelative = path.posix.join(relativeDir, entry.name);
          // Stop at nested workspace packages: their tests are their own
          // responsibility and the runner discovers them from their manifest.
          // Without this, a parent like bags/filesystem is blamed for the tests of
          // bags/filesystem/{locks,tracker}, which each already run vitest.
          if (existsSync(path.join(repoRoot, childRelative, "package.json"))) continue;
          await walk(childRelative);
          continue;
        }
        if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
          testFiles.push(path.posix.join(relativeDir, entry.name));
        }
      }
    }
    await walk(relPath);

    if (testFiles.length > 0) {
      const shown = testFiles.slice(0, 3).join(", ");
      const more = testFiles.length > 3 ? `, +${testFiles.length - 3} more` : "";
      errors.push(
        `${relPath}: ships ${testFiles.length} test file(s) but no unit-test script, so CI never runs them (${shown}${more}) — add "test": "vitest run"`,
      );
    }
  }
}

async function checkNoStaleJsSiblings(errors) {
  const stale = [];

  async function walk(relativeDir) {
    let entries;
    try {
      entries = await readdir(path.join(repoRoot, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const entry of entries) {
      const rel = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SEGMENTS.has(entry.name) || entry.name === ".git") continue;
        await walk(rel);
        continue;
      }
      const m = entry.name.match(/^(.*)\.(js|jsx)$/);
      if (!m) continue;
      if (isRealJsSource(rel)) continue;
      const tsSibling = `${m[1]}.ts`;
      const tsxSibling = `${m[1]}.tsx`;
      if (names.has(tsSibling) || names.has(tsxSibling)) {
        stale.push(rel);
      }
    }
  }

  for (const root of WORKSPACE_ROOTS) {
    await walk(root);
  }

  for (const file of stale) {
    errors.push(`${file}: stale compiled .js sits beside its .ts source (source-first runtime emits nothing — delete it)`);
  }
}

// Bag tools run inside the MCP server and should read API-key secrets from the
// injected `context.secrets` (per-profile, rotatable, vault-backed), never from
// ambient process.env. Flag process.env reads of secret-shaped names under
// bags/*/src so the contract can't silently regress. Non-secret config env
// (hosts, ports, IDs, paths, etc.) is allowed.
const SECRET_ENV_PATTERN = /process\.env\.([A-Z0-9_]*(?:API_KEY|APP_KEY|_TOKEN|_SECRET|SECRET_KEY|ACCESS_KEY|REFRESH_TOKEN|CLIENT_SECRET|AUTH_TOKEN))\b/g;
// Names that match the pattern but are not per-profile secrets.
const EMPTY_SET = new Set();
const SECRET_ENV_ALLOWLIST = new Set([
  "BARRY_SESSION_ID", // path component, not a secret
  "BARRY_SECRET",     // the platform's own auth secret (ambient, not per-profile);
                      // the core bag uses it to call the Barry API
]);

/**
 * Secrets a bag's manifest declares for its own services.
 *
 * A bag holds two kinds of code and secrets reach them differently. TOOL code
 * runs inside Barry's MCP server, where per-profile secrets arrive through
 * `context.secrets`. SERVICE code is a supervised process with no session and no
 * MCP connection: `process.env` is the only channel it has, and `services.*.env`
 * in the manifest is where those names are declared.
 *
 * Reading this instead of keeping a hand-maintained name list means the
 * exemption is EARNED by declaring the secret, and it stays scoped to the bag
 * that declared it — where a global allowlist entry exempted the name
 * everywhere. It also cannot go stale: the SLACK_* entries this replaced
 * outlived the bag they were written for.
 *
 * Both manifest spellings are accepted: `env: [NAME, ...]` and
 * `env: {NAME: {source, required}}`.
 */
function declaredServiceSecrets(bagDir) {
  const manifestPath = path.join(repoRoot, bagDir, "bag.yaml");
  if (!existsSync(manifestPath)) return new Set();
  let manifest;
  try {
    manifest = parseYaml(readFileSync(manifestPath, "utf8"));
  } catch {
    // A malformed manifest is another check's problem; exempt nothing here
    // rather than failing open on an unparseable file.
    return new Set();
  }
  const names = new Set();
  for (const group of ["services", "jobs"]) {
    for (const item of Object.values(manifest?.[group] ?? {})) {
      const env = item?.env;
      if (Array.isArray(env)) for (const n of env) names.add(n);
      else if (env && typeof env === "object") for (const n of Object.keys(env)) names.add(n);
    }
  }
  return names;
}

/**
 * Fails a package whose published exports point at files `files` would leave
 * behind.
 *
 * Workspace consumers resolve through a symlink to the source tree, so an
 * export target that is never packed still works locally and breaks only for
 * an installed consumer. `packages/contracts` advertised
 * `./generated/openapi.json` while shipping `files: ["dist"]` — the JSON sits
 * outside dist, and nothing noticed because every in-repo resolution saw the
 * source file.
 *
 * A package with `publishConfig` but no `files` is an error rather than a
 * skip: npm would then pack nearly everything, which no export check can
 * meaningfully validate, and staying silent there is how this check would
 * stop seeing its own input.
 */
function checkPublishedExportTargets(pkg, relPath, errors) {
  if (!pkg.publishConfig) return;

  const targets = collectStringLeaves(pkg.publishConfig.exports)
    .concat(collectStringLeaves(pkg.publishConfig.main))
    .concat(collectStringLeaves(pkg.publishConfig.types))
    .filter((value) => value.startsWith("."));
  if (targets.length === 0) return;

  const files = pkg.files;
  if (!Array.isArray(files) || files.length === 0) {
    errors.push(
      `${relPath}: declares publishConfig exports but no \`files\` allowlist — ` +
        `add one so what ships can be checked against what is advertised`,
    );
    return;
  }

  // npm treats a `files` entry naming a directory as that whole subtree.
  const roots = files.map((entry) => entry.replace(/^\.?\//, "").replace(/\/+$/, ""));

  for (const target of new Set(targets)) {
    const relative = target.replace(/^\.\//, "");
    const covered = roots.some(
      (root) => relative === root || relative.startsWith(`${root}/`),
    );
    if (!covered) {
      errors.push(
        `${relPath}: published export "${target}" is not covered by \`files\` ` +
          `(${roots.join(", ")}) — it would resolve in this workspace but 404 for an installed consumer`,
      );
      continue;
    }
    // A packed path that does not exist on disk is the same defect one step
    // later: `files` covers it, but the build never produced it.
    const isBuildOutput = roots.some((root) => relative.startsWith(`${root}/`) && /(^|\/)dist(\/|$)/.test(root));
    if (!isBuildOutput && !existsSync(path.join(repoRoot, relPath, relative))) {
      errors.push(
        `${relPath}: published export "${target}" is listed in \`files\` but does not exist on disk`,
      );
    }
  }
}

async function checkPackSecretsContract(errors) {
  // Manifest lookups are cached per bag: the walk visits many files per bag and
  // the manifest cannot change mid-run.
  const serviceSecretsByBag = new Map();
  const serviceSecretsFor = (bagDir) => {
    if (!bagDir) return EMPTY_SET;
    if (!serviceSecretsByBag.has(bagDir)) {
      serviceSecretsByBag.set(bagDir, declaredServiceSecrets(bagDir));
    }
    return serviceSecretsByBag.get(bagDir);
  };

  // `bagDir` is the nearest ancestor holding a bag.yaml. Nested bags
  // (bags/filesystem/locks) therefore resolve against their OWN manifest
  // rather than the parent's, so a parent cannot exempt a child's secrets.
  let inspected = 0;
  async function walk(relativeDir, bagDir) {
    let entries;
    try {
      entries = await readdir(path.join(repoRoot, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    const ownManifest = existsSync(path.join(repoRoot, relativeDir, "bag.yaml"));
    const currentBag = ownManifest ? relativeDir : bagDir;
    for (const entry of entries) {
      const rel = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SEGMENTS.has(entry.name)) continue;
        await walk(rel, currentBag);
      } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        inspected += 1;
        const content = await readFile(path.join(repoRoot, rel), "utf8");
        for (const match of content.matchAll(SECRET_ENV_PATTERN)) {
          const name = match[1];
          if (SECRET_ENV_ALLOWLIST.has(name)) continue;
          // Declared for this bag's own service: process.env is the only
          // channel the supervisor has, so this is the contract, not a breach.
          if (serviceSecretsFor(currentBag).has(name)) continue;
          // `tools.env` is deliberately NOT offered as a fix: declaredServiceSecrets
          // reads only `services` and `jobs`, so declaring it would silence
          // nothing. The old message advertised it anyway, no bag in the repo
          // used it, and the dissolution cleanup record inherited the
          // bad advice verbatim — a check that recommends an impossible fix
          // sends every reader on the same dead-end hunt.
          errors.push(`${rel}: reads secret \`${name}\` from process.env — bag TOOL code must read secrets from the injected \`context.secrets\`. If this is SERVICE code (supervised, no MCP connection), declare the name under \`services.*.env\` in this bag's bag.yaml.`);
        }
      }
    }
  }
  // The built-in bags. This walked `builtin` for two renames (builtin ->
  // bennu -> bags) after the directory left, and because a missing directory
  // returns silently above, the rule inspected nothing and reported clean. The
  // count below is what makes that visible next time.
  await walk("bags", null);
  if (inspected === 0) {
    errors.push("checkPackSecretsContract inspected no bag source under bags/ — the rule is not running");
  }
}

async function main() {
  const errors = [];
  const actualPaths = await getWorkspacePackageDirs();
  const expectedPaths = Object.keys(ENTRY_SPECS).sort();

  for (const actualPath of actualPaths) {
    // Name the file that actually needs editing, and the shape of the entry.
    // The old message pointed at "scripts/check-monorepo-policy.mjs", which
    // does not exist, and did not mention that the inventory is JSON — so the
    // fix was a hunt every time, and this is the most frequently hit error
    // here. An unregistered workspace also silently drops out of
    // run-unit-tests.mjs, so its tests never run in CI.
    expect(
      Boolean(ENTRY_SPECS[actualPath]),
      `${actualPath}: missing from workspace-entries.json — add ` +
        `{"${actualPath}": {"name": "<package.json name>", "class": "<bag|internal-package|...>"}}. ` +
        `Until you do, this package's tests are invisible to CI.`,
      errors,
    );
  }

  // Some inventory entries are in-development apps that are gitignored, so they
  // exist in the author's checkout and nowhere else. Validate the ones present
  // rather than demanding every checkout have all of them.
  const presentPaths = expectedPaths.filter((p) => actualPaths.includes(p));

  // ...but "not a workspace package here" and "the directory is gone" are not
  // the same thing, and only the first is legitimate. This check read as
  // bidirectional while being one-way: an entry whose directory no longer
  // exists was filtered out above and never validated, so a package deleted or
  // renamed left a stale entry that passed silently — and the summary line
  // counted only the surviving entries, so nothing looked amiss. An entry with
  // no directory on disk is always wrong; a gitignored in-development app
  // still HAS its directory.
  for (const relPath of expectedPaths) {
    if (actualPaths.includes(relPath)) continue;
    expect(
      existsSync(path.join(repoRoot, relPath)),
      `${relPath}: listed in workspace-entries.json but the directory does not exist — ` +
        `remove the entry, or restore the package.`,
      errors,
    );
  }

  for (const relPath of presentPaths) {
    const spec = ENTRY_SPECS[relPath];
    const pkgPath = path.join(repoRoot, relPath, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));

    expect(pkg.name === spec.name, `${relPath}: expected package name ${spec.name}, found ${pkg.name ?? "<missing>"}`, errors);

    checkPublishedExportTargets(pkg, relPath, errors);

    if (spec.class === "internal-package") {
      if (spec.mode === "compiled") errors.push(...compiledPackageErrors(pkg, relPath));
      else checkInternalPackage(pkg, relPath, errors);
      continue;
    }

    if (spec.class === "runtime-edge") {
      if (spec.mode === "source-start") {
        checkSourceStart(pkg, relPath, errors);
      } else if (spec.mode === "source-bin") {
        checkSourceBin(pkg, relPath, errors);
      } else if (spec.mode === "bundle-source") {
        checkBundleSource(pkg, relPath, errors);
      } else if (spec.mode === "wrangler") {
        checkWrangler(pkg, relPath, errors);
      } else if (spec.mode === "container") {
        checkContainer(pkg, relPath, errors);
      } else {
        errors.push(`${relPath}: unsupported runtime mode ${spec.mode}`);
      }
    }
  }

  await checkNoStaleJsSiblings(errors);
  await checkPackSecretsContract(errors);
  await checkOrphanedTests(errors);

  if (errors.length > 0) {
    console.error("Monorepo packaging policy violations:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Monorepo packaging policy OK (${presentPaths.length} workspace entries checked).`);
}

await main();
