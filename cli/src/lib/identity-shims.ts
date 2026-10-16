import { openInstance, shellWord, installedCommand, installedProgramPath } from "@barry-rocks/sdk/internal/services";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { identityRecords } from "@barry-rocks/identities-bag";
import type { IdentityBinding } from "../target.js";
/** Identity shims pass a stable --identity-binding to the installed CLI so every command shares the same selection. */

import { accessSync, chmodSync, constants, lstatSync, realpathSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/** Marks a file as ours, so we overwrite our own shims and nothing else. */
export const SHIM_MARKER = "# Barry identity shim —";

/**
 * Shell builtins and keywords a shim must never shadow.
 *
 * `bg` is the motivating case: it is a plausible alias for an identity named
 * "bgoode" and it is also job control. A shim on PATH does not shadow a builtin
 * in an interactive shell — the builtin wins — which is precisely the problem:
 * the alias would appear to install and then silently not work, while breaking
 * `bg` for every script that resolves commands through PATH.
 */
const SHELL_BUILTINS = new Set([
  "alias", "bg", "bind", "break", "builtin", "case", "cd", "command", "compgen",
  "complete", "continue", "declare", "dirs", "disown", "do", "done", "echo",
  "elif", "else", "enable", "esac", "eval", "exec", "exit", "export", "false",
  "fc", "fg", "fi", "for", "function", "getopts", "hash", "help", "history",
  "if", "in", "jobs", "kill", "let", "local", "logout", "popd", "printf",
  "pushd", "pwd", "read", "readonly", "return", "select", "set", "shift",
  "shopt", "source", "suspend", "test", "then", "time", "times", "trap",
  "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "until",
  "wait", "while", "[", "[[", ":", ".",
]);

export type ShimConflict =
  | { kind: "builtin" }
  | { kind: "occupied"; path: string }
  | { kind: "invalid" }
  /** The identity's own file cannot be read, so a command running as it would fail every time. */
  | { kind: "unreadable"; reason: string };

/** A name that cannot be a command at all. */
function isInvalidName(name: string): boolean {
  return !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name);
}

/**
 * Why `name` cannot be installed, or null when it is free.
 *
 * `binDir` is passed in so tests can point at a temp directory; production
 * callers use `getShimDir()`.
 */
export function findConflict(name: string, binDir: string): ShimConflict | null {
  // Builtins first: some of them (`[`, `:`, `.`) are also unusable as names,
  // and "it is a shell builtin" is the more useful of the two answers.
  if (SHELL_BUILTINS.has(name)) return { kind: "builtin" };
  if (isInvalidName(name)) return { kind: "invalid" };

  const target = join(binDir, name);
  if (existsSync(target)) {
    // Our own shim is safe to replace; anything else is somebody's binary.
    return isOurShim(target) ? null : { kind: "occupied", path: target };
  }

  // Something else on PATH would be shadowed. `command -v` sees through
  // aliases and functions the way a shell would.
  const found = whichOnPath(name);
  return found ? { kind: "occupied", path: found } : null;
}

/** Where `name` resolves on PATH, or null. Never throws. */
function whichOnPath(name: string): string | null {
  // A Node-side PATH walk rather than `/usr/bin/which`: the absolute path does
  // not exist on Linux (where contributors run read-only commands), and
  // walking PATH ourselves with existsSync + X_OK is the same answer `which`
  // would give for a bare command name, without a macOS-only binary.
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK);
      return realpathSync(name);
    } catch {
      return null;
    }
  }
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of entries) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here, or not executable
    }
  }
  return null;
}

/** Did we write this file? */
export function isOurShim(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

/**
 * Does this shim export `identityName`?
 *
 * Checked against the rendered line rather than a bare substring of the name,
 * so a shim for `bu` is never mistaken for one for `bux`.
 */
export function shimExports(path: string, identityName: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(`export BARRY_IDENTITY="${identityName}"`);
  } catch {
    return false;
  }
}

/** Is the shim at `name` already ours and already pointing at `identityName`? */
export function isCurrentShim(name: string, identityName: string, binDir: string, binding?: IdentityBinding): boolean {
  const target = join(binDir, name);
  if (!isOurShim(target) || !shimExports(target, identityName)) return false;
  const content = readFileSync(target, "utf8");
  // The exact command renderShim writes, not any entry that looks right: shims
  // written before a layout change still named an old entry, so they passed as
  // current and the reconcile never rewrote them, while every invocation
  // failed with "Cannot find module".
  if (!content.includes(`${shellWord(installedProgramPath("barry"))} --identity-binding`)) return false;
  for (const [name, value] of Object.entries(installedCommand("barry").environment))
    if (!content.includes(`export ${name}=${shellWord(value)}`)) return false;
  if (!binding) return true;
  const instance = openInstance(barryAppSupportDir()).id;
  return content.includes(`"id":${binding.id}`) && content.includes(`"home":${JSON.stringify(binding.home)}`) && content.includes(`"instance":"${instance}"`);
}

/** Explain a conflict in terms of what the user should do next. */
export function describeConflict(name: string, conflict: ShimConflict): string {
  switch (conflict.kind) {
    case "builtin":
      return `\`${name}\` is a shell builtin — a command by that name would not reliably run.`;
    case "occupied":
      return `\`${name}\` is already ${conflict.path}.`;
    case "invalid":
      return `\`${name}\` is not a usable command name (letters, digits, - and _; must start with a letter).`;
    case "unreadable":
      return `\`${name}\`'s identity.yaml cannot be read: ${conflict.reason}`;
  }
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function renderShim(identityName: string, barryPath: string, binding: IdentityBinding = { id: identityRecords.syntheticId(identityName), home: process.env.BARRY_HOME ?? null }): string {
  return [
    "#!/usr/bin/env bash",
    `${SHIM_MARKER} runs barry as \`${identityName}\`.`,
    "# Installed by `barry identity create` / `barry alias`. Safe to delete.",
    "",
    // Not `--name`: that flag is declared per-command, so it would break every
    // subcommand that does not take it.
    `export BARRY_IDENTITY="${identityName}"`,
    ...Object.entries(installedCommand("barry").environment).map(([name, value]) => `export ${name}=${shellWord(value)}`),
    `exec ${installedCommand("barry").argv.map(shellWord).join(" ")} --identity-binding ${shellQuote(JSON.stringify(binding))} "$@"`,
    "",
  ].join("\n");
}

export interface InstallOutcome {
  name: string;
  status: "installed" | "conflict";
  conflict?: ShimConflict;
}

/**
 * Install one shim. Never throws for a conflict — the caller decides how loud
 * to be, and a refused alias must not fail the command that asked for it.
 */
export function installShim(
  name: string,
  identityName: string,
  options: { binDir: string; barryPath: string; binding?: IdentityBinding },
): InstallOutcome {
  const conflict = findConflict(name, options.binDir);
  if (conflict) return { name, status: "conflict", conflict };

  const directory = options.binding?.directory ?? identityRecords.directory({ name: identityName }) ?? undefined;
  // Without a binding there is no row id to pin: the command binds to the
  // name's hash, and the file is left as it is rather than repinned to it.
  const binding: IdentityBinding = options.binding
    ? { ...options.binding, ...(directory ? { directory } : {}) }
    : { id: identityRecords.syntheticId(identityName), home: process.env.BARRY_HOME ?? null, ...(directory ? { directory } : {}) };
  binding.instance = openInstance(barryAppSupportDir()).id;
  if (directory && options.binding) {
    try {
      // Pinned first, so the command keeps naming the same identity; the
      // shipped identity's shared file is never pinned (see pinBinding).
      identityRecords.pinBinding(directory, binding.id);
    } catch (err) {
      // A refusal like the others: one identity whose file cannot be read must
      // not stop every other identity's command (or `barry doctor --fix`, which
      // installs them before anything else).
      return { name, status: "conflict", conflict: { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) } };
    }
  }

  const target = join(options.binDir, name);
  mkdirSync(dirname(target), { recursive: true });

  // Temp file + rename: a half-written shim on PATH is worse than none.
  const temporaryPath = `${target}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, renderShim(identityName, options.barryPath, binding), "utf8");
  chmodSync(temporaryPath, 0o755);
  renameSync(temporaryPath, target);

  return { name, status: "installed" };
}

/** Remove a shim we installed. Returns false for absent or foreign files. */
export function removeShim(name: string, binDir: string): boolean {
  const target = join(binDir, name);
  if (!existsSync(target) || !isOurShim(target)) return false;
  rmSync(target);
  return true;
}

/** One command name that should exist, and the identity it should run as. */
export interface ShimSpec {
  command: string;
  identity: string;
  binding?: IdentityBinding;
}

export interface EnsureResult {
  /** Written this run — either absent or stale before. */
  installed: string[];
  /** Already ours and already pointing at the right identity. Untouched. */
  current: string[];
  /** Left alone because the name is unusable or somebody else's, or its identity cannot be read. */
  refused: Array<{ command: string; conflict: ShimConflict }>;
}

/**
 * Bring every command in `specs` onto PATH, leaving the ones already correct.
 *
 * Idempotent, and never throws: the caller has usually come from a command that
 * succeeded (birthing an identity, switching to it), and a name collision must
 * not undo that. `installShim` reports a refusal; this collects them so a
 * reconcile over twenty identities can say "eighteen installed, two refused"
 * rather than dying on the first.
 */
export function ensureShims(
  specs: readonly ShimSpec[],
  options: { binDir: string; barryPath: string; binding?: IdentityBinding },
): EnsureResult {
  const result: EnsureResult = { installed: [], current: [], refused: [] };

  for (const spec of specs) {
    if (isCurrentShim(spec.command, spec.identity, options.binDir, spec.binding)) {
      result.current.push(spec.command);
      continue;
    }

    const outcome = installShim(spec.command, spec.identity, { ...options, binding: spec.binding });
    if (outcome.status === "installed") result.installed.push(spec.command);
    else result.refused.push({ command: spec.command, conflict: outcome.conflict! });
  }

  return result;
}

/** Every command name an identity answers to. */
export function shimNamesFor(identityName: string, aliases: string[] = []): string[] {
  return [...new Set([identityName, ...aliases])];
}

/**
 * The installed `barry`, or null when the CLI is being run from a checkout
 * without having been installed.
 *
 * Shims exec this path, so it must be the wrapper on PATH rather than the
 * current process — `process.argv[1]` during `barry heir` may be a source file
 * under a worktree that will not exist tomorrow.
 */
export function findInstalledBarry(): string | null {
  const bin = instanceBinDir();
  if (bin) {
    const barry = join(bin, "barry");
    return existsSync(barry) ? barry : null;
  }
  return whichOnPath("barry");
}

/**
 * An explicit BARRY_HOME keeps command shims under that instance's own bin directory.
 * Without it, callers resolve the installed command from the machine PATH.
 * See docs/decisions/0046-instance-service-and-event-comments.md.
 */
export function instanceBinDir(): string | null {
  const home = process.env.BARRY_HOME;
  return home ? join(resolve(home), "bin") : null;
}

/**
 * The default directory `barry setup` writes the `barry` command into:
 * `$BARRY_HOME/bin` for an isolated instance, otherwise `~/.local/bin` — a
 * directory Barry owns. The Homebrew prefix is used ONLY when Homebrew
 * installed this very checkout (`isHomebrewBarry` on the installed `barry`),
 * because a file Barry drops inside Homebrew's prefix that Homebrew did not
 * install confuses `brew doctor` and survives `brew uninstall`.
 */
export function cliShimDir(): string {
  const bin = instanceBinDir();
  if (bin) return bin;
  const installed = findInstalledBarry();
  if (installed && isHomebrewBarry(installed)) return dirname(installed);
  return join(homedir(), ".local", "bin");
}

/** True when `dir` is a component of the current PATH. */
export function onPath(dir: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).includes(dir);
}

/** The one-line hint printed when a shim lands in a directory not on PATH. */
export function pathHint(dir: string): string {
  return `Note: ${dir} is not in your PATH. Add it to your shell config (e.g. export PATH="${dir}:$PATH") to run 'barry' directly.`;
}

/**
 * Directories a `barry` shim could have been written into by a previous
 * release, other than the current `cliShimDir()`. Setup removes a stale shim
 * found here on migration, and uninstall sweeps them for one release, so the
 * move off the Homebrew prefix leaves nothing behind. The one resolver both
 * commands share, so the two lists cannot drift.
 */
export function legacyCliShimDirs(): string[] {
  const bin = instanceBinDir();
  // An isolated instance never wrote anywhere but its own bin.
  if (bin) return [];
  const current = cliShimDir();
  return ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")].filter((dir) => dir !== current);
}

/** Where shims go: beside the installed `barry`, so they inherit its PATH. */
export function getShimDir(): string | null {
  const barry = findInstalledBarry();
  return barry ? dirname(barry) : null;
}

/** Homebrew owns its link, even when setup runs from another installation. */
export function isHomebrewBarry(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() && /\/Cellar\/barry\//.test(realpathSync(path)); }
  catch { return false; }
}
