/**
 * `barry use` — choose the identity sessions run as.
 *
 * Without a flag it sets the global default (what `barry switch` did). With
 * `--local` it writes a `.barry` file so this directory overrides that default,
 * the way `git config --local` overrides `--global`.
 */

import { homedir } from "node:os";
import { CliError, isCliError } from "../lib/cli-error.js";
import { select } from "@inquirer/prompts";
import { ExitPromptError, CancelPromptError } from "@inquirer/core";

// The persisted variant, deliberately: this command reports and changes the
// *stored* default, so a BARRY_IDENTITY override from an identity command must
// not stand in for it — `bux use --list` has to say what the default really is.
import { getCurrentUser, setActiveIdentity, getPersistedActiveIdentity } from "../lib/current-user.js";
import { describeReconcile, reconcileAllIdentities } from "../lib/identity-commands.js";
import { clearRepoIdentity, writeRepoIdentity, type WriteResult } from "../lib/repo-identity.js";

export interface UseOptions {
  local?: boolean;
  clear?: boolean;
  list?: boolean;
}

/** Print a path the way the user thinks of it. */
function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** How the exclude attempt went, as a line to print — or null to stay quiet. */
export function describeExclusion(excluded: WriteResult["excluded"]): string | null {
  switch (excluded) {
    case "added":
      return "Excluded via .git/info/exclude — it stays on this machine.";
    case "gitignored":
      return ".gitignore already covers it — it stays on this machine.";
    case "already":
      return "Already excluded from git.";
    case "unavailable":
      // Not a git repo, so there is nothing to exclude it from. Say so rather
      // than implying the file is protected when nothing is protecting it.
      return "Not a git repository — nothing excludes this file, so don't commit it.";
  }
}

/** Every identity name, directory-based first, DB rows that don't shadow one after. */
async function listIdentityNames(): Promise<string[]> {
  const { identityRecords } = await import("@barry-rocks/identities-bag");
  return (await identityRecords.list()).map((entry) => entry.record.name);
}

export async function useCommand(name?: string, options: UseOptions = {}): Promise<void> {
  try {
    const user = await getCurrentUser();
    const currentActive = getPersistedActiveIdentity(user);
    const cwd = process.cwd();

    const { identityRecords } = await import("@barry-rocks/identities-bag");
    const repoRoot = identityRecords.gitRoot(cwd) ?? cwd;

    if (options.list) {
      await listBindings(repoRoot, currentActive);
      return;
    }

    if (options.clear) {
      if (!options.local) {
        throw new CliError("Error: --clear only applies to --local. The global default is changed by setting a new one." + "\n" + "  barry use --local --clear   # remove this repo's .barry", 1);
      }

      // Read before removing so we can name what is going away, and what takes
      // over — "cleared" alone leaves the user guessing what they now run as.
      let previous: string | null = null;
      try {
        previous = identityRecords.repoDefault(repoRoot).identityName;
      } catch {
        // A malformed .barry still needs clearing; that is often *why*.
      }

      if (!clearRepoIdentity(repoRoot)) {
        console.log(`No .barry in ${displayPath(repoRoot)} — nothing to clear.`);
        return;
      }

      console.log(`Cleared .barry in ${displayPath(repoRoot)}${previous ? ` (was: ${previous})` : ""}`);
      console.log(`  Sessions here now use: ${currentActive ?? "no identity — set one with `barry use`"}`);
      return;
    }

    const available = await listIdentityNames();
    if (available.length === 0) {
      console.log("No identities found. Create one with: barry identity create <name>");
      return;
    }

    if (!name) {
      const where = options.local ? displayPath(repoRoot) : "globally";
      try {
        name = await select({
          message: options.local ? `Use which identity in ${where}?` : "Use which identity globally?",
          choices: available.map((n) => ({
            name: `${n}${n === currentActive ? " (current global default)" : ""}`,
            value: n,
          })),
        });
      } catch (err) {
        if (err instanceof ExitPromptError || err instanceof CancelPromptError) return;
        throw err;
      }
    }

    if (!available.includes(name)) {
      console.error(`Error: No identity named "${name}" found`);
      console.error("");
      console.error("Available:");
      for (const n of available) {
        console.error(`  ${n}${n === currentActive ? " (current global default)" : ""}`);
      }
      throw new CliError("", 1);
    }

    if (options.local) {
      const { excluded } = writeRepoIdentity(repoRoot, name);
      console.log(`Now using ${name} in ${displayPath(repoRoot)}.`);

      const exclusion = describeExclusion(excluded);
      if (exclusion) console.log(`  ${exclusion}`);

      if (currentActive && currentActive !== name) {
        console.log(`  Global default is still ${currentActive}.`);
      }
      await ensureIdentityCommands();
      return;
    }

    if (currentActive === name) {
      console.log(`Already using ${name} globally.`);
      await ensureIdentityCommands();
      return;
    }

    await setActiveIdentity(name);
    console.log(`Now using ${name} globally.`);
    if (currentActive) console.log(`  (was: ${currentActive})`);
    await ensureIdentityCommands();
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Put every identity's command on PATH.
 *
 * `barry use` is where someone discovers `<name>` does not resolve — they type
 * it, or they are about to. Reconciling here means the fix arrives with the
 * switch rather than never. Silent when everything is already installed; see
 * describeReconcile.
 */
async function ensureIdentityCommands(): Promise<void> {
  for (const line of describeReconcile(await reconcileAllIdentities())) {
    console.log(`  ${line}`);
  }
}

/** `barry use --list` — the global default, plus this repo's binding if it has one. */
async function listBindings(repoRoot: string, currentActive: string | null): Promise<void> {
  const { identityRecords } = await import("@barry-rocks/identities-bag");

  console.log(`Global default: ${currentActive ?? "(none)"}`);

  let repoIdentity: string | null = null;
  let malformed: string | null = null;
  try {
    repoIdentity = identityRecords.repoDefault(repoRoot).identityName;
  } catch (error) {
    malformed = error instanceof Error ? error.message : String(error);
  }

  console.log("");
  if (malformed) {
    // Surfaced here rather than swallowed: this file breaks every session in the
    // repo, and this is the command someone runs to find out why.
    console.log(`${displayPath(repoRoot)}: unreadable .barry`);
    console.log(`  ${malformed}`);
    console.log("  Fix with: barry use --local");
    return;
  }

  if (!repoIdentity) {
    console.log(`${displayPath(repoRoot)}: no .barry (uses the global default)`);
    console.log("  Pin one with: barry use --local");
    return;
  }

  console.log(`${displayPath(repoRoot)}: ${repoIdentity}`);

  // Every identity known to this actor, so an unresolvable binding is caught
  // here rather than at the next session start.
  const available = await listIdentityNames();
  if (!available.includes(repoIdentity)) {
    console.log(`  Warning: "${repoIdentity}" does not exist locally — sessions here will fail.`);
    console.log("  Fix with: barry use --local");
  }
}
