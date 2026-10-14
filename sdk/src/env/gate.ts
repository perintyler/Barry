/**
 * The session gate: every credential a session needs must come from a
 * definition.
 *
 * Two questions, one module. WHICH vars does this session authenticate with
 * — the harness bag's `credentials:` plus, for a model of another vendor,
 * that vendor row's credential. And DID they come from a definition — an
 * entry in the identity's env map or a manifest default, read through
 * `readEnvironment`. Anything else (a value inherited from the shell, a key
 * that appears from nowhere) is stripped from the process env; a required
 * credential with no definition refuses the session, and the refusal names
 * the fix.
 */

import type { Environment } from "./types.js";
import { readEnvironment } from "./read.js";
import { environmentVariableNames } from "./variables.js";
import type { VaultSession } from "../vault/account.js";

/** A vendor row's credential declaration — the shape `Vendor.credential` carries. */
export interface VendorCredential {
  env?: string;
  item?: string;
  placeholder?: string;
}

export interface RoutedVendor {
  id?: string;
  label?: string;
  credential: VendorCredential | null;
}

export interface HarnessCredentialsInput {
  id: string;
  /** The installed record's `bag.manifest.credentials`, loosely typed. */
  credentials?: Record<string, unknown> | undefined;
}

/**
 * The env vars this session authenticates with, and who needs them.
 *
 * Every var a harness manifest declares is required — declaring it says the
 * harness cannot do its job without it. A routed vendor's `env` credential is
 * required when the session runs a model of that vendor; placeholders and
 * `null` are not authentication and are never required.
 */
export function requiredCredentials(input: {
  harness: HarnessCredentialsInput;
  routedVendors?: readonly RoutedVendor[];
}): Array<{ env: string; requiredBy: string }> {
  const required: Array<{ env: string; requiredBy: string }> = [];
  for (const name of Object.keys(input.harness.credentials ?? {})) {
    required.push({ env: name, requiredBy: `harness ${input.harness.id}` });
  }
  for (const vendor of input.routedVendors ?? []) {
    if (vendor.credential && typeof vendor.credential.env === "string") {
      required.push({
        env: vendor.credential.env,
        requiredBy: `vendor ${vendor.label ?? vendor.id ?? "?"} (routed)`,
      });
    }
  }
  return required;
}

/**
 * Read the session's environment: every var the identity defines, plus every
 * var a manifest default could supply for the required credentials.
 */
export async function sessionEnvironment(opts: {
  identity: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  vault?: VaultSession;
  file?: Record<string, string>;
}): Promise<Environment> {
  const names = new Set(environmentVariableNames(opts));
  return readEnvironment([...names], opts);
}

/** A required credential that has no definition, or did not read. */
export class CredentialNotResolved extends Error {
  readonly missing: Array<{ env: string; requiredBy: string; reason: string }>;
  constructor(missing: Array<{ env: string; requiredBy: string; reason: string }>) {
    const lines = missing.map(
      (m) => `  $${m.env} — required by ${m.requiredBy}: ${m.reason}`,
    );
    super(
      "This session cannot start: required credentials are not available from any declared source.\n" +
        lines.join("\n") +
        `\n\nFix — put the key in this identity's vault (preferred):\n` +
        missing.map((m) => `  barry vault set-env ${m.env} <value> --source vault`).join("\n") +
        `\n(or define the variable on the identity: barry identity env set ${missing[0]?.env ?? "VAR"} …)`,
    );
    this.name = "CredentialNotResolved";
    this.missing = missing;
  }
}

/**
 * Enforce the guarantee for one session.
 *
 * - A required credential absent from `env.sources` is a refusal: no
 *   definition anywhere supplied it, so whatever value the process env
 *   carries came from nowhere declared.
 * - Any var in `ambientEnv` that the identity's environment did NOT produce,
 *   but that IS a declared credential somewhere (adapters, vendor rows), is
 *   returned in `strip` — callers delete those from the child env. Ambient
 *   values for declared credentials are exactly the leak this gate exists to
 *   close.
 *
 * Returns the strip list; throws `CredentialNotResolved` naming every
 * missing credential and both fix paths.
 */
export function assertSessionCredentials(input: {
  required: ReadonlyArray<{ env: string; requiredBy: string }>;
  env: Environment;
  ambientEnv: Record<string, string | undefined>;
  credentialEnvs: ReadonlySet<string>;
}): { strip: string[] } {
  const missing: Array<{ env: string; requiredBy: string; reason: string }> = [];
  for (const req of input.required) {
    if (input.env.sources[req.env] === undefined) {
      missing.push({ ...req, reason: "no definition in the identity's env or any manifest default" });
    }
  }
  if (missing.length > 0) throw new CredentialNotResolved(missing);

  const strip: string[] = [];
  for (const name of input.credentialEnvs) {
    if (input.env.sources[name] === undefined && input.ambientEnv[name] !== undefined) {
      strip.push(name);
    }
  }
  return { strip };
}

/**
 * Every credential env var declared anywhere — across vendor rows and
 * harness manifests — the strip denylist.
 */
export function declaredCredentialEnvs(input: {
  vendors?: ReadonlyArray<{ credential: VendorCredential | null }>;
  harnessManifests?: ReadonlyArray<Record<string, unknown> | undefined>;
}): Set<string> {
  const names = new Set<string>();
  for (const vendor of input.vendors ?? []) {
    if (vendor.credential && typeof vendor.credential.env === "string") names.add(vendor.credential.env);
  }
  for (const manifest of input.harnessManifests ?? []) {
    for (const name of Object.keys(manifest ?? {})) names.add(name);
  }
  return names;
}
