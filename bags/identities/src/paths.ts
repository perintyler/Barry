/** Current and pre-rename locations for file-backed identities. */

import { dirname, join } from "path";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { builtinBagsDir } from "@barry-rocks/sdk/internal/bags";

/**
 * Directory of the canonical base identity, if present: the repository root,
 * whose `identity.yaml` packs the builtin bags beside it in `bags/`.
 */
export function getBuiltinIdentityDir(): string | null {
  const bags = builtinBagsDir();
  return bags ? dirname(bags) : null;
}

/**
 * Where file-backed identities are recorded: installation state, beside the
 * bag registry, and moved with BARRY_HOME like the rest of an instance.
 */
function identityStorageRoot(): string {
  return barryAppSupportDir();
}

/** A path in the identity store's existing on-disk layout. */
function identityStoragePath(...segments: string[]): string {
  return join(identityStorageRoot(), ...segments);
}

/**
 * File-based identity directories (`<app support>/identities`). Each
 * subdirectory contains an `identity.yaml`.
 *
 */
export function getIdentitiesDir(): string {
  return identityStoragePath("identities");
}

/** Resolve the directory path for a named identity. */
export function getIdentityDir(name: string): string {
  return join(getIdentitiesDir(), name);
}

/**
 * What identities were called before the rename. A constant so the old word
 * appears once here rather than scattered through path literals that would
 * otherwise read like leftovers.
 */
const LEGACY_IDENTITIES_DIRNAME = "barrys";

/**
 * Pre-rename identity directory (LEGACY_IDENTITIES_DIRNAME), still read when
 * the preferred path is absent so existing installs keep working without a
 * migration step.
 */
export function getLegacyIdentitiesDir(): string {
  return identityStoragePath(LEGACY_IDENTITIES_DIRNAME);
}

/**
 * Registry of identity directories living outside the well-known one
 * (`<app support>/identities.yaml`).
 *
 * `barry heir` creates an identity in the current directory, so the well-known
 * directory is no longer the only place one can be. This maps name → path the
 * same way `repos.yaml` does, and discovery reads both sources.
 */
export function getIdentitiesRegistryPath(): string {
  return identityStoragePath("identities.yaml");
}

/** Pre-rename registry (LEGACY_IDENTITIES_DIRNAME + `.yaml`), read when the new one is absent. */
export function getLegacyIdentitiesRegistryPath(): string {
  return identityStoragePath(`${LEGACY_IDENTITIES_DIRNAME}.yaml`);
}
