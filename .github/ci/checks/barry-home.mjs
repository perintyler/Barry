// Adapted from the pinned barry-devops checks for the single SDK package.
/**
 * Fails when code builds a home-relative Barry path by hand instead of asking
 * `sdk/src/services/home.mjs`.
 *
 * `BARRY_HOME` is how a contributor instance (and every test suite) moves
 * Barry's state out of the real one. It only works if EVERY store asks the one resolver:
 * before it existed, locks, six telemetry stores and the bag registry all wrote
 * `join(homedir(), ".barry", …)` directly, so a process pointed at a scratch
 * home still wrote those into the real one. Nothing fails when that happens —
 * the leak is silent — so it is caught here instead.
 *
 * The rule: a string literal naming `.barry` or the macOS
 * `Library/{Application Support,Caches}/Barry` directories, within a few lines
 * of `homedir()` / `process.env.HOME` / `$HOME`. A repo-local `.barry` config
 * file (`join(repoRoot, ".barry")`) does not match, because nothing near it
 * names the home directory.
 *
 * Self-test: the resolver module itself must match the rule. If the detector
 * stops recognising the pattern, that match disappears and this check fails
 * instead of reporting a clean tree it never really looked at.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { handBuiltHomePaths, SOURCE, TEST } from "./home-paths.mjs";

const RESOLVER = "sdk/src/services/home.mjs";

/**
 * Files that cannot import the resolver and repeat its rule inline. Each must
 * still honour BARRY_HOME within the flagged window, or it is reported anyway.
 */
const INLINE_RESOLVER = new Map([
  [
    "bags/sessions/src/disk-retention.ts",
    "removes the old shared worktree root under the real ~/.barry once it is empty; only when BARRY_HOME is unset, because a test or contributor instance never had one",
  ],
]);

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "sdk", "cli", "bags", "adapters"], { encoding: "utf8" })
  .split("\n").filter(f => !f || existsSync(f))
  .filter((f) => SOURCE.test(f) && !TEST.test(f));

const hits = (file) => handBuiltHomePaths(readFileSync(file, "utf8"));

const violations = [];
if (readFileSync("README.md", "utf8").includes("/Users/tyler")) violations.push("README.md: replace machine-local example paths with /path/to/barry");
let resolverHits = 0;
for (const file of files) {
  for (const hit of hits(file)) {
    if (file === RESOLVER) { resolverHits++; continue; }
    if (INLINE_RESOLVER.has(file) && /BARRY_HOME/.test(hit.window)) continue;
    violations.push(`${file}:${hit.line}: ${hit.text}`);
  }
}

if (files.length === 0) {
  console.error("barry-home: scanned 0 files — git ls-files returned nothing; run from the repo root.");
  process.exit(1);
}
if (resolverHits === 0) {
  console.error(`barry-home: the detector no longer matches ${RESOLVER}, so it cannot be trusted to match anything else.`);
  process.exit(1);
}
if (violations.length) {
  console.error(`barry-home: ${violations.length} hand-built home path(s). Use bagDataDir() / barryAppSupportDir() / barryCacheDir() / barryConfigDir() from @barry-rocks/sdk/services:`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`barry-home: ${files.length} files clean (resolver self-test matched ${resolverHits}).`);
