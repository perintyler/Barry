/**
 * Which definition applies to an env var name.
 *
 * The precedence chain, as a lookup: the identity's own definition wins; the
 * manifest default (a harness bag's or vendor row's) applies when the
 * identity names nothing; no definition anywhere is `undefined`, and the
 * caller that required one refuses.
 */

import type { EnvironmentVariable } from "./types.js";
import { asEnvironmentVariable } from "./types.js";

export interface EnvScope {
  /** The identity's own definitions. Always consulted first. */
  identity: Record<string, unknown>;
  /**
   * Manifest defaults — a harness bag's `credentials:` or a vendor row's —
   * consulted only when the identity names nothing. Loosely typed for the
   * same reason `identity` is: manifests arrive as parsed YAML.
   */
  manifest?: Record<string, unknown>;
}

/**
 * The definition for `name`, after precedence. Throws `EnvDefinitionError`
 * for a definition that does not hold up — a malformed one is config to fix,
 * not an absence to fall back from.
 */
export function getEnvironmentVariable(
  name: string,
  scope: EnvScope,
): EnvironmentVariable | undefined {
  const own = scope.identity[name];
  if (own !== undefined) return asEnvironmentVariable(name, own);
  const fallback = scope.manifest?.[name];
  if (fallback !== undefined) return asEnvironmentVariable(name, fallback);
  return undefined;
}

/** Every name either layer defines, identity first. */
export function environmentVariableNames(scope: EnvScope): string[] {
  const names = new Set<string>();
  for (const name of Object.keys(scope.identity)) names.add(name);
  for (const name of Object.keys(scope.manifest ?? {})) names.add(name);
  return [...names];
}
