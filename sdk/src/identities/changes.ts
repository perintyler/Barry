/**
 * The change `identities.update` takes, from every door. Server-side: it
 * validates against the bag, store and secret schemas, which a browser client
 * of the identities API has no use for (`./types.ts` stays browser-safe).
 */
import { parentOf } from "../bags/extensions.js";
import { z } from "zod";
import { IdentityAdaptersSchema } from "./adapters.js";
import { BagNameSchema, IdentityBagConfigurationSchema } from "./bags.js";
import { SecretNameSchema, SecretReferenceSchema, parseVaultName } from "./secrets.js";

/**
 * A change to an identity's configuration, in `identity.yaml`'s vocabulary:
 * what `identities.update` takes from every door. A key that is absent is left
 * alone and `null` clears it. Strict, so a misspelt key is refused instead of
 * stored where nothing reads it. HTTP's `UpdateIdentityRequest` is mapped onto
 * this; the CLI writes it directly.
 */
export const IdentityChangesSchema = z.strictObject({
  display_name: z.string().min(1).max(200).nullable().optional(),
  bags: z.array(BagNameSchema).nullable().optional(),
  bag_configs: z.record(BagNameSchema, IdentityBagConfigurationSchema).nullable().optional(),
  adapters: IdentityAdaptersSchema.nullable().optional(),
  traits: z.array(z.string().min(1)).nullable().optional(),
  bounds: z.array(z.string().min(1)).nullable().optional(),
  status_notify: z.strictObject({ tool: z.string().trim().min(1), target: z.string().optional() }).nullable().optional(),
  github: z.strictObject({ installationId: z.int().positive() }).nullable().optional(),
  vault: z.string().refine((value) => { try { parseVaultName(value); return true; } catch { return false; } }, "a vault is a name of letters, digits and dashes").nullable().optional(),
  secrets: z.record(SecretNameSchema, z.object({ reference: SecretReferenceSchema, directory: z.string().optional() })).nullable().optional(),
  /** More commands that run Barry as this identity, beside its own name. */
  aliases: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i)).nullable().optional(),
}).superRefine((value, context) => {
  for (const [index, bag] of (value.bags ?? []).entries()) {
    const parent = parentOf(bag);
    if (parent && !value.bags?.includes(parent)) context.addIssue({ code: "custom", path: ["bags", index], message: `extension ${bag} requires parent ${parent} in bags; Pack ${parent} first` });
  }
  for (const bag of Object.keys(value.bag_configs ?? {})) {
    const parent = parentOf(bag);
    if (parent) context.addIssue({ code: "custom", path: ["bag_configs", bag], message: `extension ${bag} takes no configuration; configure parent ${parent}` });
  }
});
export type IdentityChanges = z.input<typeof IdentityChangesSchema>;
