export * from "./types.js";
export {
  getEnvironmentVariable,
  environmentVariableNames,
  type EnvScope,
} from "./variables.js";
export { readEnvironment, readVaultField, type ReadEnvironmentOptions } from "./read.js";

export { exposedEnv } from "./exposed.js";
export {
  assertSessionCredentials,
  sessionEnvironment,
  requiredCredentials,
  declaredCredentialEnvs,
  CredentialNotResolved,
  type RoutedVendor,
  type HarnessCredentialsInput,
  type VendorCredential,
} from "./gate.js";
export { maskSecret } from "./mask.js";
export { KeychainProvider } from "./providers/keychain.js";
export type { KeychainConfig } from "./providers/keychain.js";

export { readSecretBindings, type SecretBindingReaders } from "./secret-bindings.js";
export * from "./identity.js";
export * from "./credential-check.js";
