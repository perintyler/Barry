/**
 * Reading declared environment variables to values.
 *
 * One reader per source kind. A declared variable that cannot be read is a
 * thrown `EnvReadError` naming the variable — never a silent skip, which is
 * how a live session once came to resolve 11 of 25 secrets and say nothing.
 * Absent is an answer; a failed read is a failure to get one. The caller
 * decides whether the failure refuses a session (the gate does) or degrades
 * (the engine catches, and drops the tools whose keys went missing).
 */

import type { EnvField, EnvSourceName, Environment, EnvironmentVariable } from "./types.js";
import { EnvReadError } from "./types.js";
import { environmentVariableNames, getEnvironmentVariable } from "./variables.js";
import type { VaultSession } from "../vault/account.js";

export interface ReadEnvironmentOptions {
  identity: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  /** The active identity's open vault. Required to read `vault`-sourced vars. */
  vault?: VaultSession;
  /**
   * The identity's parsed `.env` entries — `file` sources read from here.
   * Supplied by the identities layer, which knows where the file lives.
   */
  file?: Record<string, string>;
}

/**
 * Read the named variables. With no names, reads everything either layer
 * defines. Values land in `vars`; `sources` says where each came from.
 */
export async function readEnvironment(
  names: readonly string[] | undefined,
  opts: ReadEnvironmentOptions,
): Promise<Environment> {
  const wanted = names ?? environmentVariableNames(opts);
  const env: Environment = { vars: {}, sources: {} };

  for (const name of wanted) {
    const definition = getEnvironmentVariable(name, opts);
    if (!definition) continue;
    const value = await readVariable(name, definition, opts);
    if (value !== null) {
      env.vars[name] = value;
      env.sources[name] = definition.source;
    }
  }

  return env;
}

async function readVariable(
  name: string,
  definition: EnvironmentVariable,
  opts: ReadEnvironmentOptions,
): Promise<string | null> {
  switch (definition.source) {
    case "vault": {
      if (!opts.vault) {
        throw new EnvReadError(
          name,
          "vault-sourced but no vault session — the identity has no vault, or it was not opened",
        );
      }
      try {
        const item = await opts.vault.getItem(definition.item);
        return item[definition.field];
      } catch (err) {
        throw new EnvReadError(
          name,
          `vault item "${definition.item}" (${definition.field}): ${message(err)}`,
          { cause: err },
        );
      }
    }
    case "file": {
      const entries = opts.file;
      if (!entries) {
        throw new EnvReadError(name, `file-sourced but no .env entries were supplied`);
      }
      const value = entries[definition.name];
      if (value === undefined || value === "") {
        throw new EnvReadError(name, `entry "${definition.name}" is absent or empty in the identity's .env`);
      }
      return value;
    }
    case "keychain": {
      const { KeychainProvider } = await import("./providers/keychain.js");
      const value = await new KeychainProvider({ service: definition.service }).get("", definition.account);
      if (value === null || value === "") {
        throw new EnvReadError(
          name,
          `keychain ${definition.service}/${definition.account} has no entry`,
        );
      }
      return value;
    }
    case "value":
      return definition.value;
  }
}

/** Convenience for callers that want one field of one item, typed like the definition. */
export async function readVaultField(
  vault: VaultSession,
  item: string,
  field: EnvField,
): Promise<string | null> {
  return (await vault.getItem(item))[field];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { EnvSourceName };
