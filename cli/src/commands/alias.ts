/**
 * `barry alias` — extra command names for an identity.
 *
 * `barry alias bgoode bgo` makes `bgo` run barry as `bgoode`. The name is
 * recorded in the identity's `identity.yaml` and installed as a shim on PATH.
 */

import { Barry } from "@barry-rocks/sdk";
import { CliError, isCliError } from "../lib/cli-error.js";
import { identityRecords, type IdentityEntry } from "@barry-rocks/identities-bag";
import { getCurrentUser } from "../lib/current-user.js";
import { printWarnings } from "../lib/warnings.js";
import {
  describeConflict,
  findConflict,
  findInstalledBarry,
  getShimDir,
  installShim,
  removeShim,
} from "../lib/identity-shims.js";

export interface AliasOptions {
  remove?: boolean;
  list?: boolean;
}

/** Aliases recorded on an identity, in yaml order. */
function aliasesOf(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.aliases;
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
}

export async function aliasCommand(
  identityOrAlias?: string,
  alias?: string,
  options: AliasOptions = {},
): Promise<void> {
  try {
    await getCurrentUser();
    // Aliases are recorded in identity.yaml, so only identities with a
    // directory carry them.
    const owned = (await identityRecords.list()).filter((entry) => entry.source === "file");
    const records = owned.map((entry) => entry.record);

    if (options.list || (!identityOrAlias && !options.remove)) {
      listAliases(records);
      return;
    }

    if (options.remove) {
      if (!identityOrAlias) {
        throw new CliError("Usage: barry alias --remove <alias>", 1);
      }
      await removeAlias(identityOrAlias, owned);
      return;
    }

    if (!alias) {
      throw new CliError("Usage: barry alias <identity> <alias>" + "\n" + "       barry alias --remove <alias>" + "\n" + "       barry alias --list", 1);
    }

    const found = owned.find((entry) => entry.record.name === identityOrAlias);
    if (!found) {
      console.error(`Error: No identity named "${identityOrAlias}"`);
      console.error("");
      console.error("Available:");
      for (const b of records) console.error(`  ${b.name}`);
      throw new CliError("", 1);
    }
    const identity = found.record;

    // Refuse before writing anything: an alias recorded in identity.yaml but
    // absent from PATH is a promise the CLI cannot keep.
    const binDir = getShimDir();
    const barryPath = findInstalledBarry();
    if (!binDir || !barryPath) {
      throw new CliError("Error: barry is not installed on PATH, so an alias would have nowhere to go." + "\n" + "  Install it first: ./install", 1);
    }

    const conflict = findConflict(alias, binDir);
    if (conflict) {
      throw new CliError(`Error: ${describeConflict(alias, conflict)}`, 1);
    }

    const dir = found.dir;
    if (!dir) {
      throw new CliError(`Error: "${identity.name}" has no directory to record the alias in.`, 1);
    }

    const existing = aliasesOf(identity.metadata);
    if (existing.includes(alias)) {
      console.log(`${identity.name} already answers to \`${alias}\`.`);
      return;
    }

    // A partial update: every other key in identity.yaml is kept.
    printWarnings((await Barry.identity(identity.name).update({ aliases: [...existing, alias] })).warnings);

    const outcome = installShim(alias, identity.name, { binDir, barryPath, binding: { id: identity.id, home: process.env.BARRY_HOME ?? null, directory: dir } });
    if (outcome.status !== "installed") {
      // Recorded but not installed — say so rather than reporting success.
      throw new CliError(`Recorded the alias, but could not install it — ${describeConflict(alias, outcome.conflict!)}`, 1);
    }

    console.log(`\`${alias}\` now runs barry as ${identity.name}.`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

function listAliases(identities: { name: string; metadata?: Record<string, unknown> }[]): void {
  if (identities.length === 0) {
    console.log("No identities found. Create one with: barry identity create <name>");
    return;
  }

  for (const identity of identities) {
    const aliases = aliasesOf(identity.metadata);
    console.log(`${identity.name}${aliases.length > 0 ? `  (also: ${aliases.join(", ")})` : ""}`);
  }
}

async function removeAlias(alias: string, owned: readonly IdentityEntry[]): Promise<void> {
  const entry = owned.find((b) => aliasesOf(b.record.metadata).includes(alias));
  if (!entry) {
    console.log(`No identity answers to \`${alias}\`.`);
    return;
  }
  const owner = entry.record;

  if (entry.dir) {
    const kept = aliasesOf(owner.metadata).filter((a) => a !== alias);
    // `null` deletes the key, so a last alias leaves no empty list behind.
    printWarnings((await Barry.identity(owner.name).update({ aliases: kept.length > 0 ? kept : null })).warnings);
  }

  const binDir = getShimDir();
  const removed = binDir ? removeShim(alias, binDir) : false;

  console.log(`\`${alias}\` no longer runs barry as ${owner.name}.`);
  if (!removed) {
    // The shim was missing or someone else's — either way, do not imply we
    // deleted a file we did not.
    console.log(`  (no \`${alias}\` command of ours was on PATH)`);
  }
}
