/** Open named vaults through one credential-and-login flow, deriving endpoint and salt consistently and throwing when access fails; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */

import { VaultClient, VaultItemNotFoundError } from "./client.js";
import { VaultError } from "./errors.js";
import type { VaultAuth, VaultItem, VaultItemSummary } from "./client.js";
import { assertVaultAccessAllowedUnderTest } from "./test-guard.js";
import { instanceVaultConnection } from "./instance-account.js";

/** Where the vault daemon listens. A machine-level fact, not a per-vault one. */
export const DEFAULT_VAULT_URL =
  process.env.VAULT_URL ?? "unix:///usr/local/var/barry-vault/run/vault.sock";

/** Keychain service every vault account's credentials are filed under. */
export const VAULT_KEYCHAIN_SERVICE = "barry";

export interface VaultAccount {
  email: string;
  serverUrl: string;
  credentials: {
    clientId: { service: string; account: string };
    clientSecret: { service: string; account: string };
    masterPassword: { service: string; account: string };
  };
}

/**
 * A vault reference: a NAME, or the inline connection blob written before
 * vaults were nameable. The blob is accepted unchanged so every already-
 * configured identity keeps working; a name is resolved here.
 */
export type VaultRef =
  | string
  | {
      email?: string;
      serverUrl: string;
      credentials: Record<string, unknown>;
    };

/** Replaces what opening a vault touches on the real machine — tests only. */
export interface VaultOpenOptions {
  readSecret?: (service: string, account: string) => Promise<string | null>;
}

/**
 * A name that names a vault nothing can resolve. Its own class so callers can
 * tell a MISCONFIGURED reference from an unreachable backend: the two want
 * opposite handling, and a config error must not disappear into a catch that
 * shrugs and continues.
 */
export class VaultRefError extends VaultError {
  constructor(message: string) {
    super("config", message);
    this.name = "VaultRefError";
  }
}

/** Legacy Keychain descriptor. Preserve the original name when calling openVault:
 * an installation-owned connection is resolved at opening, not by this descriptor. */
export function vaultAccountFor(ref: unknown): VaultAccount {
  if (typeof ref !== "string") return validateInlineAccount(ref);
  const name = ref.trim();
  if (!name) {
    throw new VaultRefError("`vault` is set but empty — name a vault or remove the key.");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new VaultRefError(`"${name}" is not a usable vault name (letters, digits and dashes only).`);
  }
  return {
    // Read at login from `vault-<name>-email`; see vaultEmail.
    email: "",
    serverUrl: DEFAULT_VAULT_URL,
    credentials: {
      clientId: { service: VAULT_KEYCHAIN_SERVICE, account: `vault-${name}-client-id` },
      clientSecret: { service: VAULT_KEYCHAIN_SERVICE, account: `vault-${name}-client-secret` },
      masterPassword: { service: VAULT_KEYCHAIN_SERVICE, account: `vault-${name}-master-password` },
    },
  };
}

/**
 * The account email a vault logs in as.
 *
 * An inline account carries its own. A named one does not — the name is the
 * whole reference — so the email is read from Keychain beside the credentials.
 *
 * Throws rather than returning a placeholder when a named vault has no stored
 * email: `deriveKeys` salts with it, so a wrong or empty value surfaces as a
 * MAC verification failure deep in the crypto, which reads as a corrupt vault.
 * Naming the missing entry is the difference between a five-second fix and an
 * hour spent doubting the backup.
 */
export async function vaultEmail(account: VaultAccount, read: VaultRead): Promise<string> {
  if (account.email) return account.email;
  const clientId = account.credentials.clientId;
  const emailAccount = clientId.account.replace(/-client-id$/, "-email");
  const email = await read(clientId.service, emailAccount);
  if (!email) {
    throw new VaultRefError(
      `Vault credentials found but no account email (keychain ${clientId.service}/${emailAccount}). ` +
        `Re-run \`barry vault assign\` for this vault, or give the identity an inline vault block with its email.`,
    );
  }
  return email;
}

function validateInlineAccount(value: unknown): VaultAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultRefError("vault must be a name or an inline account object");
  const vault = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof vault.serverUrl !== "string" || !vault.serverUrl) problems.push("serverUrl");
  const creds = (vault.credentials ?? null) as Record<string, unknown> | null;
  for (const key of ["clientId", "clientSecret", "masterPassword"] as const) {
    const ref = creds?.[key] as Record<string, unknown> | undefined;
    if (!ref || typeof ref.service !== "string" || typeof ref.account !== "string") {
      problems.push(`credentials.${key} (needs service and account)`);
    }
  }
  if (problems.length > 0) {
    throw new VaultRefError(
      `The identity's inline \`vault:\` block is missing ${problems.join(", ")}. ` +
        "Name a vault instead (`vault: <name>`, see `barry vault assign`), or complete the block.",
    );
  }
  const reference = (key: string): { service: string; account: string } => {
    const ref = creds?.[key] as Record<string, unknown>;
    if (typeof ref.service !== "string" || typeof ref.account !== "string") throw new VaultRefError(`invalid credential ${key}`);
    return { service: ref.service, account: ref.account };
  };
  if (typeof vault.serverUrl !== "string" || typeof vault.email !== "string") throw new VaultRefError("inline vault must identify serverUrl and email");
  return { email: vault.email, serverUrl: vault.serverUrl, credentials: { clientId: reference("clientId"), clientSecret: reference("clientSecret"), masterPassword: reference("masterPassword") } };
}

type VaultRead = (service: string, account: string) => Promise<string | null>;

function readWith(options: VaultOpenOptions): VaultRead {
  return (
    options.readSecret ??
    // Lazy so this module carries no static edge back into env: env reads
    // vaults, and a cycle here would close one for a default that only the
    // real machine uses.
    (async (service, account) => {
      const { KeychainProvider } = await import("../env/providers/keychain.js");
      return new KeychainProvider({ service }).get("", account);
    })
  );
}

/**
 * The three secrets a vault login needs, naming whichever are absent.
 */
async function readAccountCredentials(
  account: VaultAccount,
  read: VaultRead,
): Promise<{ clientId: string; clientSecret: string; masterPassword: string }> {
  const names = ["clientId", "clientSecret", "masterPassword"] as const;
  const values = await Promise.all(
    names.map((name) => read(account.credentials[name].service, account.credentials[name].account)),
  );
  const [clientId, clientSecret, masterPassword] = values;
  if (!clientId || !clientSecret || !masterPassword) {
    const missing = names.filter((_, i) => !values[i]).join(", ");
    throw new VaultError(
      "credentials-missing",
      `Vault credentials missing from Keychain: ${missing}`,
    );
  }
  return { clientId, clientSecret, masterPassword };
}

/**
 * The session a caller holds: reads and writes items, and nothing about the
 * protocol underneath. Item-absent and transport-failed are distinguishable —
 * `getItem` throws `VaultItemNotFoundError` for the first and `VaultError`
 * for the second — because those are different problems with different fixes,
 * and a null cannot say which one happened.
 */
export interface VaultSession {
  getItem(name: string): Promise<VaultItem>;
  /** Create the item or update it in place — the one write most callers want. */
  putItem(name: string, fields?: Partial<Omit<VaultItem, "id" | "name">>): Promise<void>;
  deleteItem(name: string): Promise<void>;
  listItems(): Promise<VaultItemSummary[]>;
  searchItems(query: string): Promise<VaultItemSummary[]>;
  /** Log out. A session not closed simply expires server-side. */
  close(): Promise<void>;
  readonly email: string;
  readonly serverUrl: string;
}

/**
 * Open a vault and return its session.
 *
 * Throws — `VaultError("credentials-missing")` when the Keychain entries are
 * absent, `VaultRefError` when the reference is malformed, and whatever the
 * client raises when the daemon refuses or cannot be reached. Callers that
 * genuinely degrade without a vault catch these; nothing here pretends the
 * vault opened when it did not.
 */
export async function openVault(ref: unknown, options: VaultOpenOptions = {}): Promise<VaultSession> {
  const account = vaultAccountFor(ref);
  const configured = typeof ref === "string" ? instanceVaultConnection(ref.trim()) : undefined;
  if (configured && options.readSecret) throw new VaultRefError("Configured vault bootstrap cannot be replaced by a caller credential reader.");
  const serverUrl = configured?.serverUrl ?? account.serverUrl;
  const read = configured?.readSecret ?? readWith(options);
  assertVaultAccessAllowedUnderTest("openVault", {
    serverUrl,
    readSecret: configured?.readSecret ?? options.readSecret,
  });
  const credentials = await readAccountCredentials(account, read);
  const email = await vaultEmail(account, read);

  const client = new VaultClient(serverUrl);
  const auth = await client.loginWithApiKey(
    credentials.clientId,
    credentials.clientSecret,
    credentials.masterPassword,
    email,
  );
  return sessionFor(client, auth, email, serverUrl);
}

/** Wrap an open login. Exported for `barry vault` flows that already hold a session. */
export function sessionFor(
  client: VaultClient,
  auth: VaultAuth,
  email: string,
  serverUrl: string,
): VaultSession {
  return {
    async getItem(name: string): Promise<VaultItem> {
      return client.getItem(auth, name);
    },
    async putItem(name, fields = {}) {
      // `null` and absent mean the same thing here — clear the field — which
      // is how the client's update path already treats a falsy value.
      const clean: { username?: string; password?: string; uri?: string; notes?: string } = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value != null) clean[key as "username" | "password" | "uri" | "notes"] = value;
      }
      let item: VaultItem;
      try {
        item = await client.getItem(auth, name);
      } catch (err) {
        if (!(err instanceof VaultItemNotFoundError)) throw err;
        await client.createItem(auth, { name, ...clean });
        return;
      }
      await client.updateItem(auth, item.id, { name, ...clean });
    },
    async deleteItem(name: string): Promise<void> {
      const item = await client.getItem(auth, name); // VaultItemNotFoundError propagates
      await client.deleteItem(auth, item.id);
    },
    listItems: () => client.listItems(auth),
    searchItems: (query: string) => client.searchItems(auth, query),
    close: () => client.logout(auth),
    email,
    serverUrl,
  };
}
