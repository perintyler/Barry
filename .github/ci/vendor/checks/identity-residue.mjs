import { fileURLToPath } from "node:url";
/**
 * Guard against a half-finished `barrys` → `identities` rename.
 *
 * The entity used to be called a "barry", which collides with the product name:
 * the bare word appears ~5,900 times legitimately (`~/.barry`, `BARRY_HOME`,
 * `barryPath`, the CLI binary), so banning it is pure noise. The *plural* and
 * the compound identifiers are unambiguous — nothing but the entity is ever
 * called `barrys`, `barryId`, or `BarryRecord`. Those are what this bans.
 *
 * A rename that half-lands is worse than no rename: you end up grepping for two
 * words instead of one. This runs in CI so that cannot happen quietly.
 *
 * NOTE ON THE ODD STRING BUILDING BELOW: the banned names are assembled at
 * runtime from a stem rather than written as literals. A search-and-replace
 * sweep over the repo would otherwise rewrite this file's own ban-list into the
 * new vocabulary, and the gate would start banning the words it is meant to
 * enforce. Keep it this way.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const B = "arry"; // never written as the whole word, see note above
const LOWER = "b" + B; // the entity stem, lowercase
const UPPER = "B" + B; // …and capitalised
const LEGACY_YAML = LOWER + ".yaml"; // the pre-rename config filename

// Every root must exist. The walker swallows a missing directory (catch ->
// return), so a root that is deleted or renamed is skipped in silence and the
// check keeps reporting clean over a smaller and smaller tree. `apps`,
// `config`, `hooks` and `tools` had all left before anyone noticed, and
// `sdks` and `infra` followed — the assertion below has now caught three
// separate dissolutions, `servers` a fourth, which is why it is an assertion
// and not a comment.
const WALK_ROOTS = [
  // `packages` was dissolved into sdk/bag-host. Adding `adapters`, `engine` and
  // `sdk` at the same time: they are live top-level trees this list had never
  // named, so the scan was not merely pointing at a dead root -- it had never
  // looked at three real ones.
  //
  // `docs` was dropped when e3b4660a dissolved docs/ (guide to the web,
  // operations to barry-devops, history to its own repo). The missing-root
  // assertion below is what caught it, having outlived the directory by the
  // same route `packages` did.
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
 * Suffixes appended to the capitalised stem — `BarryRecord`, `BarryMetadata`…
 * Longest first so the most specific name is the one reported.
 */
// `Client` left this list once `BarryClient` stopped meaning the entity's
// client. It now names the product's own client for a Barry installation --
// the SDK's public TypeScript class, used across the sdk, its tests and the
// bags, and the Swift package's -- a product type, like BarryCore. The path
// fragment `BarryClient.swift` stays banned.
const UPPER_SUFFIXES = [
  "ResolutionSource", "ContractTests", "DetailView", "Transport",
  "Metadata", "Defaults", "ListView", "Record", "Editor",
  "Schema", "Config", "Drift", "Yaml", "File", "sTable",
];

/** Verbs/prefixes wrapped around the stem — `getBarryDir`, `listBarrys`… */
const CAMEL_COMPOUNDS = [
  "listBDirectoryPaths", "findBDirectoryById", "registerBDirectory",
  "loadBFromDirectory", "listBDirectories", "createBDirectory",
  "claimDefaultBIfUnset", "findBByGitHubInstallation",
  "getBsRegistryPath", "readBsRegistry", "isBDirectory",
  "setBMetadataField", "updateBMetadata", "resolveBConfig",
  "readRepoBDefault", "resolveSessionB", "touchBLastUsed",
  "ResolvedSessionB", "ResolvedBConfig", "syncBToDb", "findBDrift",
  "writeBYaml", "getBByName", "listAllBs", "setActiveB",
  "getActiveB", "clearActiveB", "getBsDir", "getBDir", "listBs",
  "deleteB", "renameB", "createB",
];

const BANNED_TOKENS = [
  ...CAMEL_COMPOUNDS.map((c) => c.replace("B", UPPER).replace(/\bB/g, UPPER)),
  ...UPPER_SUFFIXES.map((s) => UPPER + s),
  "my-" + LOWER + "s",
  "My" + UPPER + "s",
  LOWER + "_id",
  LOWER + "Id",
  LOWER + "s",
  UPPER + "s",
  // The singular entity type, in the forms where it can only be the entity.
  // Deliberately NOT bare `struct Barry`-style prefixes: `BarryCore`,
  // `BarryEvent` and `BarryService` are product types and must survive. These
  // shapes only ever wrap the standalone type.
  "struct " + UPPER + " ",
  "struct " + UPPER + ":",
  "[" + UPPER + "]",
  ": " + UPPER + "?",
  UPPER + ".self",
  "selected" + UPPER,
  "inherited" + UPPER,
  UPPER + "Row",
].sort((a, b) => b.length - a.length);

/** Path fragments that must not survive — a file whose name lagged its content. */
const BANNED_PATH_FRAGMENTS = [
  LOWER + "-files",
  LOWER + "-resolution",
  LOWER + "-bags",
  LOWER + "s.ts",
  "commands/" + LOWER + ".ts",
  "commands/" + LOWER + "-env.ts",
  "src/" + LOWER + ".ts",
  UPPER + "s.swift",
  UPPER + ".swift",
  UPPER + "Client.swift",
  UPPER + "ListView.swift",
  UPPER + "DetailView.swift",
  "Create" + UPPER + "View.swift",
  UPPER + "Editor.swift",
  UPPER + "ContractTests.swift",
  "my-" + LOWER + "s",
  "audit-profile",
];

/**
 * Deliberate survivors: a path prefix plus the exact tokens allowed under it —
 * never a blanket file skip, so a genuine straggler in an allowlisted file is
 * still caught. Every entry says why; an unexplained exemption is how the next
 * rename rots.
 */
const ALLOWLIST = [
  {
    // The product's own name in helpers and env (barryAppSupportDir,
    // BARRY_HOME) is not the entity. The legacy helpers must name the old
    // directory — that IS their job. They are read-only fallbacks so an install
    // predating the rename still finds its identities; see
    // getLegacyIdentitiesDir.
    prefix: "bags/identities/src/paths.ts",
    tokens: [
      "Path",
      "Home",
      "_HOME",
      "Legacy",
      "LEGACY_IDENTITIES_DIRNAME = \"" + LOWER + "s\"",
    ],
  },
  {
    // `defaultBarry` is frozen: it round-trips through the user-facing
    // settings.yaml that config export writes and import reads, so renaming it
    // is a file-format change rather than a rename. See cli/src/lib/current-user.ts.
    prefix: "cli/src/lib/current-user.ts",
    tokens: ["default" + UPPER],
  },
  { prefix: "cli/src/commands/config-export.ts", tokens: ["default" + UPPER] },
  { prefix: "sdk/test/cli/config-export.test.ts", tokens: ["default" + UPPER] },
  { prefix: "bags/identities/src/identities.ts", tokens: ["default" + UPPER] },
  { prefix: "bags/sessions/api/src/routes/session-lifecycle.ts", tokens: ["default" + UPPER] },
  {
    // `barry:` / `barry-token:` are hash *inputs* and `prf_` is an issued token
    // prefix. Changing any of them silently reissues every synthetic id and
    // invalidates live tokens — the same reason `prf` survived profiles → barrys.
    prefix: "bags/identities/src/store/identity-files.ts",
    tokens: [LOWER + ":", LOWER + "-token:", "prf_", LOWER + "s"],
  },
  {
    prefix: "bags/identities/src/store/identity-files.test.ts",
    // The legacy-compatibility tests necessarily name the old filename, and one
    // section header describes the rename itself.
    tokens: [LOWER + ":", LOWER + "-token:", "prf_", LOWER + "s →", LEGACY_YAML],
  },
  // Three Swift exemptions stood here — BarryTransport, BarryClient and a
  // launchd-label fixture. They went with their files when BarryKit and the
  // macOS apps became their own repositories. An allowlist entry naming a path
  // that is no longer on disk exempts nothing and hides that it stopped
  // applying, which is why stale-paths asserts every prefix still resolves.
  {
    // The rename is described in prose here, so the old name appears by nature.
    prefix: "bags/identities/src/store/identity-files.ts",
    tokens: [LOWER + "s →"],
  },
  { prefix: "bags/identities/src/tokens.ts", tokens: ["prf_"] },
  {
    // User-facing message pluralises the entity name ("those barrys") when a bag
    // is packed on multiple identities. The product name IS the entity name here.
    prefix: "cli/src/commands/bag.ts",
    tokens: [LOWER + "s"],
  },
];

/**
 * Historical migrations are immutable records of what the schema once was.
 * Rewriting an applied one is a silent no-op anyway — the runner keys on
 * filename — so they keep the old vocabulary on purpose.
 */
// packages/db/migrations/ was the third entry here until packages/db was
// dissolved. An exemption for a path that no longer exists exempts nothing,
// and reads as though some directory is still deliberately out of scope.
const SELF = path.relative(process.cwd(), fileURLToPath(import.meta.url));
const SKIPPED_PREFIXES = [];

const TOKEN_PATTERNS = new Map(
  BANNED_TOKENS.map((token) => {
    const escaped = token.replace(/[.*+?^=!:${}()|[\]/\\-]/g, (ch) => "\\" + ch);
    return [token, new RegExp("(^|[^A-Za-z0-9_])" + escaped)];
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

  for (const relPath of files) {
    if (isSkipped(relPath)) continue;

    const allowedHere = allowedTokensFor(relPath);
    for (const fragment of BANNED_PATH_FRAGMENTS) {
      if (!relPath.includes(fragment)) continue;
      // A filename is fine when the same name is an allowlisted survivor here —
      // e.g. bdiff's product-level BarryClient.swift.
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
  }

  if (pathViolations.length === 0 && violations.length === 0) {
    console.log("identity-residue: clean — no stranded entity names.");
    return;
  }

  if (pathViolations.length > 0) {
    console.error(`\nStranded file/directory names (${pathViolations.length}):\n`);
    for (const v of pathViolations) console.error(`  ${v.file}  (contains "${v.fragment}")`);
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
    "\nThe entity is now `identities`. If a hit is a deliberate survivor (the" +
      "\nproduct install root, the frozen defaults key, or a hash input), add it" +
      "\nto ALLOWLIST in this script with a reason.\n",
  );

  process.exitCode = 1;
}

await main();
