import { z } from "zod";

const ref = z.string().min(1).max(200).refine(value => Buffer.byteLength(value, "utf8") <= 200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Shared leaf contract: importing a program cannot initialize its parent plan. */
export const workArtifactSchema = z.strictObject({
  digest,
  bytes: z.number().int().nonnegative().max(1_073_741_824),
  media_type: ref,
  owner_identity: ref.nullable(),
  purpose: z.enum(["source", "input", "output", "log", "checkpoint"]),
});
