// Adapted from the pinned barry-devops checks for the single SDK package.
/**
 * Validate relative Markdown links and heading anchors against tracked files.
 * External URLs are not fetched; historical ledgers retain reviewed evidence.
 */

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathLike } from "./path-like.mjs";
import { trackedPaths } from "./tracked-paths.mjs";
import { fencedCodeLines } from "./markdown-code-lines.mjs";

const repoRoot = process.cwd();

/** Inline `[text](target)`, ignoring image embeds and reference definitions. */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** GitHub's heading -> anchor slug: lowercase, drop punctuation, spaces to dashes. */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headingSlugs(markdown) {
  const slugs = new Set();
  const counts = new Map();
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1]);
    if (!base) continue;
    // Repeated headings get -1, -2, ... suffixes, same as GitHub.
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

/**
 * Every markdown file git tracks.
 *
 * Deliberately `git ls-files` rather than a directory walk over a hand-listed
 * set of roots. A walk has to be kept in sync by hand, and when it drifts it
 * fails in the worst possible direction: it silently checks fewer files and
 * still prints PASS. An earlier revision of this script missed 17 tracked docs
 * that way (infra, hooks, LICENSE.md).
 *
 * Using the index also skips node_modules, dist, and gitignored local content
 * for free, and matches exactly what CI checks out.
 */
function collectMarkdown() {
  const out = execFileSync("git", ["ls-files", "-z", "*.md"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean).filter((f) => existsSync(path.join(repoRoot, f)));
}

const anchorCache = new Map();
async function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) {
    anchorCache.set(absPath, headingSlugs(await readFile(absPath, "utf8")));
  }
  return anchorCache.get(absPath);
}

const files = collectMarkdown();
const problems = [];

/**
 * Docs whose subject is a past state: they name retired paths the way a
 * post-mortem names the thing that died. Skipping them is not a silent
 * weakening — the list is named here with that reason, and a new doc that
 * starts narrating history belongs on it.
 */
// Everything under plans/ is a ledger too: a plan is a dated record of a
// program of work, and names the paths that were true while it ran. Its links
// are still checked; only its backticked path mentions are not.
const LEDGER_DOCS = new Set([
  "bags/telemetry/DEFERRED-USAGE-QUERIES.md",
  // This design document names rejected layouts as context.
  "sdk/docs/bounds.md",
]);

const ROOT_ENTRIES = new Set(readdirSync(repoRoot));


/** Links and paths resolve to what the checkout tracks (see tracked-paths.mjs). */
const tracked = trackedPaths(repoRoot);
const BACKTICK_RE = /`([^`\n]+)`/g;

/**
 * Does this backticked token look like a repo path we can check?
 *
 * Conservative on purpose: a cleverer matcher risks failing a legitimate
 * reference it merely failed to understand, and a false failure here would
 * get the whole check disabled (the same reasoning bag-vocabulary.sh records).
 * The rules below each exist because a real reference tripped them once:
 * URLs and absolute system paths (`unix://…`, `/health`), shell snippets,
 * placeholders (`bags/<bag>/…`, `owner/name`), globs and line-references
 * (`file.ts:42`), and build artifacts that exist on a built machine but never
 * in a fresh clone (compiled bundles).
 */

/** Where `token` resolves: the repo root, or any ancestor of the doc. */
function resolvesSomewhere(token, fromDir) {
  if (tracked(path.join(repoRoot, token))) return true;
  // Bag-relative references (`scripts/sample` written inside bags/telemetry)
  // resolve against the doc's own directory and its ancestors up to the root.
  let dir = fromDir;
  while (dir.length > repoRoot.length) {
    if (tracked(path.join(dir, token))) return true;
    dir = path.dirname(dir);
  }
  return false;
}

for (const file of files) {
  const abs = path.join(repoRoot, file);
  const body = await readFile(abs, "utf8");
  const lines = body.split("\n");
  const codeLines = fencedCodeLines(lines);

  for (const [lineNo, line] of lines.entries()) {
    if (codeLines[lineNo]) continue;
    for (const match of line.matchAll(LINK_RE)) {
      const target = match[1];

      // Not ours to verify: absolute URLs, mail, in-page tool links, templates.
      if (/^(https?:|file:|mailto:|tel:|data:|#|<|\{)/.test(target)) {
        // A bare `#anchor` still has to resolve within this file.
        if (target.startsWith("#")) {
          const slugs = await anchorsFor(abs);
          const frag = decodeURIComponent(target.slice(1)).toLowerCase();
          if (frag && !slugs.has(frag)) {
            problems.push(`${file}:${lineNo + 1}  missing anchor ${target}`);
          }
        }
        continue;
      }
      if (target.startsWith("/")) continue; // site-absolute, resolved by the host

      const [rawPath, rawFrag] = target.split("#");
      if (!rawPath) continue;

      const decoded = decodeURIComponent(rawPath);
      const resolved = path.resolve(path.dirname(abs), decoded);

      if (!tracked(resolved)) {
        problems.push(`${file}:${lineNo + 1}  broken link -> ${target}`);
        continue;
      }

      if (rawFrag && resolved.endsWith(".md")) {
        const slugs = await anchorsFor(resolved);
        const frag = decodeURIComponent(rawFrag).toLowerCase();
        if (frag && !slugs.has(frag)) {
          problems.push(`${file}:${lineNo + 1}  missing anchor ${target}`);
        }
      }
    }

    if (LEDGER_DOCS.has(file) || file.startsWith("plans/")) continue;
    for (const match of line.matchAll(BACKTICK_RE)) {
      const token = match[1].replace(/\.+$/, "").replace(/\/+$/, "");
      if (!pathLike(token, ROOT_ENTRIES)) continue;
      // Trailing-slash directories and plain prefixes resolve if the
      // directory exists; anything else is checked as a file.
      if (!resolvesSomewhere(token, path.dirname(abs))) {
        problems.push(`${file}:${lineNo + 1}  stale path reference -> ${token}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Broken documentation links and stale path references (${problems.length}):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nFix the link, the heading, or the path it points at.");
  process.exit(1);
}

console.log(`Documentation links OK (${files.length} markdown files).`);
