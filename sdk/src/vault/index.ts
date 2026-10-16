export { VaultClient, VaultItemNotFoundError, assertTrustedVaultUrl } from "./client.js";
export { VaultError, isVaultError } from "./errors.js";
export type { VaultErrorKind, VaultErrorOptions } from "./errors.js";
export type { VaultAuth, VaultItem, VaultItemSummary, RegistrationResult, VaultClientOptions } from "./client.js";

export {
  openVault,
  vaultAccountFor,
  vaultEmail,
  sessionFor,
  VaultRefError,
  DEFAULT_VAULT_URL,
  VAULT_KEYCHAIN_SERVICE,
  type VaultSession,
  type VaultRef,
  type VaultAccount,
  type VaultOpenOptions,
} from "./account.js";
export { assertVaultAccessAllowedUnderTest } from "./test-guard.js";
export { configuredVaultEndpoint } from "./instance-account.js";
export * from "./crypto.js";
export * from "./oauth.js";
export * from "./bag-auth-status.js";
