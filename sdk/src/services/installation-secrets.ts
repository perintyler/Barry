import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { bindSecretReferences, SecretReferenceSchema } from "../identities/secrets.js";
import { readSecretBindings } from "../env/secret-bindings.js";
import { EnvReadError } from "../env/types.js";
import { openVault } from "../vault/account.js";
import { instanceEnvValue } from "./instance-env.js";
import { barryConfigDir, barryEnvPath } from "./home.mjs";

const configuration = z.object({
  secrets: z.record(z.string(), SecretReferenceSchema).optional(),
  vault: z.string().min(1).optional(),
});

export async function installationSecrets(
  names: readonly string[],
  options: { configPath?: string; envPath?: string; allowUnconfiguredInstance?: boolean; optionalNames?: readonly string[] } = {},
): Promise<Record<string, string>> {
  if (!names.length) return {};
  const configPath = options.configPath ?? join(barryConfigDir(), "barry.yaml");
  const envPath = options.envPath ?? barryEnvPath();
  const selected = configuration.parse(existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) : {});
  // Fresh setup may lack a credential; authored references remain strict.
  if (options.allowUnconfiguredInstance && names.length === 1 && names[0] === "BARRY_SECRET"
    && !selected.secrets?.BARRY_SECRET && !instanceEnvValue("BARRY_SECRET", envPath)) return {};
  const references = { BARRY_SECRET: { in: ".env" as const }, ...selected.secrets };
  const bindings = bindSecretReferences(Object.fromEntries(names.flatMap(name => {
    const reference = references[name as keyof typeof references];
    if (!reference) {
      if (options.optionalNames?.includes(name)) return [];
      throw new Error(`$${name}: installation secret is not declared`);
    }
    return [[name, reference]];
  })), dirname(envPath));
  const needsVault = Object.values(bindings).some(binding => binding.reference.in === "vault");
  let vault: Awaited<ReturnType<typeof openVault>> | undefined;
  if (needsVault && selected.vault) {
    try {
      vault = await openVault(selected.vault);
    } catch {
      const name = Object.keys(bindings).find(name => bindings[name].reference.in === "vault")!;
      throw new EnvReadError(name, "could not open the declared vault");
    }
  }
  try {
    const environment = await readSecretBindings(bindings, {
      vault,
      // Installation file references belong to the private instance env, not an identity .env.
      readFile: async () => readFileSync(envPath, "utf8"),
    });
    return environment.vars;
  } finally {
    await vault?.close();
  }
}
