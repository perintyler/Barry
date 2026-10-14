import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mergeSecretBindings, type SecretBindings } from "../identities/secrets.js";
import type { VaultSession } from "../vault/account.js";
import { EnvReadError, type Environment } from "./types.js";
import { VaultItemNotFoundError } from "../vault/client.js";

const execute = promisify(execFile);
export interface SecretBindingReaders {
  vault?: Pick<VaultSession, "getItem">;
  readFile?: (filename: string) => Promise<string>;
  readKeychain?: (item: string, account?: string) => Promise<string | null>;
}

async function readKeychain(item: string, account?: string): Promise<string | null> {
  const args = ["find-generic-password", "-s", item];
  if (account !== undefined) args.push("-a", account);
  args.push("-w");
  const { stdout } = await execute("/usr/bin/security", args);
  return stdout.replace(/\r?\n$/, "") || null;
}

export async function readSecretBindings(
  bindings: SecretBindings,
  readers: SecretBindingReaders = {},
): Promise<Environment> {
  const environment: Environment = { vars: {}, sources: {} };
  const files = new Map<string, Promise<Record<string, string>>>();

  const getParsedEnvFile = (filename: string): Promise<Record<string, string>> => {
    let pending = files.get(filename);
    if (!pending) {
      pending = (async () => {
        const content = await (readers.readFile ?? ((file) => readFile(file, "utf8")))(filename);
        return Object.fromEntries(
          Object.entries(parseEnv(content)).map(([k, v]) => [k, String(v)]),
        );
      })();
      files.set(filename, pending);
    }
    return pending;
  };

  const entries = Object.entries(mergeSecretBindings({}, bindings));
  const settled = await Promise.allSettled(
    entries.map(async ([name, binding]) => {
      const reference = binding.reference;
      let value: string | null | undefined;
      try {
        switch (reference.in) {
          case ".env": {
            if (!binding.directory || !isAbsolute(binding.directory)) {
              throw new Error(".env secret requires an absolute declaring directory");
            }
            const filename = join(binding.directory, ".env");
            const parsed = await getParsedEnvFile(filename);
            value = parsed[reference.key ?? name];
            break;
          }
          case "vault":
            if (!readers.vault) throw new EnvReadError(name, "could not read declared vault secret: the identity names no vault of its own");
            try {
              value = (await readers.vault.getItem(reference.item))[reference.field];
            } catch (error) {
              // Only the item's name, which the declaration already says.
              if (error instanceof VaultItemNotFoundError) {
                throw new EnvReadError(name, `could not read declared vault secret: item "${reference.item}" is not in the identity's vault`);
              }
              throw error;
            }
            break;
          case "keychain":
            value = await (readers.readKeychain ?? readKeychain)(reference.item, reference.account);
            break;
        }
      } catch (error) {
        if (error instanceof EnvReadError) throw error;
        // Backend errors can contain credentials or file contents; expose only the declaration.
        throw new EnvReadError(name, `could not read declared ${reference.in} secret`);
      }
      if (value === null || value === undefined || value === "") {
        throw new EnvReadError(name, `declared ${reference.in} secret is absent or empty`);
      }
      // Typed here, not asserted: a literal in the returned object would widen to string.
      const source: "file" | "vault" | "keychain" = reference.in === ".env" ? "file" : reference.in;
      return { name, value, source };
    }),
  );

  // Every unreadable secret at once: one at a time, an identity missing
  // nineteen took nineteen launches to learn that.
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  if (failures.length > 0) {
    const [first, ...rest] = failures;
    if (!(first instanceof EnvReadError) || rest.length === 0) throw first;
    const others = rest.map((failure) => (failure instanceof EnvReadError ? `$${failure.varName}` : "another")).join(", ");
    const reason = first.message.replace(`$${first.varName}: `, "");
    throw new EnvReadError(first.varName, `${reason} — and ${rest.length} more cannot be read: ${others}`);
  }
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const { name, value, source } = result.value;
    environment.vars[name] = value;
    environment.sources[name] = source;
  }
  return environment;
}
