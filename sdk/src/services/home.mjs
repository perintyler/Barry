/**
 * Where Barry keeps its state on this machine — the one answer every store asks.
 *
 * An instance is its App Support directory (registry, stores, secrets), its
 * Caches and Logs directories, its config directory and its runtime directory.
 * `BARRY_HOME` moves ALL of them under one root. Before this module the
 * variable was honoured by some stores and ignored by others, so a process
 * pointed at a scratch home still wrote locks, telemetry and the bag registry
 * into the real one — a sandbox that leaked into prod through whichever store
 * nobody had remembered.
 *
 * A store's own override (`BARRY_SESSIONS_DB`, `BARRY_LOCKS_DB`, …) still wins
 * over this; those are how tests pin a single file.
 *
 * `pnpm check:barry-home` fails the build when code outside this module
 * builds a home-relative Barry path by hand.
 *
 * Plain JS (types in home.d.mts) so the scripts that run under bare `node` —
 * the scheduler tick, the job launcher — share this one rule instead of each
 * keeping a copy.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import process from "node:process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function override() {
  return process.env.BARRY_HOME || undefined;
}

/**
 * `~/Library/Application Support/Barry` — durable, backed up (the bag registry).
 * Under `$BARRY_HOME/app-support` when `BARRY_HOME` is set.
 */
export function barryAppSupportDir() {
  const home = override();
  return home ? join(home, "app-support") : join(homedir(), "Library", "Application Support", "Barry");
}

/**
 * `~/Library/Caches/Barry` — regenerable, excluded from Time Machine (built bags).
 * Under `$BARRY_HOME/cache` when `BARRY_HOME` is set.
 */
export function barryCacheDir() {
  const home = override();
  return home ? join(home, "cache") : join(homedir(), "Library", "Caches", "Barry");
}

/**
 * A bag name that is safe to use as one path segment.
 *
 * A bag's data directory is `data/<bag>`, so a name like `../sessions` would
 * hand one bag another's stores. Registered bag names already fit this shape;
 * checking here means no caller has to remember to.
 */
const BAG_SEGMENT = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i;

export function bagSegment(bag) {
  if (typeof bag !== "string" || !BAG_SEGMENT.test(bag) || bag.includes("..")) {
    throw new Error(`not a bag name usable as a directory: ${JSON.stringify(bag)}`);
  }
  return bag.replace("/", "+");
}

/**
 * `<app support>/data/<bag>` — where one bag keeps its stores, created `0700`.
 * Pass `create: false` when computing paths for metadata without creating state.
 *
 * Keyed by the registered bag name. A store belongs to exactly one bag, and
 * anyone else goes through that bag's code, never through this path: the
 * `bag-data-dirs` check fails when a bag asks for another bag's directory.
 *
 * Refused under a test runner with no `BARRY_HOME`: that is a suite about to
 * create a store in the real instance. It happened twice before this guard,
 * leaving synthetic usage rows in the real telemetry store each time.
 * `BARRY_ALLOW_REAL_INSTANCE=1` is the deliberate way past it.
 */
export function bagDataDir(bag, { create = true } = {}) {
  if (create && process.env.VITEST && !override() && process.env.BARRY_ALLOW_REAL_INSTANCE !== "1") {
    throw new Error(
      `bagDataDir(${JSON.stringify(bag)}) under a test with no BARRY_HOME would create a store in the real ` +
        "instance. Run the suite in a throwaway one: BARRY_HOME in its vitest config, or useTestInstance().",
    );
  }
  const dir = join(barryAppSupportDir(), "data", bagSegment(bag));
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * `~/Library/Logs/Barry` — service logs, written and rotated by service management
 * (visible in Console.app). Under `$BARRY_HOME/logs` when `BARRY_HOME` is set.
 */
export function barryLogsDir() {
  const home = override();
  return home ? join(home, "logs") : join(homedir(), "Library", "Logs", "Barry");
}

/** `<logs>/<bag>` — one bag's service logs. Not created: service management does that. */
export function bagLogsDir(bag) {
  return join(barryLogsDir(), bagSegment(bag));
}

/**
 * `~/.config/barry` (or `$XDG_CONFIG_HOME/barry`) — the files a person edits:
 * `hosting.yaml`, `cli.yaml`, and one file per bag for its settings.
 *
 * Never secrets: people keep `~/.config` in a dotfiles repo. Under
 * `$BARRY_HOME/config` when `BARRY_HOME` is set.
 */
export function barryConfigDir() {
  const home = override();
  if (home) return join(home, "config");
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config"), "barry");
}

/**
 * An 8-hex-char id for this Barry instance, derived from its root (`BARRY_HOME`,
 * or the real user home when unset).
 *
 * Two instances never collide under it, and the same instance always gets the
 * same id back — which is what lets a short, instance-scoped path (a run
 * directory, a vendor's scratch home) stay unique without embedding the root
 * path itself.
 */
export function instanceId() {
  const root = override() ?? homedir();
  return createHash("sha256").update(root).digest("hex").slice(0, 8);
}

/**
 * `$TMPDIR/barry-<8 hex>` — runtime sockets and pid files for one instance.
 *
 * Short on purpose: a Unix socket path must fit in 104 bytes on macOS, and
 * `$TMPDIR` alone is ~49. The hash is of the instance's root, so two instances
 * never share a socket and the same instance always finds its own.
 */
export function barryRunDir() {
  return join(userTempDir(), `barry-${instanceId()}`);
}

let cachedUserTempDir;

/**
 * The per-user temp directory, even for a process started without `$TMPDIR`.
 *
 * launchd sets `TMPDIR` for the jobs it runs and a login shell has it, but a
 * process spawned with a scrubbed environment does not, and `os.tmpdir()` then
 * answers `/tmp`. Two processes of one instance would disagree about where its
 * socket is. macOS answers the same question through `getconf`, so ask it.
 */
function userTempDir() {
  if (process.env.TMPDIR) return process.env.TMPDIR;
  if (cachedUserTempDir) return cachedUserTempDir;
  cachedUserTempDir = tmpdir();
  if (process.platform === "darwin") {
    try {
      const out = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
      if (out.startsWith("/")) cachedUserTempDir = out;
    } catch {
      // Keep os.tmpdir(): every process of this instance without TMPDIR lands here too.
    }
  }
  return cachedUserTempDir;
}

/**
 * The instance's secrets file, `<app support>/env` (mode 0600).
 *
 * Not under `barryConfigDir()`: that directory is for files people commit.
 */
export function barryEnvPath() {
  return join(barryAppSupportDir(), "env");
}

/**
 * `<app support>/adapters.json`, the harness adapters this installation has:
 * installation state, kept with the registry it sits beside.
 */
export function barryAdaptersPath() {
  return join(barryAppSupportDir(), "adapters.json");
}

/** Standardized resource roots, resolved from this instance only. */
export function barryStoresDir() { return join(barryAppSupportDir(), "stores"); }
export function barryArchivesDir() { return join(barryAppSupportDir(), "archives"); }
export function barryBackupsDir() { return join(barryAppSupportDir(), "backups"); }

/** Explicitly selected model adapter packages for this installation. */
export function barryModelProvidersPath() { return join(barryAppSupportDir(), "model-providers.json"); }

/** Release copies and the stable selector for this instance's installation. */
export function barryReleasesDir() { return join(barryAppSupportDir(), "releases"); }
export function barryCurrentDir() { return join(barryAppSupportDir(), "current"); }

const modulePath = fileURLToPath(import.meta.url);
const moduleRoot = (() => {
  for (let dir = dirname(modulePath); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "identity.yaml")) && existsSync(join(dir, "bags"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
})();

/** Keep current's spelling: Node resolves modules into a versioned release. */
export function installationRoot() {
  const current = barryCurrentDir();
  if (existsSync(current)) return current;
  const configured = process.env.BARRY_DIR;
  if (moduleRoot) {
    if (configured) {
      try {
        if (realpathSync(configured) === realpathSync(moduleRoot)) return configured;
      } catch { /* An inherited checkout may have been removed. */ }
    }
    return moduleRoot;
  }
  if (configured) return configured;
  throw new Error(`cannot find Barry's installation above ${modulePath}; BARRY_DIR is unset`);
}

/** External package links must survive pruning the release they resolved into. */
export function installationPath(path) {
  const root = installationRoot();
  const target = realpathSync(root);
  const inside = relative(target, resolve(path));
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
    ? join(root, inside) : path;
}
