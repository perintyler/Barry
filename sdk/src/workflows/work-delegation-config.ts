import { isAbsolute } from "node:path";
import { z } from "zod";
import { readBoundedFile } from "./read-bounded.js";
import { WorkflowError } from "./errors.js";
import type { DelegationKey } from "./work-delegation.js";
const keysSchema = z.array(z.strictObject({ id: z.string().min(1).max(200), secret: z.string().min(32).max(4096), not_before: z.number().int().nonnegative(), not_after: z.number().int().nonnegative() })).min(1).max(4)
  .refine(keys => new Set(keys.map(key => key.id)).size === keys.length && keys.every(key => key.not_after > key.not_before));
const ringSchema = z.record(z.string().min(1).max(200), keysSchema).refine(value => Object.keys(value).length <= 16);
/** Trusted installation configuration; parsing errors never echo key material. */
export function readWorkDelegationKeys(path: string): Record<string, DelegationKey[]> {
  try {
    if (!isAbsolute(path)) throw new Error("absolute key path required");
    return ringSchema.parse(JSON.parse(readBoundedFile(path, 65536, { ownerOnly: true }).toString("utf8")));
  } catch { throw new WorkflowError("WorkDelegationConfigurationInvalid", "Dedicated work delegation key configuration is unreadable or invalid.", 503); }
}
export function workDelegationSigningKey(keys: readonly DelegationKey[], now = Date.now()): DelegationKey | undefined {
  return keys.filter(key => key.not_before <= now && key.not_after > now).sort((a, b) => b.not_before - a.not_before || a.id.localeCompare(b.id))[0];
}
