import { z } from "zod";
import { IdentityGrantsSchema } from "@barry-rocks/sdk/internal/auth";

export const SessionAccessSchema = z.object({
  actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identityIds: IdentityGrantsSchema,
}).strict().readonly();
export type SessionAccess = z.infer<typeof SessionAccessSchema>;

export function sessionAccessPredicate(input: unknown): { clause: string; params: number[] } {
  const access = SessionAccessSchema.parse(input);
  return { clause: `identity_id IN (${access.identityIds.map(() => "?").join(",")}) AND (user_id IS NULL OR user_id = ?)`, params: [...access.identityIds, access.actorId] };
}
