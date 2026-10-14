import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { bindSecretReferences, SecretReferenceSchema } from "@barry-rocks/sdk/internal/identities";
import { readSecretBindings } from "@barry-rocks/sdk/internal/env";

const secretNames = new Set(["VAULT_REGISTRATION_SECRET", "VAULT_BACKUP_SECRET", "VAULT_MCP_TOKEN", "VAULT_MASTER_PASSWORD", "VAULT_CLIENT_SECRET"]);
const configurationSchema = z.object({
  secrets: z.record(z.string(), SecretReferenceSchema).optional(),
  mcp: z.object({ email: z.string().min(1), client_id: z.string().min(1).optional() }).strict().optional(),
}).strict();

/** Bootstrap cannot read a vault whose startup depends on these credentials. */
export async function readDaemonConfiguration(databasePath: string): Promise<{ secrets: Record<string, string>; mcp?: { email: string; client_id?: string } }> {
  const directory = join(dirname(databasePath), "private");
  const filename = join(directory, "barry.yaml");
  if (!existsSync(filename)) return { secrets: {} };
  for (const path of [directory, filename]) {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error("Vault daemon configuration must be private to its service account");
  }
  let configuration: z.infer<typeof configurationSchema>;
  try {
    configuration = configurationSchema.parse(parse(readFileSync(filename, "utf8")));
  } catch {
    throw new Error("Invalid vault daemon configuration");
  }
  for (const [name, reference] of Object.entries(configuration.secrets ?? {})) {
    if (!secretNames.has(name)) throw new Error("Unknown vault daemon secret declaration");
    if (reference.in === "vault") throw new Error("Vault daemon bootstrap cannot depend on vault secrets");
  }
  const envPath = join(directory, ".env");
  if (Object.values(configuration.secrets ?? {}).some(reference => reference.in === ".env") && existsSync(envPath) && (statSync(envPath).mode & 0o077) !== 0) {
    throw new Error("Vault daemon credential file must be private to its service account");
  }
  const bindings = bindSecretReferences(configuration.secrets ?? {}, directory);
  const environment = await readSecretBindings(bindings);
  return { secrets: environment.vars, mcp: configuration.mcp };
}
