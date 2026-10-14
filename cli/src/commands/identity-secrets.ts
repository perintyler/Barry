import { Barry } from "@barry-rocks/sdk";
import { identityRecords, type IdentityRecord } from "@barry-rocks/identities-bag";
import { bindSecretReferences, mergeSecretBindings, SecretReferenceSchema, type SecretBindings } from "@barry-rocks/sdk/internal/identities";
import { identityEnvironment, maskSecret } from "@barry-rocks/sdk/internal/env";
import { openVault, vaultAccountFor, type VaultSession } from "@barry-rocks/sdk/internal/vault";
import { storeKeychainSecret, storeVaultSecret } from "../lib/identity-secret-store.js";
import { printWarnings } from "../lib/warnings.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";

async function getIdentity(name?: string): Promise<IdentityRecord> {
  const { requireIdentity } = await import("./identity.js");
  return (await requireIdentity(name)).identity;
}


/**
 * The secret references this identity declares itself, not the ones it
 * inherits: read from its own identity.yaml (or the pre-rename barry.yaml),
 * since that is the file a write replaces them in.
 */
async function bindings(identity: IdentityRecord): Promise<SecretBindings> {
  const directory = identityRecords.directory({ name: identity.name });
  if (!directory) return mergeSecretBindings({}, identity.metadata.secrets);
  const path = ["identity.yaml", "barry.yaml"].map((file) => join(directory, file)).find((file) => existsSync(file));
  if (!path) throw new Error(`No identity.yaml found for "${identity.name}"`);
  const authored = parseYaml(readFileSync(path, "utf-8"));
  return bindSecretReferences(authored?.secrets, directory);
}

async function saveBindings(identity: IdentityRecord, secrets: SecretBindings): Promise<void> {
  const references = Object.fromEntries(Object.entries(secrets).map(([name, binding]) => [name, binding.reference]));
  printWarnings((await Barry.identity(identity.name).update({ secrets: references })).warnings);
}

type WriteOptions = { source?: string; name?: string; force?: boolean };

async function storeSecrets(identity: IdentityRecord, entries: Record<string, string>, options: WriteOptions): Promise<void> {
  if (options.source !== "keychain" && options.source !== "vault") throw new Error("--in must be vault or keychain");
  // Validate all names before changing the external secret store.
  for (const [name, value] of Object.entries(entries)) {
    mergeSecretBindings({}, { [name]: { reference: { in: "keychain", item: "barry" } } });
    if (!value) throw new Error(`${name}: secret value must not be empty`);
  }
  const secrets = await bindings(identity);
  const ref = identity.metadata.vault;
  let vault: VaultSession | undefined;
  try {
    if (options.source === "vault") {
      if (typeof ref !== "string" || !ref) throw new Error(`Identity "${identity.name}" requires a named vault`);
      try { vault = await openVault(ref); }
      catch { throw new Error("Could not open the declared vault"); }
    }
    for (const [key, value] of Object.entries(entries)) {
      const reference = vault && ref
        ? await storeVaultSecret({ vault }, { vaultAccount: vaultAccountFor(ref), identityName: identity.name, force: options.force }, key, value)
        : await storeKeychainSecret(identity.name, key, value);
      secrets[key] = { reference: SecretReferenceSchema.parse(reference) };
    }
    await saveBindings(identity, secrets);
  } finally { await vault?.close(); }
}

export async function identitySecretSetCommand(key: string, value: string | undefined, options: WriteOptions = {}): Promise<void> {
  const identity = await getIdentity(options.name);
  // The secret never comes from argv (ps, shell history). When omitted it is
  // read from a masked prompt on a TTY or stdin when piped — the same path
  // `barry env set` and `vault add` use.
  const { readSecretValue } = await import("../lib/read-secret.js");
  const resolved = value ?? (await readSecretValue(key));
  await storeSecrets(identity, { [key]: resolved }, options);
  console.log(`Set ${key} for identity "${identity.name}" (stored in ${options.source})`);
}

export async function identitySecretGetCommand(key: string, options: { name?: string } = {}): Promise<void> {
  const identity = await getIdentity(options.name);
  const resolved = identityRecords.config(identity);
  let vault: VaultSession | undefined;
  try {
    if (resolved.secrets[key]?.reference.in === "vault") {
      if (typeof resolved.vault !== "string" || !resolved.vault) throw new Error(`${key}: requires a named vault`);
      try { vault = await openVault(resolved.vault); }
      catch { throw new Error(`${key}: could not open the declared vault`); }
    }
    const environment = await identityEnvironment(resolved, { names: [key], vault });
    console.log(`${key}=${maskSecret(environment.vars[key])}`);
  } finally { await vault?.close(); }
}

export async function identitySecretListCommand(options: { name?: string } = {}): Promise<void> {
  const identity = await getIdentity(options.name);
  const secrets = identityRecords.config(identity).secrets;
  console.log(`Secret references for identity "${identity.name}":`);
  for (const [key, binding] of Object.entries(secrets)) {
    const ref = binding.reference;
    console.log(`  ${key}  (${ref.in}${"item" in ref ? `:${ref.item}` : ""})`);
  }
}

export async function identitySecretImportCommand(path: string, options: WriteOptions = {}): Promise<void> {
  const identity = await getIdentity(options.name);
  const entries = Object.fromEntries(Object.entries(parseEnv(readFileSync(path, "utf-8"))).filter(([, value]) => value !== ""));
  await storeSecrets(identity, entries, options);
  console.log(`Imported ${Object.keys(entries).length} secrets for identity "${identity.name}"`);
}

export async function identitySecretRemoveCommand(key: string, options: { name?: string } = {}): Promise<void> {
  const identity = await getIdentity(options.name);
  const secrets = await bindings(identity);
  if (!Object.hasOwn(secrets, key)) throw new Error(`${key}: no locally declared secret reference; inherited references must be edited in their declaring identity`);
  delete secrets[key];
  await saveBindings(identity, secrets);
  console.log(`Removed ${key} reference from identity "${identity.name}"; stored secret is untouched`);
}
