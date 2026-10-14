/** Store and verify a secret before returning its credential reference. */

import { KeychainProvider } from "@barry-rocks/sdk/internal/env";
import type { SecretReference } from "@barry-rocks/sdk/internal/identities";
import type { VaultSession, VaultAccount } from "@barry-rocks/sdk/internal/vault";

/**
 * A vault already logged into. Callers open it once, not once per secret.
 */
export interface OpenVault {
  vault: VaultSession;
}

export async function storeVaultSecret(
  { vault }: OpenVault,
  target: { vaultAccount: VaultAccount; identityName: string; force?: boolean },
  key: string,
  value: string,
): Promise<SecretReference> {
  const existing = (await vault.searchItems(key)).find((item) => item.name === key);
  const { guardSharedOverwrite } = await import("./vault-sharing.js");
  await guardSharedOverwrite({
    vaultAccount: target.vaultAccount,
    identityName: target.identityName,
    key,
    isOverwrite: Boolean(existing),
    force: target.force,
  });
  await vault.putItem(key, { password: value });

  const stored = await vault.getItem(key);
  if (stored.password !== value) throw new Error(`Vault verification failed for ${key}`);
  return { in: "vault", item: key, field: "password" };
}

/** The Keychain account an identity's secret is filed under. */
export function identityKeychainAccount(identityName: string, key: string): string {
  return `${identityName}-${key.toLowerCase().replace(/_/g, "-")}`;
}

export async function storeKeychainSecret(
  identityName: string,
  key: string,
  value: string,
  service = "barry",
): Promise<SecretReference> {
  const keychain = new KeychainProvider({ service });
  const account = identityKeychainAccount(identityName, key);
  await keychain.set(account, value);
  if ((await keychain.get("", account)) !== value) throw new Error(`Keychain verification failed for ${key}`);
  return { in: "keychain", item: service, account };
}
