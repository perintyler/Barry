import { fileURLToPath } from "node:url";
/**
 * Guard against a half-finished `Scope` → `Bound` rename.
 *
 * Scope is Barry's deny-half permission primitive (the README's bound primitive), and its
 * name is being changed to Bound. "Scope" is a badly overloaded word in this
 * repo — it also means an OAuth/OIDC scope string, a settings tier
 * (`settings.scope`), and ordinary lexical/adjectival English ("session-scoped",
 * "namespaceScoped") — so banning the bare word would be pure noise and would
 * flag thousands of legitimate lines. Only the unambiguous compounds that can
 * mean nothing but the primitive are banned: `AgentScope`, `scopeId`,
 * `scope_id`, `mergeScopes`, `ScopesTable`, and similar.
 *
 * THE BAN-LIST IS ENUMERATED ON PURPOSE. The retired bag-vocabulary.sh guard
 * took the opposite polarity: it grepped the bare word `block` everywhere and
 * subtracted a ~4,000-character hand-written allow-regex, so normal English was
 * banned by default and the allowlist had to grow forever to stay green. By the
 * end it was failing on ordinary phrases like "tool_use block" and "catch
 * block" — 142 of them, none an actual survivor of the rename it guarded. A
 * guard that needs a paragraph of allow-regex to pass has its ban-list written
 * too broadly. This file bans an ENUMERATED list of real identifiers instead:
 * the bare word `scope` is never matched, so no volume of legitimate prose can
 * ever trip it, and the allowlist below stays in the single digits.
 *
 * A rename that half-lands is worse than no rename — and worse here than in
 * any prior rename in this repo: scope resolution FAILS OPEN (an unresolvable
 * scope name is treated as "no restrictions" (the README's bound primitive), so a
 * stranded identifier does not just mean a build error somewhere. It can mean
 * a session that looks restricted and is not. This runs in CI so a half-landed
 * state cannot go unnoticed.
 *
 * NOTE ON THE ODD STRING BUILDING BELOW: banned names are assembled at runtime
 * from a stem rather than written as literals, exactly as identity-residue.mjs
 * does — a search-and-replace sweep over the repo would otherwise rewrite this
 * file's own ban-list into the new vocabulary, and the gate would start
 * banning the words it exists to enforce. Keep it this way.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const S = "cope"; // never written as the whole word, see note above
const LOWER = "s" + S; // "scope"
const UPPER = "S" + S; // "Scope"
const LOWER_PL = LOWER + "s"; // "scopes"
const UPPER_PL = UPPER + "s"; // "Scopes"

// Every root must exist. The walker swallows a missing directory (catch ->
// return), so a root that is deleted or renamed is skipped in silence and the
// check keeps reporting clean over a smaller and smaller tree. `apps`,
// `config`, `hooks` and `tools` had all left before anyone noticed, and
// `sdks` and `infra` followed — the assertion below has now caught three
// separate dissolutions, which is why it is an assertion and not a comment.
const WALK_ROOTS = [
  // `servers` was the fourth dissolution this assertion caught: its contents
  // became bags/sessions/api, which `bags` already covers. `sdk` and `engine`
  // are new top-level trees that appeared while this list still named the old
  // one -- so the check was not merely pointing at a dead root, it had never
  // looked at two live ones.
  // Fifth dissolution: `packages` became sdk/bag-host, already covered by
  // `sdk`. `adapters` is another live top-level tree this list never named.
  // Sixth: `docs` dissolved entirely (guide to the web, operations to the
  // barry-devops bag, history and reviews to their own repos), so a root that
  // no longer exists exempts nothing and only lies about the check's scope.
  // `scripts` became `checks` when the repo stopped having a scripts/ directory.
  // Seventh and eighth: `builtin` became `bennu` (with Swift moving to a
  // top-level `swift`), and `ci` moved under `.github/ci`. Both left while
  // this list still named them, and the assertion stopped the check outright.
  // Ninth and tenth: `bennu` became `bags`, and the CLI left `sdk` for `cli`.
  // Eleventh: `swift` left when Barry's Swift client was deleted; Swift lives
  // in BarryKit and the app repositories.
  "adapters", "bags", "cli", ".github/ci", "sdk",
];

const ROOT_FILES = ["README.md"];

const IGNORED_SEGMENTS = new Set([
  "node_modules", "dist", "build", ".build", ".git",
  ".svelte-kit", ".wrangler", "generated", "coverage",
]);

const SCANNED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".svelte", ".swift",
  ".sql", ".yaml", ".yml", ".json", ".md", ".sh", ".plist",
]);

/**
 * Unambiguous compounds — every one of these can only refer to Barry's Scope
 * primitive, never to an OAuth scope, a settings tier, or ordinary English.
 * Longest first so the most specific name is the one reported.
 */
const BANNED_TOKENS = [
  // Core package + types (packages/agent-scope -> packages/agent-bound)
  "Agent" + UPPER + "Schema",
  "Agent" + UPPER,
  UPPER + "NeedsNativeToolDenial",
  UPPER + "HasContent",
  "merge" + UPPER_PL,
  UPPER + "Guards",
  "is" + "File" + "Denied", // shape lives in scope-guards.ts; kept literal, not stem-built
  "SHIPPED_" + UPPER_PL.toUpperCase(),
  "Shipped" + UPPER,
  "loadShipped" + UPPER_PL,
  UPPER + "NeedsSandbox",

  // DB layer
  UPPER_PL + "Table",
  UPPER + "Record",
  "trait-" + LOWER + "-validation",
  "findUnknown" + UPPER + "Names",
  "findDropped" + UPPER + "Overrides",
  "findMissingDefaultTraits", // co-located in trait-scope-validation.ts; not scope-named but moves with the file

  // Session / trait wiring
  "resolveSession" + UPPER,
  "ResolvedSession" + UPPER,
  "apply" + UPPER + "Guards",
  UPPER + "ToolsForTransport",
  LOWER + "Names",
  LOWER + "_id",
  LOWER + "Id",
  "default" + UPPER, // trait.scope default-grant helpers, not settings.scope

  // HTTP / contracts (never "settings.scope" or "session-view scope")
  UPPER + "ListResponse",
  "Create" + UPPER + "Request",
  UPPER + "Response",
  "Update" + UPPER + "Request",
  UPPER + "Schema",
  "scopesRouter",

  // CLI
  "set-" + LOWER,
  "clear-" + LOWER,
  "summarize" + UPPER,
  "EMPTY_" + UPPER.toUpperCase() + "_SUMMARY",

  // Frozen-but-renamed constants (the VALUE stays scp_, the NAME does not)
  UPPER.toUpperCase() + "_PREFIX",

  // Swift mirror
  UPPER + "Record",
  "Create" + UPPER + "Sheet",
  "Edit" + UPPER + "Sheet",
].sort((a, b) => b.length - a.length);

/** Path fragments that must not survive — a file whose name lagged its content. */
const BANNED_PATH_FRAGMENTS = [
  "agent-" + LOWER,
  LOWER + "-guards",
  "session-" + LOWER + ".ts",
  LOWER_PL + ".builtin.yaml",
  "docs/" + LOWER_PL + ".md",
  "routes/" + LOWER_PL + ".ts",
  UPPER + ".swift",
  "Create" + UPPER + "Sheet.swift",
  "Edit" + UPPER + "Sheet.swift",
];

/**
 * Deliberate survivors: a path prefix plus the exact tokens allowed under it —
 * never a blanket file skip. Every entry says why; an unexplained exemption is
 * how the next rename rots. Kept in the single digits by design — see the
 * header note on guard polarity.
 */
const ALLOWLIST = [
  {
    // config.db's baseline created a settings table whose `scope_id` column is
    // the settings TIER ("global"/"session"), not Barry's Scope primitive. A
    // later migration drops the table, but a baseline is never edited once
    // databases have run it. One file, not its directory, so a stranded
    // identifier in a newer migration is still caught. The baseline is now
    // the configuration store's SQL migration.
    prefix: "cli/src/services/configuration/migrations/001_baseline.sql",
    tokens: [LOWER + "_id"],
  },
];

/**
 * Historical migrations and this file itself are immutable/self-referential —
 * see identity-residue.mjs for the same reasoning.
 *
 * The packages/db migration and seed entries that used to sit here left with
 * that package: a skip for a path that no longer exists exempts nothing and
 * only hides that the guard's scope changed under it. The fallback those
 * migrations fed (identities.ts's scope_id read) is deleted too — measured
 * 0 of 2 identities, 0 in the newest backup (the dissolution cleanup record in barry-history).
 *
 * The settings store and its routes used to be excluded here: they used bare
 * `scope`/`scope_id`/`scopeId` for a settings TIER (global/session), not Barry's
 * Scope primitive. Both files are deleted — the surface was dead — and their
 * skips left with them, per the same reasoning as the migrations above.
 */
const SELF = path.relative(process.cwd(), fileURLToPath(import.meta.url));
const SKIPPED_PREFIXES = [];

const TOKEN_PATTERNS = new Map(
  BANNED_TOKENS.map((token) => {
    const escaped = token.replace(/[.*+?^=!:${}()|[\]/\\-]/g, (ch) => "\\" + ch);
    // Bounded on both sides: a left boundary (identity-residue.mjs's original
    // check) alone lets e.g. "scopeId" match inside a hypothetical
    // "scopeIdentifier", or "ScopeSchema" inside "ScopeSchemaValidator" — a
    // false positive that would misreport a survivor where there is none.
    return [token, new RegExp("(^|[^A-Za-z0-9_])" + escaped + "([^A-Za-z0-9_]|$)")];
  }),
);

function allowedTokensFor(relPath) {
  const allowed = new Set();
  for (const entry of ALLOWLIST) {
    if (relPath.startsWith(entry.prefix)) {
      for (const token of entry.tokens) allowed.add(token);
    }
  }
  return allowed;
}

const isSkipped = (relPath) => relPath === SELF || SKIPPED_PREFIXES.some((p) => relPath.startsWith(p));

async function* walk(relativeDir) {
  let entries;
  try {
    entries = await readdir(path.join(repoRoot, relativeDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const relPath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) yield* walk(relPath);
    else if (entry.isFile()) yield relPath;
  }
}

function scanContent(relPath, content, allowed, violations) {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.toLowerCase().includes(LOWER)) continue;

    // Strip allowlisted tokens first; whatever still matches is a real straggler.
    let residual = line;
    for (const ok of allowed) residual = residual.split(ok).join("");

    for (const token of BANNED_TOKENS) {
      if (!TOKEN_PATTERNS.get(token).test(residual)) continue;
      violations.push({ file: relPath, line: i + 1, token, text: line.trim().slice(0, 110) });
      break; // one report per line — longest match wins
    }
  }
}

async function main() {
  const violations = [];
  const pathViolations = [];
  const deadPathViolations = [];

  const files = [];
  // A root that no longer exists would be skipped in silence by walk()'s
  // catch, quietly shrinking what this check covers while it still prints
  // clean. Fail instead: either the directory moved (repoint it) or it left
  // (drop it from WALK_ROOTS).
  const missingRoots = WALK_ROOTS.filter((r) => !existsSync(path.join(repoRoot, r)));
  if (missingRoots.length > 0) {
    console.error(`WALK_ROOTS names ${missingRoots.length} directory that does not exist:`);
    for (const r of missingRoots) console.error(`  - ${r}`);
    console.error("Repoint it, or drop it from WALK_ROOTS.");
    process.exit(1);
  }

  for (const root of WALK_ROOTS) {
    for await (const relPath of walk(root)) files.push(relPath);
  }
  files.push(...ROOT_FILES);

  // A guard that scans almost nothing is a guard that always passes. The
  // retired bag-vocabulary.sh earned this the hard way: a quoting bug left its
  // file list undefined, so it grepped zero files and printed a triumphant
  // PASS for several rounds. Fail loudly instead if the count looks wrong.
  if (files.length < 200) {
    console.error(`FATAL: only ${files.length} files in scope (expected >200). Walk is broken.`);
    process.exitCode = 2;
    return;
  }

  for (const relPath of files) {
    if (isSkipped(relPath)) continue;

    const allowedHere = allowedTokensFor(relPath);
    for (const fragment of BANNED_PATH_FRAGMENTS) {
      if (!relPath.includes(fragment)) continue;
      if ([...allowedHere].some((ok) => fragment.startsWith(ok))) break;
      pathViolations.push({ file: relPath, fragment });
      break;
    }

    if (!SCANNED_EXTENSIONS.has(path.extname(relPath))) continue;

    let content;
    try {
      content = await readFile(path.join(repoRoot, relPath), "utf8");
    } catch {
      continue;
    }
    scanContent(relPath, content, allowedHere, violations);

    // A renamed DIRECTORY can survive inside a file as a dead path — a prose
    // reference, or worse a runnable `cd packages/agent-scope` in a QA doc that
    // fails for whoever follows it. The path check above tests relPath only, and
    // the identifier scan does not know about paths, so this class fell between
    // them: found in bags/filesystem/locks/QA.md and bags/sessions/bag.yaml AFTER
    // the guard reported clean over 1691 files.
    for (const fragment of BANNED_PATH_FRAGMENTS) {
      if (!fragment.includes("/") && !fragment.startsWith("agent-")) continue;
      if ([...allowedHere].some((ok) => fragment.startsWith(ok))) continue;
      let idx = content.indexOf(fragment);
      while (idx !== -1) {
        const line = content.slice(0, idx).split("\n").length;
        deadPathViolations.push({ file: relPath, line, fragment });
        idx = content.indexOf(fragment, idx + fragment.length);
      }
    }
  }

  if (pathViolations.length === 0 && violations.length === 0 && deadPathViolations.length === 0) {
    console.log(`bound-vocabulary: clean — no stranded Scope identifiers (${files.length} files scanned).`);
    return;
  }

  console.error(`Scanned ${files.length} files.`);

  if (pathViolations.length > 0) {
    console.error(`\nStranded file/directory names (${pathViolations.length}):\n`);
    for (const v of pathViolations) console.error(`  ${v.file}  (contains "${v.fragment}")`);
  }

  if (deadPathViolations.length > 0) {
    console.error(`\nDead paths referenced inside files (${deadPathViolations.length}):\n`);
    for (const v of deadPathViolations) {
      console.error(`  ${v.file}:${v.line}  refers to "${v.fragment}", which no longer exists`);
    }
  }

  if (violations.length > 0) {
    const byToken = new Map();
    for (const v of violations) byToken.set(v.token, (byToken.get(v.token) ?? 0) + 1);

    console.error(`\nStranded identifiers (${violations.length}):\n`);
    for (const v of violations.slice(0, 50)) {
      console.error(`  ${v.file}:${v.line}  ${v.token}\n      ${v.text}`);
    }
    if (violations.length > 50) console.error(`\n  … and ${violations.length - 50} more.`);

    console.error("\nRemaining by token:");
    for (const [token, count] of [...byToken.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(count).padStart(5)}  ${token}`);
    }
  }

  console.error(
    "\nThe primitive is now `Bound`. If a hit is a deliberate survivor (a" +
      "\nhistorical migration, the documented upgrade note, or an unrelated" +
      "\nhomonym), add it to ALLOWLIST in this script with a reason. Do not" +
      "\nwiden a BANNED_TOKENS entry to the bare word `scope` to make this" +
      "\npass — see the header note on guard polarity.\n",
  );

  process.exitCode = 1;
}

await main();
