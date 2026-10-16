/**
 * barry identity create <name> — Create a new Barry (directory + config)
 *
 * The one implementation behind both `barry identity create` and the
 * `barry heir to the <name> empire` easter egg, so the two cannot drift.
 * Choosing which identity to use lives in `use.ts`.
 */

import { join, resolve } from "node:path";
import { CliError } from "../lib/cli-error.js";
import { Barry, isBarryError, type Identity, type Updated } from "@barry-rocks/sdk";
import { identityRecords, isNumericIdentityName } from "@barry-rocks/identities-bag";
import { getCurrentUser, setActiveIdentity, getPersistedActiveIdentity } from "../lib/current-user.js";
import { describeConflict, findInstalledBarry, getShimDir, installShim } from "../lib/identity-shims.js";
import { printWarnings } from "../lib/warnings.js";
import type { IdentityBinding } from "../target.js";
import { provisionVaultAccount } from "./identity.js";

export interface CreateIdentityOptions {
  email?: string;
  dir?: string;
}

/** The lines that open and close creation — the only place heir and create differ. */
export interface CreationWording {
  starting: (name: string) => string;
  ready: (name: string) => string;
}

const PLAIN_WORDING: CreationWording = {
  starting: (name) => `Creating identity ${name}...`,
  ready: (name) => `Identity ${name} is ready.`,
};

/**
 * The identity's name as typed, and the slug it is stored and run under.
 * Lowercased, punctuation and spaces removed, truncated to 32 chars. Null when
 * nothing usable is left.
 *
 * Examples:
 *   "B. Goode"  → "bgoode"
 *   "Bucks"     → "bucks"
 *   "Dr. Funk"  → "drfunk"
 */
export function nameIdentity(name: string): { name: string; slug: string } | null {
  const trimmed = name.trim();
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  return slug ? { name: trimmed, slug } : null;
}

/** `barry identity create <name>`. */
export async function identityCreateCommand(
  name: string,
  options: CreateIdentityOptions = {},
): Promise<void> {
  const named = nameIdentity(name);
  if (!named) {
    throw new CliError(`Error: "${name}" has no letters or digits to name an identity with`, 1);
  }
  await createIdentity(named, options);
}

/** Scaffold, register and announce a new Barry. Exits on a name already taken. */
export async function createIdentity(
  { name, slug }: { name: string; slug: string },
  options: CreateIdentityOptions = {},
  wording: CreationWording = PLAIN_WORDING,
): Promise<void> {
  const displayName = `Barry ${name}`;

  // A Barry is a repo you work in, so it belongs beside your other repos rather
  // than buried in ~/.barry. `barry-<slug>` because the directory ends up in a
  // repo list next to everything else, where a bare slug says nothing.
  // The operation records the location in ~/.barry/identities.yaml so `use`,
  // the API and My Identities can still find it.
  const identityDir = options.dir ? resolve(options.dir) : join(process.cwd(), `barry-${slug}`);

  // Refused before anything is provisioned: a vault registered for a name that
  // is already taken would be orphaned. The operation checks again (the target
  // directory, every known identity source and the rows) and says "conflict".
  if (isNumericIdentityName(slug)) {
    throw new CliError("Error: Identity names cannot contain only digits; choose a name such as b3.", 1);
  }
  const existingDir = identityRecords.directory({ name: slug });
  if (existingDir) {
    throw new CliError(`Error: Barry "${slug}" already exists at ${existingDir}`, 1);
  }

  const user = await getCurrentUser();
  // The persisted default, not the resolved one: run under an identity
  // command, an override would look like an existing default and the first
  // Barry would never claim the pointer.
  const firstBarry = !getPersistedActiveIdentity(user);

  console.log(`\n${wording.starting(name)}\n`);

  // Provision the vault before creating: registration can fail, and a Barry
  // whose directory exists but whose vault doesn't is worse than neither.
  let vault: string | undefined;
  if (options.email) {
    console.log(`  Provisioning vault account for ${options.email}...`);
    vault = await provisionVaultAccount(slug, options.email);
  }

  let created: Updated<Identity>;
  try {
    created = await Barry.createIdentity({
      name: slug,
      directory: identityDir,
      displayName,
      bags: [],
      // No adapter model: leaving it out lets each session fall through to the
      // harness CLI's own current default. Writing one freezes the new Barry
      // to whatever was current at scaffold time.
      ...(vault ? { vault } : {}),
    });
  } catch (error) {
    if (!isBarryError(error)) throw error;
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(`  ${error.hint}`);
    throw new CliError("", 1);
  }
  printWarnings(created.warnings);
  const createdDir = created.directory ?? identityDir;

  console.log(`  Created ${createdDir}/`);
  console.log(`  Created ${createdDir}/identity.yaml`);
  console.log(`  Created ${createdDir}/bags/`);
  console.log(`  Created ${createdDir}/.env`);
  console.log(`  Created ${createdDir}/.gitignore`);
  if (vault) console.log(`  Vault: ${vault}`);
  console.log(`\n  Synced to DB (barry id: ${created.id})`);

  if (firstBarry) {
    await setActiveIdentity(slug);
    console.log(`  Set as active barry (first Barry)`);
  }

  const shimInstalled = installIdentityCommand(slug, { id: created.id, home: process.env.BARRY_HOME ?? null, directory: createdDir });

  console.log(`\n${wording.ready(name)}\n`);
  const hints: Array<[string, string]> = [
    ...(shimInstalled ? [[`Run as ${slug}:`, `${slug} <command>`] as [string, string]] : []),
    ["Install bags:", `git clone <repo> && ${slug} install ./<repo>   (installs, then offers to pack)`],
    ["Pack installed:", `${slug} pack <bag>`],
    ["Use everywhere:", `barry use ${slug}`],
    ["Use in this repo:", `barry use ${slug} --local`],
  ];
  // Padded to the widest label: "Run as <slug>:" grows with the slug.
  const width = Math.max(...hints.map(([label]) => label.length));
  for (const [label, command] of hints) console.log(`  ${label.padEnd(width)}  ${command}`);
  console.log("");
}

/**
 * Put `<slug>` on PATH so it runs barry as this identity.
 *
 * Never fatal: the identity exists either way, and losing it over a command
 * name that happens to be taken would be the wrong trade. Returns whether the
 * command is now available, so the caller only advertises what works.
 */
function installIdentityCommand(slug: string, binding: IdentityBinding): boolean {
  const binDir = getShimDir();
  const barryPath = findInstalledBarry();
  if (!binDir || !barryPath) {
    // Running from a checkout that was never installed — nothing to point at.
    return false;
  }

  const outcome = installShim(slug, slug, { binDir, barryPath, binding });
  if (outcome.status === "installed") {
    console.log(`  Installed \`${slug}\` command`);
    return true;
  }

  console.warn(`  Skipped the \`${slug}\` command — ${describeConflict(slug, outcome.conflict!)}`);
  console.warn(`  Add another name with: barry alias ${slug} <name>`);
  return false;
}
