import { requiredNames, optionalNames } from "@barry-rocks/sdk/internal/identities";
import { CliError, isCliError } from "../lib/cli-error.js";
import { reportBoundProblems } from "./doctor-bounds.js";
import { Barry, isBarryError } from "@barry-rocks/sdk";
import {
  identityRecords,
  traits,
  type IdentityEntry,
  type IdentityRecord,
  type UserRecord,
} from "@barry-rocks/identities-bag";
import { homedir } from "node:os";
// the catalog subpath is provider-free — see cli/src/index.ts's
// import for the full rationale (this file's only agent-runtime dependency).
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { installedModels, isOfferedModel, offeredModels, routedVendorOf, suggestOfferedModels } from "@barry-rocks/sdk/adapters/models";
import { modelRef, parseModelRef } from "@barry-rocks/sdk/ids";
import type { Vendor } from "@barry-rocks/sdk/adapters/models";
import { VaultClient, openVault, vaultAccountFor, type VaultSession } from "@barry-rocks/sdk/internal/vault";
import { KeychainProvider, identityEnvironment } from "@barry-rocks/sdk/internal/env";

import { loadBags, expandCompositionFromSnapshot, loadBagToolDefinitions, mergeBags } from "@barry-rocks/sdk/internal/bags";

import { applyToolVisibility } from "@barry-rocks/sdk/internal/tools";

import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { defaultHarness, FALLBACK_HARNESS, mergeAdapters, type SecretBindings } from "@barry-rocks/sdk/internal/identities";
import { getShimDir, removeShim, shimNamesFor, type ShimSpec } from "../lib/identity-shims.js";
import { collectIdentities, describeReconcile, findMissingCommands, reconcileCommands } from "../lib/identity-commands.js";
import { getCurrentUser, getActiveIdentity } from "../lib/current-user.js";
import { reportIdentityProblems } from "./doctor-identities.js";
import { resolveLaunchMode, isRefusal } from "./launch-mode.js";
import { printWarnings } from "../lib/warnings.js";

// The vault endpoint belongs to this installation, not to an identity.
const VAULT_URL = process.env.VAULT_URL ?? "unix:///usr/local/var/barry-vault/run/vault.sock";
const KEYCHAIN_SERVICE = "barry";

/** Provision a named vault and keep its bootstrap credentials in Keychain. */
export async function provisionVaultAccount(vaultName: string, email: string): Promise<string> {
  const account = vaultAccountFor(vaultName);
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) throw new Error("Vault account email must not be empty");
  const secrets = await installationSecrets(["VAULT_REGISTRATION_SECRET"]);
  const client = new VaultClient(VAULT_URL, { registrationSecret: secrets.VAULT_REGISTRATION_SECRET });
  const registration = await client.register(normalizedEmail);
  const keychain = new KeychainProvider({ service: KEYCHAIN_SERVICE });
  const entries = [
    [account.credentials.clientId.account, registration.clientId],
    [account.credentials.clientSecret.account, registration.clientSecret],
    [account.credentials.masterPassword.account, registration.masterPassword],
    [`vault-${vaultName.trim()}-email`, normalizedEmail],
  ] as const;
  for (const [name, value] of entries) {
    await keychain.set(name, value);
    if (await keychain.get("", name) !== value) throw new Error(`Vault credential verification failed for ${name}`);
  }
  return vaultName.trim();
}

/**
 * Resolve the identity a command should act on.
 *
 * Omitting the name targets the active identity, which is what you almost always
 * mean — you're configuring the one you're on. Passing a name targets that one
 * instead.
 *
 * The CLI's one identity resolution: every command acting on a named identity
 * comes through here, or asks `identityRecords.find` itself when it must not
 * exit. It looks at the directory first (for a file-based identity the DB row
 * is a stale cache, and reading it makes commands reason about config that
 * isn't in effect), wherever the registry records it.
 */
export async function requireIdentity(
  identityName?: string,
): Promise<{ user: UserRecord; identity: IdentityRecord; dir: string | null; source: IdentityEntry["source"] }> {
  const user = await getCurrentUser();

  const name = identityName ?? getActiveIdentity(user);
  if (!name) {
    throw new CliError("Error: No identity specified and no active identity is set" + "\n" + "" + "\n" + "  barry use <name>        # set the identity to use" + "\n" + "  barry <command> <name>  # or name one explicitly", 1);
  }

  let found: IdentityEntry;
  try {
    found = await identityRecords.find(name);
  } catch (error) {
    if (!isBarryError(error)) throw error;
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(`  ${error.hint}`);
    throw new CliError("", 1);
  }
  return { user, identity: found.record, dir: found.dir, source: found.source };
}

/**
 * List all identities
 */
export async function listIdentitiesCommand(): Promise<void> {
  try {
    const user = await getCurrentUser();
    const activeName = getActiveIdentity(user);

    // File-based Identities live in directories, not rows. A same-named row is a
    // cache of one, so the operation lists the directory and not the row.
    const listed = await identityRecords.list();
    const fileIdentities = listed.filter((entry) => entry.source === "file");
    const dbOnly = listed.filter((entry) => entry.source === "db").map((entry) => entry.record);

    if (dbOnly.length === 0 && fileIdentities.length === 0) {
      console.log("No identities found.");
      console.log("\nCreate one with: barry identity create <name>");
      return;
    }

    if (fileIdentities.length > 0) {
      // Identities can live anywhere now (`heir` creates one in the cwd), so show
      // each directory rather than naming a single root that may hold none.
      const home = homedir();
      console.log("Identities:\n");
      for (const { record: identity, dir } of [...fileIdentities].sort((a, b) => a.record.name.localeCompare(b.record.name))) {
        const activeMarker = identity.name === activeName ? " (active)" : "";
        const where = dir ? `  ${dir.replace(home, "~")}` : "";
        console.log(`  ${identity.name}${activeMarker}${where}`);
      }
      console.log("");
    }

    if (dbOnly.length > 0) {
      console.log("Database identities:\n");
      for (const identity of [...dbOnly].sort((a, b) => a.name.localeCompare(b.name))) {
        const activeMarker = identity.name === activeName ? " (active)" : "";
        const lastUsed = identity.last_used_at
          ? `last used ${formatRelativeTime(new Date(identity.last_used_at))}`
          : "never used";
        console.log(`  ${identity.name} - ${identity.token} - ${lastUsed}${activeMarker}`);
      }
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Show barry details
 */
export async function showIdentityCommand(name?: string): Promise<void> {
  try {
    const user = await getCurrentUser();

    if (!name) {
      const defaultName = getActiveIdentity(user);
      if (!defaultName) {
        throw new CliError("Error: No identity specified and no active identity is set" + "\n" + "\nEither:" + "\n" + "  1. Name one: barry show <name>" + "\n" + "  2. Set the identity to use: barry use <name>", 1);
      }
      name = defaultName;
      console.log(`Showing active identity: \n`);
    }

    // The directory first — a file-based identity's identity.yaml is the truth,
    // and a same-named DB row is only a cache of it.
    const { identity, dir, source } = await requireIdentity(name);

    if (source === "file") {
      // Report where it actually lives. `heir` creates identities beside your
      // other repos and registers the path, so assuming the well-known
      // directory would print somewhere the config isn't.
      console.log(`Identity: ${identity.name}`);
      console.log(`  Source: ${dir ?? "(directory)"}`);
    } else {
      console.log(`Identity: ${identity.name}`);
      console.log(`  Source: database`);
      console.log(`  Token: ${identity.token}`);
    }

    // A file identity with no row is built as it loads, so its dates are "now".
    // Real ones live on its row, when the identity has one: the record then
    // carries the row's id.
    const dated = source === "file" ? await identityRecords.row(identity.id) : identity;
    if (dated) {
      console.log(`  Created: ${dated.created_at}`);
      if (dated.last_used_at) {
        console.log(`  Last used: ${dated.last_used_at}`);
      }
    }

    const resolved = identityRecords.config(identity);

    console.log("");

    if (resolved.bags.length > 0) {
      console.log(`  Bags: ${resolved.bags.join(", ")}`);
    }

    if (resolved.traits.length > 0) {
      console.log(`  Traits: ${requiredNames(resolved.traits).join(", ")}`);
    }

    if (optionalNames(resolved.traits).length) console.log(`  Optional traits: ${optionalNames(resolved.traits).join(", ")}`);
    if (resolved.bounds.length) {
      console.log(`  Bounds: ${requiredNames(resolved.bounds).join(", ")}`);
      if (optionalNames(resolved.bounds).length) console.log(`  Optional bounds: ${optionalNames(resolved.bounds).join(", ")}`);
    }

    // A file-based Barry writes its rules inline instead of naming a scope, so
    // summarize them rather than printing an id it doesn't have.
    if (resolved.bound) {
      const s = resolved.bound;
      const parts = [
        s.deniedTools?.length ? `tools: ${s.deniedTools.join(", ")}` : null,
        s.deniedAccess?.length ? `access: ${s.deniedAccess.join(", ")}` : null,
        s.files?.deny?.length ? `files: ${s.files.deny.join(", ")}` : null,
        s.bash?.deny?.length ? `bash: ${s.bash.deny.join(", ")}` : null,
      ].filter(Boolean);
      console.log(`  Bound (inline; run barry doctor --fix): ${parts.length > 0 ? parts.join(" | ") : "no denials"}`);
    }

    const secretNames = Object.keys(resolved.secrets);
    if (secretNames.length > 0) {
      console.log(`  Secrets: ${secretNames.join(", ")}`);
    }

    const chosen = (() => { try { return defaultHarness(resolved.adapters); } catch { return undefined; } })();
    const adapterLines = Object.entries(resolved.adapters).map(([id, entry]) => {
      const fields = [id === chosen ? "default" : undefined, entry.model ? `model ${entry.model}` : undefined, entry.mode ? `mode ${entry.mode}` : undefined].filter(Boolean);
      return `${id}${fields.length ? ` (${fields.join(", ")})` : ""}`;
    });
    if (adapterLines.length) console.log(`  Adapters: ${adapterLines.join(", ")}`);

    if (resolved.status_notify?.tool) {
      console.log(`  Notifier: ${resolved.status_notify.tool}${resolved.status_notify.target ? ` → ${resolved.status_notify.target}` : ""}`);
    }

    // Read from metadata rather than the resolved config: an installation
    // claim is webhook routing, not session configuration, so it never became
    // a resolved field.
    const githubInstallationId = identity.metadata.github?.installationId;
    if (githubInstallationId) {
      console.log(`  GitHub installation: ${githubInstallationId}`);
    }

    if (resolved.vault) {
      console.log(`  Vault: ${resolved.vault}`);
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Test a barry (validate it exists)
 */
export async function testIdentityCommand(name: string): Promise<void> {
  try {
    await requireIdentity(name);
    console.log(`Barry '${name}' exists and is valid.`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/** Compare authored secret names with the runtime cache without mutating either. */
export function diffSecretNames(
  diskKeys: string[],
  dbKeys: string[],
): { missingAtRuntime: string[]; runtimeOnly: string[] } {
  const db = new Set(dbKeys);
  const disk = new Set(diskKeys);
  return {
    // In config, absent from the row sessions read: reported as an error,
    // because this command would otherwise vouch for a key no session gets.
    missingAtRuntime: diskKeys.filter((k) => !db.has(k)),
    // Present at runtime but not in config: works, but invisible here.
    runtimeOnly: dbKeys.filter((k) => !disk.has(k)),
  };
}

/** Sort object keys so YAML and database serialization order cannot create false drift. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function diffSecretBindings(
  disk: SecretBindings,
  db: SecretBindings,
): string[] {
  const shared = Object.keys(disk).filter((k) => k in db);
  return shared.filter((k) => stableStringify(disk[k]) !== stableStringify(db[k]));
}

async function reportSecretCacheDrift(
  identity: Pick<IdentityRecord, "id" | "name">,
  diskEnv: SecretBindings,
): Promise<void> {
  // By the id `identityRecords.find` resolved: a directory identity's record carries
  // its row's id whenever it has a row (pinned or found by name), and a hash of
  // its name, which names no row, when it has none.
  let dbRow;
  try {
    dbRow = await identityRecords.row(identity.id);
  } catch {
    return; // DB unavailable — the rest of the check is still useful.
  }
  if (!dbRow || dbRow.name !== identity.name) return; // No cache row yet; nothing to diverge from.

  const dbEnv = identityRecords.config(dbRow).secrets;
  const { missingAtRuntime, runtimeOnly } = diffSecretNames(Object.keys(diskEnv), Object.keys(dbEnv));
  const changed = diffSecretBindings(diskEnv, dbEnv);
  if (missingAtRuntime.length === 0 && runtimeOnly.length === 0 && changed.length === 0) return;

  console.log("");
  if (missingAtRuntime.length > 0) {
    // The dangerous direction: this command says configured, sessions get nothing.
    console.error(
      `  ✗ In config but NOT in the database — sessions will NOT see ${missingAtRuntime.length === 1 ? "it" : "them"}: ${missingAtRuntime.join(", ")}`,
    );
  }
  if (runtimeOnly.length > 0) {
    console.log(`  · In the database but not in config — sessions DO see these: ${runtimeOnly.join(", ")}`);
  }
  if (changed.length > 0) {
    // Present on both sides with a different reference — invisible to the two
    // checks above, which only ever compare key NAMES. A --source change (e.g.
    // keychain -> vault) on an existing key is exactly this shape: the runtime
    // resolves whichever the DB row says, so a stale disk copy is misleading
    // rather than merely incomplete.
    console.error(
      `  ✗ Secret bindings differ between authored configuration and runtime cache: ${changed.join(", ")}`,
    );
  }
  console.log("    Run barry doctor --fix to refresh the file-owned runtime cache.");
}

/** Check declared credential references without displaying their values. */
export async function checkIdentityCommand(name: string): Promise<void> {
  try {
    const { identity } = await requireIdentity(name);
    const resolved = identityRecords.config(identity);
    const entries = Object.entries(resolved.secrets);
    console.log(`\nIdentity: ${identity.name}`);
    console.log(`Secrets: ${entries.length} reference${entries.length === 1 ? "" : "s"} configured`);
    await reportSecretCacheDrift(identity, resolved.secrets);

    const needsVault = entries.some(([, binding]) => binding.reference.in === "vault");
    let vault: VaultSession | undefined;
    let vaultUnavailable = false;
    const values: Record<string, string> = {};
    try {
      if (needsVault) {
        if (typeof resolved.vault !== "string" || !resolved.vault) {
          vaultUnavailable = true;
          console.error("  Vault: missing named vault selection");
        } else {
          try { vault = await openVault(resolved.vault); }
          catch {
            vaultUnavailable = true;
            console.error("  Vault: could not open the declared vault");
          }
        }
      }
      for (const [secretName, binding] of entries) {
        const reference = binding.reference;
        const label = reference.in === ".env" ? ".env" : `${reference.in}:${reference.item}`;
        if (reference.in === "vault" && vaultUnavailable) {
          console.error(`  ${secretName}: MISSING (${label})`);
          continue;
        }
        try {
          const environment = await identityEnvironment(resolved, { names: [secretName], vault });
          values[secretName] = environment.vars[secretName]!;
          console.log(`  ${secretName}: available (${label})`);
        } catch {
          console.error(`  ${secretName}: MISSING (${label})`);
        }
      }
    } finally { await vault?.close(); }

    const bagNames = await expandCompositionFromSnapshot(resolved.bags);
    const bags = await loadBags(bagNames);
    const merged = mergeBags(bags);
    const tools = (await Promise.all(bags.map(async (bag) => {
      const definitions = await loadBagToolDefinitions(bag) ?? [];
      return applyToolVisibility(definitions, bag.manifest?.toolVisibility ?? {}, resolved.bag_configs[bag.name]?.tools ?? {});
    }))).flat();
    const requirements: Array<{ name: string; secrets: readonly string[] }> = [
      ...tools.map((tool) => ({ name: `${tool.namespace}.${tool.name}`, secrets: tool.secrets ?? [] })),
      ...Object.entries(merged.mcpServers).map(([serverName, server]) => ({ name: serverName, secrets: server.env ?? [] })),
    ];
    for (const requirement of requirements) {
      const missing = requirement.secrets.filter((secretName) => !values[secretName]);
      if (missing.length) console.error(`  ${requirement.name}: missing ${missing.join(", ")}`);
    }
    console.log("");
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Delete a barry
 */
export async function deleteIdentityCommand(name: string): Promise<void> {
  try {
    const { identity, dir } = await requireIdentity(name);

    // Read the alias list before the identity goes away — afterwards there is
    // nothing left to tell us which commands belonged to this identity.
    const aliases = Array.isArray(identity.metadata?.aliases)
      ? (identity.metadata.aliases as unknown[]).filter((a): a is string => typeof a === "string")
      : [];

    // Sessions go with the identity: the sessions store holds no foreign key
    // to cascade, so removing it removes them first. The removal also moves
    // the default on when it named this identity (oldest remaining first),
    // since a pointer left dangling would fail every unqualified command.
    const removed = await Barry.identity(identity.name).remove();
    console.log(
      `Deleted identity '${name}'`
        + (removed.sessionsDeleted > 0 ? ` and ${removed.sessionsDeleted} session(s)` : ""),
    );
    if (removed.directory === "moved") {
      console.log(`Moved its directory aside: ${removed.movedTo}`);
    } else if (removed.directory === "unregistered") {
      console.log(`Unregistered its directory${dir ? ` (${dir})` : ""}; the files are left on disk.`);
    }

    // Otherwise `bgoode` stays on PATH and fails on every invocation.
    removeIdentityCommands(shimNamesFor(identity.name, aliases));

    if (removed.nextDefault === null) {
      console.log("No identities remain — cleared the active barry.");
    } else if (removed.nextDefault !== undefined) {
      console.log(`Active barry was '${name}' — now '${removed.nextDefault}'.`);
    }
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Take an identity's commands off PATH.
 *
 * Only files carrying our marker are removed, so a binary that merely shares a
 * name with a deleted identity survives.
 */
function removeIdentityCommands(names: string[]): void {
  const binDir = getShimDir();
  if (!binDir) return;

  const removed = names.filter((n) => removeShim(n, binDir));
  if (removed.length > 0) {
    console.log(`Removed command${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`);
  }
}

/**
 * Add default traits to a barry — merged into every session using this
 * barry. Additive: existing traits are preserved.
 */
export async function addIdentityTraitsCommand(
  traitNames: string[],
  options: { name?: string } = {},
): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);

    const existing = (await Barry.identity(identity.name).get()).traits;
    const merged = [...new Set([...existing, ...traitNames])];
    printWarnings((await Barry.identity(identity.name).update({ traits: merged })).warnings);
    console.log(`Traits on identity '${identity.name}': ${merged.join(", ")}`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Remove default traits from a barry. Other traits are preserved.
 */
export async function removeIdentityTraitsCommand(
  traitNames: string[],
  options: { name?: string } = {},
): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);

    const existing = (await Barry.identity(identity.name).get()).traits;
    const notPresent = traitNames.filter((t) => !existing.includes(t));
    if (notPresent.length > 0) {
      console.warn(`Not on barry (skipped): ${notPresent.join(", ")}`);
    }

    const remaining = existing.filter((t: string) => !traitNames.includes(t));
    printWarnings((await Barry.identity(identity.name).update({ traits: remaining.length > 0 ? remaining : null })).warnings);
    console.log(
      remaining.length > 0
        ? `Traits on identity '${identity.name}': ${remaining.join(", ")}`
        : `Barry '${identity.name}' has no default traits.`,
    );
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

export async function addIdentityBoundsCommand(names: string[], options: { name?: string } = {}): Promise<void> {
  const { identity } = await requireIdentity(options.name);
  const current = (await Barry.identity(identity.name).get()).bounds;
  printWarnings((await Barry.identity(identity.name).update({ bounds: [...new Set([...current, ...names])] })).warnings);
}

export async function removeIdentityBoundsCommand(names: string[], options: { name?: string } = {}): Promise<void> {
  const { identity } = await requireIdentity(options.name);
  const current = (await Barry.identity(identity.name).get()).bounds;
  printWarnings((await Barry.identity(identity.name).update({ bounds: current.filter(name => !names.includes(name)) })).warnings);
}

/**
 * Clear default traits from a barry.
 */
export async function clearIdentityTraitsCommand(options: { name?: string } = {}): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);
    printWarnings((await Barry.identity(identity.name).update({ traits: null })).warnings);
    console.log(`Cleared traits from identity '${identity.name}'`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Clear default scope from a barry.
 */
export async function clearIdentityBoundsCommand(options: { name?: string } = {}): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);
    printWarnings((await Barry.identity(identity.name).update({ bounds: null })).warnings);
    console.log(`Cleared scope from identity '${identity.name}'`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/** A harness's installed record by id or former id, for what it offers; undefined when none is installed. */
async function harnessRecord(id: string): Promise<InstalledAdapter | undefined> {
  const { adapterStore } = await import("../adapters/installed.js");
  const { findInstalled } = await import("@barry-rocks/sdk/adapters/harnesses");
  return findInstalled((await adapterStore()).adapters.installed(), id);
}

export interface IdentityAdapterOptions {
  name?: string;
  model?: string;
  provider?: string;
  mode?: string;
  default?: boolean;
}

/** Configure the settings belonging to one installed harness. */
export async function setIdentityAdapterCommand(harness: string, options: IdentityAdapterOptions = {}): Promise<void> {
  try {
    const record = await harnessRecord(harness);
    if (!record) throw new Error(`'${harness}' is not an installed adapter. See barry adapter list.`);
    const mode = options.mode ? resolveLaunchMode(record, options.mode) : undefined;
    if (mode && isRefusal(mode)) throw new Error(mode.message);
    if (options.provider && !options.model) throw new Error("--provider requires --model");
    const vendors = installedModels().vendors();
    if (options.provider && !vendors.some(vendor => vendor.id === options.provider && (vendor.compatible?.length ?? 0) > 0)) throw new Error(`Unknown model provider '${options.provider}'`);
    if (options.model && !isOfferedModel(record, vendors, options.model)) {
      const suggestions = suggestOfferedModels(record, vendors, options.model);
      console.warn(`Warning: '${options.model}' is not in the curated catalog${suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : ""}`);
      console.warn(`Known ${record.id} models: ${offeredModels(record, vendors).map(model => model.id).join(", ")}`);
    }
    const { identity } = await requireIdentity(options.name);
    const current = identity.metadata.adapters ?? {};
    let adapters = mergeAdapters({}, current);
    if (!Object.keys(current).length && !options.default) {
      adapters[FALLBACK_HARNESS] = { default: true };
      console.log(`Default stays ${FALLBACK_HARNESS}.`);
    }
    const previousDefault = options.default ? undefined : defaultHarness(adapters);
    adapters = mergeAdapters(adapters, { [record.id]: {
      ...(options.default ? { default: true } : {}),
      ...(options.model ? { model: modelRefToStore(options.model, options.provider, record, vendors) } : {}),
      ...(mode && !isRefusal(mode) ? { mode: mode.mode } : {}),
    } });
    if (previousDefault && Object.keys(adapters).length > 1 && !Object.values(adapters).some(entry => entry.default)) adapters[previousDefault] = { ...adapters[previousDefault], default: true };
    printWarnings((await Barry.identity(identity.name).update({ adapters })).warnings);
    console.log(`Set adapters.${record.id} on identity '${identity.name}'`);
  } catch (error) {
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/** Only an identity's own entry can be removed. */
export async function removeIdentityAdapterCommand(harness: string, options: { name?: string } = {}): Promise<void> {
  try {
    const record = await harnessRecord(harness);
    const id = record?.id ?? harness;
    const { identity } = await requireIdentity(options.name);
    const adapters = mergeAdapters({}, identity.metadata.adapters ?? {});
    const parentName = identity.metadata.inherits;
    if (parentName) {
      const { record: parent } = await identityRecords.find(parentName);
      if (parent.metadata.adapters?.[id]) throw new Error(`adapters.${id} is inherited from ${parentName}; edit that identity instead.`);
    }
    if (!(id in adapters)) throw new Error(`Identity '${identity.name}' has no adapters.${id} entry.`);
    if (Object.keys(adapters).length > 1 && defaultHarness(adapters) === id) throw new Error(`Cannot remove the default ${id}. Set another default first with barry identity adapters set <harness> --default.`);
    delete adapters[id];
    printWarnings((await Barry.identity(identity.name).update({ adapters })).warnings);
    console.log(`Removed adapters.${id} from identity '${identity.name}'`);
  } catch (error) {
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * The ref an identity stores for a model, so nothing has to pair it with a
 * separate provider key again. Undefined where no vendor can be named — a
 * harness that connects itself (opencode) takes the id as given.
 */
function modelRefToStore(
  model: string,
  provider: string | undefined,
  record: InstalledAdapter | undefined,
  vendors: readonly Vendor[],
): string {
  if (parseModelRef(model) && vendors.some((vendor) => vendor.id === parseModelRef(model)?.vendor)) return model;
  const vendor = provider ?? (record ? routedVendorOf(record, model, vendors)?.id : undefined) ?? record?.vendor;
  return vendor ? modelRef(vendor, model) : model;
}

/**
 * Set the default event notifier for a barry: which tool the record_event
 * tool should hand off to, plus an optional target (Slack channel, phone
 * number, …). Sessions inherit this unless overridden per call.
 */
export async function setIdentityNotifierCommand(
  tool: string,
  options: { target?: string; name?: string } = {},
): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);
    const value = options.target ? { tool, target: options.target } : { tool };
    printWarnings((await Barry.identity(identity.name).update({ statusNotify: value })).warnings);
    console.log(
      `Set status notifier on identity '${identity.name}': ${tool}${options.target ? ` → ${options.target}` : ""}`,
    );
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Clear the status-update notifier from a barry.
 */
export async function clearIdentityNotifierCommand(options: { name?: string } = {}): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);
    printWarnings((await Barry.identity(identity.name).update({ statusNotify: null })).warnings);
    console.log(`Cleared status notifier from identity '${identity.name}'`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Claim a GitHub App installation for a barry.
 *
 * The webhook receiver is one shared process: an incoming event carries an
 * installation id, and this is what maps that id back to the barry whose
 * credentials answer for it and whose session replies.
 */
export async function setIdentityGitHubInstallationCommand(
  installationId: string,
  options: { name?: string } = {},
): Promise<void> {
  try {
    const id = Number(installationId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new CliError(`Error: installation id must be a positive integer (got '${installationId}')`, 1);
    }

    const { identity } = await requireIdentity(options.name);

    // Claiming an installation another barry already holds is the config error
    // `byGitHubInstallation` has to break a tie for. Say so at the point
    // it can still be reconsidered rather than leaving it to a webhook log.
    const existing = await identityRecords.byGitHubInstallation(id);
    if (existing && existing.id !== identity.id) {
      console.warn(
        `Warning: identity '${existing.name}' already claims installation ${id}. ` +
          `The lower-id barry answers its webhooks.`,
      );
    }

    printWarnings((await Barry.identity(identity.name).update({ githubInstallationId: id })).warnings);
    console.log(`Barry '${identity.name}' now answers for GitHub installation ${id}`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

/**
 * Release a barry's claim on a GitHub App installation. Its webhooks fall back
 * to the process env credentials and the active barry.
 */
export async function clearIdentityGitHubInstallationCommand(
  options: { name?: string } = {},
): Promise<void> {
  try {
    const { identity } = await requireIdentity(options.name);
    printWarnings((await Barry.identity(identity.name).update({ githubInstallationId: null })).warnings);
    console.log(`Barry '${identity.name}' no longer claims a GitHub installation`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffDay > 0) {
    return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;
  }
  if (diffHour > 0) {
    return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
  }
  if (diffMin > 0) {
    return `${diffMin} minute${diffMin > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return "(unset)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Report Identities whose database row disagrees with their `identity.yaml`,
 * and whose command never reached PATH.
 *
 * A Barry can live in both stores at once. The directory wins on read, so a
 * stale row stays invisible until something resolves by id rather than by name
 * — which is how a Barry ran for weeks on a model its yaml never named.
 *
 * The two checks are the same shape: something recorded in the identity is
 * missing from where it does its work. A command is the more forgiving half —
 * a drifted row is invisible, and a missing command at least fails loudly.
 */
export async function barryDoctorCommand(options: { fix?: boolean }): Promise<void> {
  const user = await getCurrentUser();
  await reportIdentityProblems(Boolean(options.fix));
  await reportBoundProblems(Boolean(options.fix));
  const rows = await identityRows();

  const drifted: Array<{
    id: number;
    name: string;
    diffs: Array<{ field: string; file: unknown; db: unknown }>;
  }> = [];

  for (const row of rows) {
    const diffs = identityRecords.drift(row, user.id);
    if (diffs.length > 0) drifted.push({ id: row.id, name: row.name, diffs });
  }

  // Model ids are deliberately never rejected on write, so an id that has aged
  // out of the catalog is only ever visible if something looks for it.
  // doctor runs at system scope, where the preAction hook does not install
  // models — install here, and only when there are rows to check.
  const staleModels: string[] = [];
  if (rows.length > 0) {
    const { ensureModelsInstalled } = await import("../lib/models-install.js");
    await ensureModelsInstalled();
  }
  const vendors = rows.length > 0 ? installedModels().vendors() : [];
  for (const row of rows) {
    for (const [harness, entry] of Object.entries(row.metadata.adapters ?? {})) {
      if (!entry.model) continue;
      const record = await harnessRecord(harness);
      if (!record || isOfferedModel(record, vendors, entry.model)) continue;
      const suggestions = suggestOfferedModels(record, vendors, entry.model);
      staleModels.push(`${row.name}: "${entry.model}" is not in the ${harness} catalog` + (suggestions.length ? ` — did you mean ${suggestions.join(", ")}?` : ""));
    }
  }

  if (staleModels.length > 0) {
    console.log("\nOff-catalog models (accepted on write, never validated):");
    for (const line of staleModels) console.log(`  ${line}`);
  }

  const bounded = await Promise.all(rows.map(async row => {
    const { bound } = await Barry.identity(row.id).grants({ defaults: false, identityTraits: false });
    return { name: row.name, bound: bound ? { ...bound, name: requiredNames(identityRecords.config(row).bounds).join(", ") } : null };
  }));
  const shelless = traits.shelless(bounded);

  if (shelless.length > 0) {
    console.log("\nIdentities whose default bound leaves every session with no shell:");
    for (const { identity } of shelless) {
      console.log(`  ${identity}: default bound "" denies Bash (native Bash is always denied)`);
    }
    console.log("  Intentional? Prefer `barry --bound <name>` per session.");
    console.log("  Otherwise clear it: barry identity bounds remove <name> --name <identity>");
  }

  await reportServiceDrift();
  const { reportRetiredNodeState } = await import("./doctor-nodes.js");
  await reportRetiredNodeState(options.fix === true);

  const missingCommands = await checkIdentityCommands(options.fix === true);
  const commandsChecked = missingCommands !== null;

  if (drifted.length === 0 && commandsChecked && missingCommands.length === 0) {
    console.log(
      staleModels.length > 0
        ? "\nNo drift — every Barry's database row matches its barry.yaml."
        : "No drift — every Barry's database row matches its barry.yaml.",
    );
    return;
  }

  if (drifted.length === 0) return;

  for (const barry of drifted) {
    console.log(`\n${barry.name} (db id ${barry.id})`);
    for (const { field, file, db } of barry.diffs) {
      console.log(`  ${field}: yaml=${describeValue(file)} db=${describeValue(db)}`);
    }
  }

  const count = drifted.reduce((n, b) => n + b.diffs.length, 0);
  if (!options.fix) {
    console.log(
      `\n${count} drifted field${count === 1 ? "" : "s"}. Re-run with --fix to overwrite the row from barry.yaml.`,
    );
    return;
  }

  for (const barry of drifted) {
    // File -> row is exactly what the sync does. Field-by-field row writes are
    // refused for file-owned fields now, and would duplicate the sync anyway.
    const dir = identityRecords.directory({ name: barry.name });
    if (!dir) continue;
    try {
      await identityRecords.sync(dir, { actorId: user.id });
    } catch (err) {
      // An identity.yaml that cannot be read cannot repair its row; the rest
      // still can.
      console.log(`\nCould not repair "${barry.name}": ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`\nRepaired "${barry.name}" from identity.yaml: ${barry.diffs.map((d) => d.field).join(", ")}`);
  }
}

/**
 * The owner's identity rows, which is what drift compares with each file: a
 * row-only identity's row, and the cached row of each directory identity that
 * has one. `identityRecords.find` finds a directory's row (pinned in its file, or by
 * name) and hands back its id; an unreadable directory is not listed, and its
 * row comes back as a row-only identity, which drift then reports unreadable.
 */
async function identityRows(): Promise<IdentityRecord[]> {
  const rows: IdentityRecord[] = [];
  for (const entry of await identityRecords.list()) {
    if (entry.source === "db") {
      rows.push(entry.record);
      continue;
    }
    const found = await identityRecords.find(entry.record.name).catch(() => undefined);
    const row = found ? await identityRecords.row(found.record.id) : undefined;
    if (row) rows.push(row);
  }
  return rows;
}

// Report manifest-to-service drift explicitly because an unprepared service can otherwise disappear silently.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-006
async function reportServiceDrift(): Promise<void> {
  let drift: Awaited<ReturnType<typeof import("../services/barry.js").serviceDrift>>;
  try {
    const { serviceDrift } = await import("../services/barry.js");
    drift = await serviceDrift();
  } catch (err) {
    console.log(`\nServices: not checked — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const { unprepared, unregistered, retained } = drift;
  if (unprepared.length === 0 && unregistered.length === 0 && retained.length === 0) {
    console.log("\nServices: every declared service is prepared and registered.");
    return;
  }
  if (unprepared.length > 0) {
    console.log("\nServices a bag declares that are not prepared, so they cannot start:");
    for (const key of unprepared) console.log(`  ${key}`);
    console.log("  Prepare them: barry service add <name> (one add refreshes every declaration)");
  }
  if (unregistered.length > 0) {
    console.log("\nServices prepared but never registered with launchd:");
    for (const key of unregistered) console.log(`  ${key}`);
    console.log("  Register each: barry service add <name>");
  }
  if (retained.length > 0) {
    console.log("\nServices kept from an earlier preparation because their bag's manifest cannot be read:");
    for (const key of retained) console.log(`  ${key}`);
    console.log("  Fix the manifest: barry bag doctor");
  }
}

/**
 * Identities whose command is missing from PATH — and, with `fix`, the repair.
 *
 * `<name> list` only works because a shim exports `BARRY_IDENTITY` for that
 * identity, and historically only `barry heir` wrote one. So an identity that
 * predates the feature, arrived through the API, or gained an alias by hand
 * edit had no command and no way to find out except the shell's "command not
 * found". This is the check that looks.
 *
 * Returns null when there was nothing to check — barry is not installed on
 * PATH, so there is no directory to inspect. That is NOT the same as "clean",
 * and the caller must not print an all-clear over it.
 */
async function checkIdentityCommands(fix: boolean): Promise<ShimSpec[] | null> {
  const owned = await collectIdentities();
  const missing = findMissingCommands(owned);

  if (missing === null) {
    console.log("\nIdentity commands: not checked — barry is not installed on PATH.");
    return null;
  }

  if (missing.length === 0) return [];

  console.log("\nIdentities whose command is missing from PATH:");
  for (const { command, identity } of missing) {
    console.log(`  ${command} → would run barry as ${identity}`);
  }

  if (!fix) {
    console.log("  Re-run with --fix to install them.");
    return missing;
  }

  for (const line of describeReconcile(reconcileCommands(owned))) console.log(line);

  // Re-read rather than trusting the write: a name refused (a builtin, or
  // somebody's binary) is still missing, and reporting a clean bill here is the
  // exact failure this function exists to catch.
  return findMissingCommands(owned) ?? [];
}
