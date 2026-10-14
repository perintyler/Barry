import { z } from "zod";

const item = z.string().min(1);
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
/** A secret's environment name: upper case, digits and underscores. */
export const SecretNameSchema = secretName;
export const SecretReferenceSchema = z.discriminatedUnion("in", [
  z.strictObject({ in: z.literal("keychain"), item, account: item.optional() }),
  z.strictObject({ in: z.literal("vault"), item, field: z.enum(["username", "password", "notes", "uri"]) }),
  // `key` aliases the source entry without changing the environment binding name.
  // Rationale: docs/decisions/0022-sdk-auth-and-logging-invariants.md.
  z.strictObject({ in: z.literal(".env"), key: secretName.optional() }),
]);
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
export interface SecretBinding {
  reference: SecretReference;
  /** Keep file references attached to their author rather than the inheriting child. */
  directory?: string;
}
export type SecretBindings = Record<string, SecretBinding>;

export function bindSecretReferences(raw: unknown, directory?: string): SecretBindings {
  const references = z.record(secretName, SecretReferenceSchema).parse(raw ?? {});
  return Object.fromEntries(Object.entries(references).map(([name, reference]) => {
    if (reference.in === ".env" && !directory) throw new Error(`${name}: .env secret requires its declaring directory`);
    return [name, { reference, ...(directory ? { directory } : {}) }];
  }));
}

export function mergeSecretBindings(parent: SecretBindings = {}, child: SecretBindings = {}): SecretBindings {
  return Object.fromEntries(Object.entries({ ...parent, ...child }).map(([name, binding]) => {
    secretName.parse(name);
    const reference = SecretReferenceSchema.parse(binding.reference);
    if (reference.in === ".env" && !binding.directory) throw new Error(`${name}: .env secret requires its declaring directory`);
    return [name, { reference, ...(binding.directory ? { directory: binding.directory } : {}) }];
  }));
}

/** Named selection keeps connection credentials outside identity configuration. */
export function parseVaultName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error("vault must be a name containing letters, digits and dashes; inline vault connections are retired");
  }
  return value;
}
