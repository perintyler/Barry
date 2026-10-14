/**
 * What one environment variable's value is and where it comes from.
 *
 * There is no "credentials" concept here and no custom map type: a
 * declaration surface is a plain `Record<string, EnvironmentVariable>` —
 * env var name → definition. Reading produces an `Environment`.
 */

/** The item fields a vault item carries; a definition names one. */
export type EnvField = "username" | "password" | "notes" | "uri";

/**
 * Where one environment variable's value comes from.
 *
 * Four sources. `vault` is the expected home for anything secret; `file` is
 * an entry in the identity's `.env`; `value` is an inline constant, right
 * only for non-secrets; `keychain` is the login Keychain, which any same-UID
 * process can read.
 */
export type EnvironmentVariable =
  | { source: "vault"; item: string; field: EnvField; expose?: "env" }
  | { source: "file"; name: string; expose?: "env" }
  | { source: "value"; value: string; expose?: "env" }
  | { source: "keychain"; service: string; account: string; expose?: "env" };

export type EnvSourceName = EnvironmentVariable["source"];

/**
 * How far a value travels.
 *
 * `env` puts the value in the agent process's own environment, where the
 * agent can read it with `env` — and so can every subprocess it spawns and
 * every crash log that dumps the environment. Only secrets read by an
 * external binary the agent shells out to need that: the provider CLI's API
 * key, a token `gh` expects. Everything else is reachable through the engine,
 * which hands each tool only the keys that tool declared.
 *
 * Absent means tool-scoped, which is the safe default and what most secrets
 * want.
 */
export type EnvExposure = "env";

/** What reading produces: the values, and where each came from. */
export interface Environment {
  vars: Record<string, string>;
  sources: Record<string, EnvSourceName>;
}

/**
 * A definition that does not hold up. Distinct from a read failure: a
 * malformed definition is config the user has to fix, and it must not
 * disappear into a catch that treats it like a backend that is merely down.
 */
export class EnvDefinitionError extends Error {
  readonly varName: string;
  constructor(varName: string, message: string) {
    super(`$${varName}: ${message}`);
    this.name = "EnvDefinitionError";
    this.varName = varName;
  }
}

/** Reading a declared value failed. The cause says which backend refused. */
export class EnvReadError extends Error {
  readonly varName: string;
  constructor(varName: string, message: string, options?: { cause?: unknown }) {
    super(`$${varName}: ${message}`, options);
    this.name = "EnvReadError";
    this.varName = varName;
  }
}

/**
 * Narrow a loosely typed definition (identity files and DB rows carry plain
 * records) to an `EnvironmentVariable`, naming the variable when it does not
 * hold up.
 */
export function asEnvironmentVariable(varName: string, value: unknown): EnvironmentVariable {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { source: "value", value: String(value) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnvDefinitionError(varName, "definition must be an object naming a source");
  }
  const v = value as Record<string, unknown>;
  switch (v.source) {
    case "vault": {
      const field = v.field;
      if (typeof v.item !== "string" || !v.item) {
        throw new EnvDefinitionError(varName, "vault definition needs an `item`");
      }
      if (field !== "username" && field !== "password" && field !== "notes" && field !== "uri") {
        throw new EnvDefinitionError(varName, `vault field must be one of username|password|notes|uri, got ${JSON.stringify(field)}`);
      }
      return { source: "vault", item: v.item, field, ...expose(v) };
    }
    case "file":
      if (typeof v.name !== "string" || !v.name) {
        throw new EnvDefinitionError(varName, "file definition needs the entry `name`");
      }
      return { source: "file", name: v.name, ...expose(v) };
    case "value":
      if (typeof v.value === "number" || typeof v.value === "boolean") {
        return { source: "value", value: String(v.value), ...expose(v) };
      }
      if (typeof v.value !== "string") {
        throw new EnvDefinitionError(varName, "value definition needs a string `value`");
      }
      return { source: "value", value: v.value, ...expose(v) };
    case "keychain":
      if (typeof v.service !== "string" || typeof v.account !== "string") {
        throw new EnvDefinitionError(varName, "keychain definition needs `service` and `account`");
      }
      return { source: "keychain", service: v.service, account: v.account, ...expose(v) };
    case undefined:
      throw new EnvDefinitionError(varName, "definition names no source");
    default:
      throw new EnvDefinitionError(
        varName,
        `unknown source ${JSON.stringify(v.source)} (expected vault | file | value | keychain)`,
      );
  }
}

function expose(v: Record<string, unknown>): { expose?: "env" } {
  return v.expose === "env" ? { expose: "env" } : {};
}
