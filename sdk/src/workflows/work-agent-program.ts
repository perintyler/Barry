import { z } from "zod";
import { approvedBoundsSchema } from "../bounds/workflow-bounds.js";
import { workArtifactSchema } from "./work-artifact-contract.js";

const reference = z.string().min(1).max(200).refine(value => Buffer.byteLength(value, "utf8") <= 200);
/** The profile is retained source data, never an executable path or credential.
 * Its complete runtime/provider contract is interpreted by the installed adapter.
 * Shared leaf schemas have no dependency on the enclosing start/plan module. */
export const workAgentProgramSchema = z.strictObject({
  activity_type: reference,
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
  installation: reference,
  scope: approvedBoundsSchema,
  profile: workArtifactSchema.refine(value => value.purpose === "source"),
}).refine(value => value.source_digest === value.profile.digest, "Agent source must be its retained profile");
export type WorkAgentProgram = z.infer<typeof workAgentProgramSchema>;
