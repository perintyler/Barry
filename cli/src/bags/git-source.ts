/** Fetch declared child bags into durable ordinary checkouts, preserving dirty work; see docs/decisions/0019-cli-checkouts-and-session-selection.md. */

import { existsSync, mkdirSync } from "fs";
import { isAbsolute, join, resolve, sep } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { isSafeCacheName } from "@barry-rocks/sdk/internal/mcp";
import type { BagChildSource } from "@barry-rocks/sdk/bags";

/** Where fetched bags land. Sibling checkouts, one directory per bag. */
export function getBagsHome(): string {
  // `BARRY_BAGS_HOME` wins (points straight at the bags directory).
  // Otherwise the bags directory sits under `BARRY_REPOS` (the configurable
  // root for everything Barry clones), defaulting to `~/repos`.
  return process.env.BARRY_BAGS_HOME || join(process.env.BARRY_REPOS || join(homedir(), "repos"), "bags");
}

/**
 * Expand a `repo:` value to something git can clone.
 *
 * `owner/name` is GitHub shorthand. Anything carrying a scheme or an
 * SCP-style `host:path` is passed through untouched, so self-hosted remotes
 * and `git@` URLs work unchanged.
 */
export function resolveRepoUrl(repo: string): string {
  const trimmed = repo.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[^/\s]+@[^/\s]+:/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return trimmed;
}

/**
 * Compare two remote URLs for "same repository".
 *
 * Normalizes the differences that are pure spelling — a trailing `.git`, a
 * trailing slash, case in the host, and `git@host:owner/name` versus
 * `https://host/owner/name`. Without this, reusing a checkout cloned over ssh
 * for a manifest that names the https URL would look like a mismatch and
 * refuse to proceed on a perfectly good directory.
 */
export function sameRemote(a: string, b: string): boolean {
  return normalizeRemote(a) === normalizeRemote(b);
}

function normalizeRemote(url: string): string {
  let normalizedUrl = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const scpMatch = /^([^/\s]+)@([^/\s:]+):(.+)$/.exec(normalizedUrl);
  if (scpMatch) normalizedUrl = `${scpMatch[2]}/${scpMatch[3]}`;
  normalizedUrl = normalizedUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  normalizedUrl = normalizedUrl.replace(/^[^@/]+@/, "");
  return normalizedUrl.toLowerCase();
}

function runGit(args: string[], cwd?: string): { ok: boolean; out: string } {
  const gitResult = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: gitResult.status === 0,
    out: `${gitResult.stdout ?? ""}${gitResult.stderr ?? ""}`.trim(),
  };
}

/** The remote a checkout points at, or null if it is not a git repo. */
export function originOf(dir: string): string | null {
  const gitResult = runGit(["remote", "get-url", "origin"], dir);
  return gitResult.ok && gitResult.out ? gitResult.out.split("\n")[0].trim() : null;
}

/** Whether a checkout has uncommitted changes. */
export function isDirty(dir: string): boolean {
  const gitResult = runGit(["status", "--porcelain"], dir);
  // Unreadable status means "cannot prove it is clean" — treat as dirty, so
  // the caller's protective branch (never discard work) is the one taken.
  return gitResult.ok ? gitResult.out.length > 0 : true;
}

/** The commit a checkout is on, or null. */
export function headOf(dir: string): string | null {
  const gitResult = runGit(["rev-parse", "HEAD"], dir);
  return gitResult.ok ? gitResult.out.trim() : null;
}

export interface FetchedBag {
  /**
   * Absolute path to the bag — the checkout, or the `subdir:` inside it. This
   * is what gets registered, so a bag in a monorepo needs no special handling
   * downstream: it is an ordinary local directory that happens to be nested.
   */
  path: string;
  /** Resolved clone URL. */
  repo: string;
  /** Commit checked out. */
  rev: string;
  /** Branch or tag requested, when one was. */
  ref?: string;
  /** What happened, for the install log. */
  status: "cloned" | "reused" | "updated";
}

export class BagFetchError extends Error {}

/**
 * Put a repo-declared bag on disk and return where it landed.
 *
 * Throws rather than returning a partial result. A `repo:` entry is an
 * unambiguous claim that this child exists at this URL, so a failure here is a
 * broken declaration, not the best-effort widening a bare name gets — and the
 * caller turns it into a failed install rather than a bag whose tools are
 * quietly absent.
 */
export function fetchBagRepo(name: string, source: BagChildSource): FetchedBag {
  if (!source.repo) throw new BagFetchError(`bag "${name}": no repo to fetch`);

  // The name becomes a directory under the bags home, and it comes from a
  // manifest — i.e. text this machine did not necessarily write. Without this
  // a name like "../../.ssh" escapes the root.
  if (!isSafeCacheName(name)) {
    throw new BagFetchError(`bag "${name}": not a usable directory name`);
  }

  const repo = resolveRepoUrl(source.repo);
  const home = getBagsHome();
  const dir = join(home, name);

  const fetched = existsSync(dir)
    ? reuseCheckout(name, dir, repo, source)
    : cloneFresh(name, dir, home, repo, source);

  // Applied after checkout, not before: which directories exist inside the
  // clone depends on the commit that was just checked out.
  return { ...fetched, path: bagDirIn(name, dir, source.subdir) };
}

function cloneFresh(
  name: string,
  dir: string,
  home: string,
  repo: string,
  source: BagChildSource,
): FetchedBag {
  mkdirSync(home, { recursive: true });
  const clone = runGit(["clone", repo, dir]);
  if (!clone.ok) {
    throw new BagFetchError(`bag "${name}": clone of ${repo} failed\n${clone.out}`);
  }
  const pinned = checkout(name, dir, source);
  return { path: dir, repo, rev: pinned, ...(source.ref ? { ref: source.ref } : {}), status: "cloned" };
}

/**
 * Resolve `subdir:` against the clone, or return the clone root when absent.
 *
 * The value comes from a manifest this machine did not necessarily write, the
 * same untrusted source the bag name is guarded against above — so an absolute
 * path or a `..` hop would point the registry at any directory on the box, and
 * `resolve` is asserted against rather than trusted.
 *
 * Existence is checked too, and for `bag.yaml` specifically: a typo'd subdir
 * that merely registered a path would produce a bag that loads nothing, which
 * is the silent half-install a declared source exists to rule out.
 */
function bagDirIn(name: string, cloneDir: string, subdir: string | undefined): string {
  if (!subdir) return cloneDir;

  if (isAbsolute(subdir)) {
    throw new BagFetchError(`bag "${name}": subdir "${subdir}" must be relative to the repository`);
  }

  const bagDir = resolve(cloneDir, subdir);
  const root = resolve(cloneDir);
  if (bagDir !== root && !bagDir.startsWith(`${root}${sep}`)) {
    throw new BagFetchError(`bag "${name}": subdir "${subdir}" escapes the repository`);
  }

  if (!existsSync(join(bagDir, "bag.yaml"))) {
    throw new BagFetchError(
      `bag "${name}": subdir "${subdir}" has no bag.yaml in ${cloneDir}.\n` +
        `Check the spelling, or the rev that was checked out.`,
    );
  }
  return bagDir;
}

/**
 * Adopt a directory that already exists.
 *
 * Reuse is the common case — the bag is already checked out, often the one you
 * are working in. The directory is only ever inspected here, never reset, so
 * the worst outcome is a refusal to proceed rather than lost work.
 */
function reuseCheckout(
  name: string,
  dir: string,
  repo: string,
  source: BagChildSource,
): FetchedBag {
  const origin = originOf(dir);
  if (!origin) {
    throw new BagFetchError(
      `bag "${name}": ${dir} already exists and is not a git checkout.\n` +
        `Move it aside, or point the manifest at a different name.`,
    );
  }
  if (!sameRemote(origin, repo)) {
    throw new BagFetchError(
      `bag "${name}": ${dir} is a checkout of a different repository.\n` +
        `  on disk:   ${origin}\n  manifest:  ${repo}\n` +
        `Refusing to touch it. Move it aside, or fix the manifest.`,
    );
  }

  // Already on the pinned commit: nothing to do, dirty or not.
  const head = headOf(dir);
  if (source.rev && head && head.startsWith(source.rev)) {
    return { path: dir, repo, rev: head, status: "reused" };
  }

  // Moving to a different commit would discard uncommitted work. Report it
  // instead — the whole reason for dropping submodules is that a checkout you
  // edit stays yours.
  if (isDirty(dir)) {
    if (source.rev || source.ref) {
      throw new BagFetchError(
        `bag "${name}": ${dir} has uncommitted changes, and the manifest pins ` +
          `${source.rev ? `rev ${source.rev}` : `ref ${source.ref}`}.\n` +
          `Refusing to move it. Commit or stash, then install again.`,
      );
    }
    return { path: dir, repo, rev: head ?? "", status: "reused" };
  }

  if (!source.rev && !source.ref) {
    return { path: dir, repo, rev: head ?? "", status: "reused" };
  }

  const before = head;
  const pinned = checkout(name, dir, source);
  return {
    path: dir,
    repo,
    rev: pinned,
    ...(source.ref ? { ref: source.ref } : {}),
    status: pinned === before ? "reused" : "updated",
  };
}

/**
 * Move a clean checkout onto the requested commit, fetching if it is unknown.
 *
 * Returns the resolved commit, so the registry records what was actually
 * checked out rather than what was asked for — the two differing later is
 * exactly the drift `bag doctor` should be able to see.
 */
function checkout(name: string, dir: string, source: BagChildSource): string {
  const target = source.rev ?? source.ref;
  if (!target) {
    const head = headOf(dir);
    if (!head) throw new BagFetchError(`bag "${name}": cannot read HEAD in ${dir}`);
    return head;
  }

  if (!runGit(["rev-parse", "--verify", `${target}^{commit}`], dir).ok) {
    // A fresh clone has only the default branch; a pinned commit or an
    // unfetched tag needs asking the remote for it.
    runGit(["fetch", "origin", target, "--tags"], dir);
  }

  const checkoutResult = runGit(["checkout", "--quiet", target], dir);
  if (!checkoutResult.ok) {
    throw new BagFetchError(
      `bag "${name}": ${source.rev ? "rev" : "ref"} "${target}" not found in the repository.\n${checkoutResult.out}`,
    );
  }

  const head = headOf(dir);
  if (!head) throw new BagFetchError(`bag "${name}": cannot read HEAD in ${dir}`);
  return head;
}
