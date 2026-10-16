import { Barry } from "@barry-rocks/sdk";
import { CliError, isCliError } from "../lib/cli-error.js";
import { parseVaultName } from "@barry-rocks/sdk/internal/identities";
import type { IdentityRecord } from "@barry-rocks/identities-bag";
import { VaultClient, openVault, vaultAccountFor, configuredVaultEndpoint, type VaultAccount, type VaultSession } from "@barry-rocks/sdk/internal/vault";
import { maskSecret, KeychainProvider } from "@barry-rocks/sdk/internal/env";
import { getCurrentUser, getActiveIdentity } from "../lib/current-user.js";
import { printWarnings } from "../lib/warnings.js";

/**
 * The vault a command should act on.
 *
 * Two ways in, because a vault is now a thing in its own right: name an
 * IDENTITY and get the vault it references, or name the VAULT directly — which
 * is the only way to reach one no identity currently points at.
 *
 * `--name` keeps meaning the identity it always meant. Repurposing it would
 * have made the same command mean two things across an upgrade, and silently:
 * with a vault and an identity sharing a name, both readings succeed and show
 * different secrets.
 *
 * Passing both is refused rather than ranked. They can disagree, and choosing a
 * winner would read the user's secrets out of a vault they did not ask for.
 */
async function getIdentityWithVault(identityName?: string, vaultName?: string) {
  const user = await getCurrentUser();

  if (identityName && vaultName) {
    throw new CliError("Error: pass --name (an identity) or --vault (a vault), not both." + "\n" + "  They can disagree, and picking one would act on a vault you did not name.", 1);
  }

  if (vaultName) {
    let vaultConfig: VaultAccount;
    let vaultRef: string;
    try {
      vaultRef = parseVaultName(vaultName);
      vaultConfig = vaultAccountFor(vaultRef);
    } catch (err) {
      if (isCliError(err)) throw err;
      throw new CliError(`Error: could not resolve vault "${vaultName}" — ${err instanceof Error ? err.message : String(err)}`, 1);
    }
    // No identity is involved when addressing a vault directly. Callers that
    // need one for a per-identity concern must handle its absence rather than
    // being handed a stand-in that quietly stands for the wrong thing.
    return { barry: null as IdentityRecord | null, vaultConfig, vaultRef };
  }

  if (!identityName) {
    identityName = getActiveIdentity(user) ?? undefined;
    if (!identityName) {
      throw new CliError("Error: No barry specified and no active barry set", 1);
    }
  }

  // Not destructured: this module has a `requireIdentity` of its own.
  const identityCommands = await import("./identity.js");
  const { identity: barry } = await identityCommands.requireIdentity(identityName);

  const ref = (barry.metadata as { vault?: unknown } | null)?.vault;
  if (!ref) {
    throw new CliError(`Error: Barry "${identityName}" does not have vault configured` + "\n" + `Provision one:  ${identityName} vault provision --email <email>`, 1);
  }

  const vaultRef = parseVaultName(ref);
  return { barry, vaultConfig: vaultAccountFor(vaultRef), vaultRef };
}

/**
 * Narrow a resolved target to one that carries an identity.
 *
 * `--vault` deliberately resolves without one, which is right for reading a
 * vault nothing points at. Commands that write an identity's config, or label
 * their output with its name, need a real one — so they say so here rather
 * than optional-chaining it into a message that reads "barry undefined".
 */
function requireIdentity(barry: IdentityRecord | null, command: string): IdentityRecord {
  if (!barry) {
    throw new CliError(`Error: \`${command}\` acts on an identity — use --name, not --vault.`, 1);
  }
  return barry;
}



export async function vaultAddCommand(
  identityName: string | undefined,
  key: string,
  secret: string | undefined,
  options: { force?: boolean; vault?: string } = {},
): Promise<void> {
  try {
    // The secret never comes from argv (ps, shell history). When omitted it is
    // read from a masked prompt on a TTY or stdin when piped — the same path
    // `barry env set` and `identity secret set` use.
    const { readSecretValue } = await import("../lib/read-secret.js");
    const value = secret ?? (await readSecretValue(key));
    const { barry, vaultConfig, vaultRef } = await getIdentityWithVault(identityName, options.vault);
    const vault = await openVault(vaultRef);

    const existing = await vault.searchItems(key);
    const exactMatch = existing.find((i) => i.name === key);

    if (exactMatch) {
      if (!options.force && configuredVaultEndpoint(vaultRef) !== undefined) {
        await vault.close();
        throw new CliError(`Error: "${key}" already exists in an instance-configured vault. Other configured names may open the same account, so sharing cannot be established from its name. Re-run with --force to overwrite it explicitly.`, 1);
      }
      // Overwriting in a PRIVATE vault is the point of the command and stays
      // silent. Overwriting in a shared one replaces a value another identity
      // resolves at session start, and the damage does not show up here — it
      // shows up later as that identity authenticating with the wrong
      // credential against some unrelated service.
      const { identitiesSharingVault, describeSharing } = await import("../lib/vault-sharing.js");
      const coUsers = await identitiesSharingVault(vaultConfig, { excludeIdentity: barry?.name });
      const shared = describeSharing(coUsers);

      if (shared && !options.force) {
        throw new CliError(`Error: "${key}" already exists and this vault is not private.` + "\n" + `  ${shared}` + "\n" + `  Overwriting replaces the value those identities resolve at session start.` + "\n" + `` + "\n" + `  Re-run with --force to overwrite it anyway.`, 1);
      }

      await vault.putItem(key, { password: value });
      console.log(`Updated vault item "${key}"`);
      if (shared) console.log(`  (${shared})`);
    } else {
      await vault.putItem(key, { password: value });
      console.log(`Created vault item "${key}"`);
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

export async function vaultListCommand(identityName: string | undefined, options: { vault?: string } = {}): Promise<void> {
  try {
    const { vaultRef } = await getIdentityWithVault(identityName, options.vault);
    const vault = await openVault(vaultRef);
    const items = await vault.listItems();

    if (items.length === 0) {
      console.log("No vault items found.");
      return;
    }

    console.log(`Vault items (${items.length}):\n`);
    for (const item of items) {
      console.log(`  ${item.name}`);
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

export async function vaultGetCommand(identityName: string | undefined, key: string, options: { vault?: string } = {}): Promise<void> {
  try {
    const { vaultRef } = await getIdentityWithVault(identityName, options.vault);
    const vault = await openVault(vaultRef);
    const item = await vault.getItem(key);

    console.log(`${key}:`);
    if (item.username) console.log(`  username: ${item.username}`);
    if (item.password) console.log(`  password: ${maskSecret(item.password)}`);
    if (item.uri) console.log(`  uri: ${item.uri}`);
    if (item.notes) console.log(`  notes: ${item.notes.slice(0, 80)}${item.notes.length > 80 ? "..." : ""}`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

export async function vaultStatusCommand(identityName: string | undefined, options: { vault?: string } = {}): Promise<void> {
  try {
    const { vaultConfig, vaultRef } = await getIdentityWithVault(identityName, options.vault);
    const client = new VaultClient(configuredVaultEndpoint(vaultRef) ?? vaultConfig.serverUrl);
    let vault: VaultSession | undefined;
    const status = await client.status();

    console.log(`Vault status:`);
    console.log(`  Server: ${status.serverUrl}`);
    console.log(`  Connected: ${status.connected}`);
    if (status.error) console.log(`  Error: ${status.error}`);

    if (status.connected) {
      try {
        vault = await openVault(vaultRef);
        const items = await vault.listItems();
        console.log(`  Authenticated: yes`);
        console.log(`  Items: ${items.length}`);
      } catch (err: unknown) {
        console.log(`  Authenticated: no (${err instanceof Error ? err.message : String(err)})`);
      } finally {
        await vault?.close();
      }
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/** Refuse to delete a referenced secret unless the caller explicitly forces deletion. */
export async function vaultRemoveCommand(
  identityName: string | undefined,
  key: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    const { barry: maybeBarry0, vaultConfig, vaultRef } = await getIdentityWithVault(identityName);
    const barry = requireIdentity(maybeBarry0, "vault remove");
    if (!options.force && configuredVaultEndpoint(vaultRef) !== undefined) {
      throw new CliError("Error: Other configured vault names may open this account, so its references cannot be established from its name. Re-run with --force to delete the item explicitly.", 1);
    }
    const vault = await openVault(vaultRef);

    const matches = await vault.searchItems(key);
    const item = matches.find((i) => i.name === key);
    if (!item) {
      throw new CliError(`Error: No vault item named "${key}"`, 1);
    }

    if (!options.force) {
      const { identitiesSharingVault } = await import("../lib/vault-sharing.js");
      const referencedBy: string[] = [];

      const collect = (name: string, metadata: unknown) => {
        const secrets = ((metadata as { secrets?: unknown } | null)?.secrets ?? {}) as import("@barry-rocks/sdk/internal/identities").SecretBindings;
        for (const [secretName, binding] of Object.entries(secrets)) {
          const reference = binding.reference;
          if (reference.in === "vault" && reference.item === key) referencedBy.push(`${name}.${secretName}`);
        }
      };

      if (barry) collect(barry.name, barry.metadata);

      const coUsers = await identitiesSharingVault(vaultConfig, { excludeIdentity: barry?.name });
      if (coUsers.length > 0) {
        // Each identity as it is in effect: its directory when it has one (an
        // unparseable one is already excluded from coUsers), its row otherwise.
        const { identityRecords } = await import("@barry-rocks/identities-bag");
        for (const { record: other } of await identityRecords.list()) {
          if (coUsers.includes(other.name)) collect(other.name, other.metadata);
        }
      }

      if (referencedBy.length > 0) {
        console.error(`Error: vault item "${key}" is still referenced by ${referencedBy.length === 1 ? "a secret reference" : "secret references"}: ${referencedBy.join(", ")}`);
        console.error("");
        console.error("  Deleting it would leave those variables resolving to nothing at session start.");
        if (coUsers.length > 0) {
          console.error(`  This vault is shared with ${coUsers.join(", ")} — a mapping above may not be yours.`);
        }
        throw new CliError(`  Remove the mapping first:  barry identity secret remove <key>` + "\n" + `  Or delete anyway:          barry vault remove ${key} --force`, 1);
      }
    }

    await vault.deleteItem(key);
    console.log(`Deleted vault item "${key}"`);
  } catch (error: unknown) {
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Give an existing Barry a vault account.
 *
 * Until this existed, `barry heir --email` was the only path that provisioned
 * one, and it only runs at birth — so a Barry created without `--email` could
 * never get a vault at all, and the error every other vault command printed
 * ("Provision vault first: barry heir ...") named a command that cannot be run
 * on an identity that already exists.
 *
 * Reuses `provisionVaultAccount` rather than re-registering here: that function
 * owns the keychain account naming, and a second copy of those conventions is
 * how the two would drift. It registers with the server and writes three
 * keychain entries, then this records the vault on the identity, in its
 * `identity.yaml`.
 *
 * Refuses when a vault is already configured: re-registering mints new
 * credentials and orphans every secret stored under the old account, which is
 * silent and unrecoverable. `--force` is for deliberately replacing one.
 */
/**
 * Create a vault account and attach it to an identity.
 *
 * Identity-only by design: provisioning writes an identity's config, so there
 * is nothing for a bare `--vault` to attach to. Reaching an existing vault
 * without an identity is what `--vault` on the read commands is for.
 */
export async function vaultProvisionCommand(
  identityName: string | undefined,
  email: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    const identityCommands = await import("./identity.js");

    // Directory first, then the row — the same order every other mutating
    // identity command uses. Reading the row for a file-based Barry would test
    // `vault` against a stale cache and could re-provision over a live account.
    const { identity: barry } = await identityCommands.requireIdentity(identityName);

    const existingRef = (barry.metadata as { vault?: unknown } | null)?.vault;
    const existingName = existingRef ? parseVaultName(existingRef) : undefined;
    if (configuredVaultEndpoint(barry.name.trim()) !== undefined || existingName && configuredVaultEndpoint(existingName) !== undefined) {
      throw new CliError("Error: Instance-configured vault accounts cannot be provisioned into the legacy Keychain. Configure the account bootstrap in vault-accounts.yaml, then assign its name; --force does not replace it.", 1);
    }
    const existing = existingName ? vaultAccountFor(existingName) : undefined;
    if (existing && !options.force) {
      throw new CliError(`Error: Barry "${barry.name}" already has a vault (${existing.email})` + "\n" + "" + "\n" + "  Re-provisioning mints new credentials, and every secret stored under" + "\n" + "  the current account becomes unreachable. Export them first:" + "\n" + `    barry vault export --name ${barry.name} --out secrets.json` + "\n" + `  Then replace it:  ${barry.name} vault provision --email ${email} --force`, 1);
    }

    console.log(`Provisioning vault account for ${email}...`);
    const vault = await identityCommands.provisionVaultAccount(barry.name, email);
    printWarnings((await Barry.identity(barry.name).update({ vault })).warnings);

    console.log(`Vault provisioned for barry "${barry.name}"`);
    console.log(`  Vault: ${vault}`);
    console.log(`  Email: ${email.trim().toLowerCase()}`);
    console.log(`  Credentials written to the "barry" keychain service.`);
    if (existing) {
      console.log("");
      console.log(`  Replaced the previous account (${existing.email}). Secrets stored under it are no longer reachable.`);
    }
  } catch (error: unknown) {
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Write every vault item to a plaintext JSON file.
 *
 * The vault is zero-knowledge: a new account starts empty and the server cannot
 * move secrets between accounts, so moving a Barry to its own vault means
 * carrying them out and back in. There is no encrypted-transfer path to prefer
 * over this one — the alternative is retyping every secret.
 *
 * The file is written 0600 and the path is printed so it can be deleted. It is
 * plaintext on purpose: an encrypted export needs a key, and a key the same
 * machine stores beside the file protects nothing.
 */
export async function vaultExportCommand(
  identityName: string | undefined,
  outPath: string,
): Promise<void> {
  try {
    const { writeFileSync } = await import("node:fs");
    const path = await import("node:path");

    const { barry: maybeBarry1, vaultRef } = await getIdentityWithVault(identityName);
    const barry = requireIdentity(maybeBarry1, "vault export");
    const vault = await openVault(vaultRef);

    const summaries = await vault.listItems();
    const items = [];
    for (const summary of summaries) {
      const full = await vault.getItem(summary.name);
      items.push({
        name: summary.name,
        username: full.username ?? undefined,
        password: full.password ?? undefined,
        uri: full.uri ?? undefined,
        notes: full.notes ?? undefined,
      });
    }

    const target = path.resolve(outPath);
    // Use the authenticated session email so restore can identify the account.
    // See docs/decisions/0036-cli-launch-and-persistence-rationale.md.
    const email = vault.email;
    // 0600 before any bytes land: writing then chmod-ing leaves a window where
    // the file is world-readable, and these are cleartext credentials.
    writeFileSync(target, JSON.stringify({ barry: barry.name, email, items }, null, 2), { mode: 0o600 });

    console.log(`Exported ${items.length} item${items.length === 1 ? "" : "s"} from barry "${barry.name}"`);
    console.log(`  ${target}`);
    console.log("");
    console.log("  This file holds cleartext secrets. Delete it once imported:");
    console.log(`    rm ${target}`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Load items from a `vault export` file into this Barry's vault.
 *
 * Skips names that already exist rather than overwriting, so a re-run after a
 * partial failure is safe and cannot clobber a secret that was rotated in the
 * meantime. `--overwrite` updates them instead, for the case where the file is
 * the newer copy.
 */
export async function vaultImportCommand(
  identityName: string | undefined,
  filePath: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  try {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");

    const { barry: maybeBarry2, vaultRef } = await getIdentityWithVault(identityName);
    const barry = requireIdentity(maybeBarry2, "vault import");
    const vault = await openVault(vaultRef);

    const source = path.resolve(filePath);
    const parsed = JSON.parse(readFileSync(source, "utf8")) as {
      items?: Array<{ name?: string; username?: string; password?: string; uri?: string; notes?: string }>;
    };
    if (!Array.isArray(parsed.items)) {
      throw new CliError(`Error: ${source} is not a vault export (no "items" array)`, 1);
    }

    const existing = new Set((await vault.listItems()).map((i) => i.name));
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const item of parsed.items) {
      if (!item?.name) continue;
      if (existing.has(item.name)) {
        if (!options.overwrite) {
          skipped++;
          continue;
        }
        await vault.putItem(item.name, {
          username: item.username ?? null,
          password: item.password ?? null,
          uri: item.uri ?? null,
          notes: item.notes ?? null,
        });
        updated++;
      } else {
        await vault.putItem(item.name, {
          username: item.username ?? null,
          password: item.password ?? null,
          uri: item.uri ?? null,
          notes: item.notes ?? null,
        });
        created++;
      }
    }

    console.log(`Imported into barry "${barry.name}": ${created} created, ${updated} updated, ${skipped} skipped`);
    if (skipped > 0) {
      console.log(`  ${skipped} already existed. Re-run with --overwrite to replace them.`);
    }
  } catch (error: unknown) {
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Point an identity at a named vault.
 *
 * The write is one line of YAML; the care is in what it implies. Assigning a
 * vault another identity already uses makes every item in it shared, so the
 * collisions are reported BEFORE the assignment rather than discovered later
 * as one identity overwriting another's credential.
 *
 * Legacy accounts store their email in Keychain beside the credentials;
 * instance-configured accounts authenticate through their declared bootstrap
 * without changing Keychain. The email salts deriveKeys — see
 * the account email read at login (see vaultEmail in @barry-rocks/sdk/vault/account). Without this the assignment would
 * look fine and fail at login as a MAC error.
 */
export async function vaultAssignCommand(
  vaultName: string,
  options: { identity?: string; email?: string } = {},
): Promise<void> {
  try {
    const user = await getCurrentUser();
    const identityName = options.identity ?? getActiveIdentity(user) ?? undefined;
    if (!identityName) {
      throw new CliError("Error: No identity specified and no active identity is set" + "\n" + "  barry vault assign <vault> --identity <name>", 1);
    }

    vaultName = parseVaultName(vaultName);
    const identityCommands = await import("./identity.js");
    const { identity: barry, dir } = await identityCommands.requireIdentity(identityName);
    const configured = configuredVaultEndpoint(vaultName) !== undefined;
    if (configured) {
      // Verify the selected configured account before writing the identity's
      // reference. Its bootstrap belongs to the instance, never Keychain.
      const selected = await openVault(vaultName);
      try {
        if (options.email && options.email.trim().toLowerCase() !== selected.email.trim().toLowerCase()) {
          throw new CliError("Error: --email differs from the configured vault account. Update its declared bootstrap explicitly; assignment does not rewrite credentials.", 1);
        }
      } finally { await selected.close(); }
    } else {
      const kc = new KeychainProvider({ service: "barry" });

      // The credentials must already exist: assign POINTS AT a vault, it does not
      // create one. Writing the reference first and discovering the vault is
      // absent at session start is the failure this check exists to prevent.
      const clientId = await kc.get("", `vault-${vaultName}-client-id`);
      if (!clientId) {
        throw new CliError(`Error: no vault named "${vaultName}" (keychain barry/vault-${vaultName}-client-id is empty).` + "\n" + `  Provision one first:  ${identityName} vault provision --email <email>`, 1);
      }

      // Needed for key derivation, and not derivable from the name.
      const emailAccount = `vault-${vaultName}-email`;
      const storedEmail = await kc.get("", emailAccount);
      if (!storedEmail) {
        if (!options.email) {
          throw new CliError(`Error: vault "${vaultName}" has no stored account email, and none was given.` + "\n" + `  The email salts key derivation, so a missing one fails at login as a` + "\n" + `  decryption error rather than a lookup miss. Supply it once:` + "\n" + `` + "\n" + `    barry vault assign ${vaultName} --identity ${identityName} --email <address>`, 1);
        }
        await kc.set(emailAccount, options.email.toLowerCase());
      } else if (options.email && options.email.toLowerCase() !== storedEmail) {
        throw new CliError(`Error: vault "${vaultName}" is registered to ${storedEmail}, not ${options.email}.` + "\n" + `  Refusing to repoint it — that would silently open a different account.`, 1);
      }
    }

    let target: VaultAccount;
    try {
      target = vaultAccountFor(vaultName);
    } catch (err) {
      if (isCliError(err)) throw err;
      throw new CliError(`Error: could not resolve vault "${vaultName}" — ${err instanceof Error ? err.message : String(err)}`, 1);
    }

    // Who else opens it, and which of their items this identity would collide
    // with. Reported, not refused: sharing is usually the point.
    const { identitiesSharingVault } = await import("../lib/vault-sharing.js");
    const coUsers = await identitiesSharingVault(target, { excludeIdentity: identityName });

    const previousRef = (barry.metadata as { vault?: unknown } | null)?.vault;
    if (previousRef) {
      console.log(`Replacing this identity's existing vault config.`);
    }

    printWarnings((await Barry.identity(barry.name).update({ vault: vaultName })).warnings);

    console.log(`Assigned vault "${vaultName}" to ${identityName}${dir ? ` (${dir}/identity.yaml)` : ""}`);
    if (configured) console.log("  Other configured vault names may open this same account. Its items are shared across every alias; the name alone does not establish isolation.");

    if (coUsers.length > 0) {
      console.log(``);
      console.log(`  Shared with: ${coUsers.join(", ")}`);
      console.log(`  Items in this vault are now visible to every identity above,`);
      console.log(`  and writing one overwrites it for all of them.`);
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}
