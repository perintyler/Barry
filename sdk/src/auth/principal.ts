import { z } from "zod";

export const DEVICE_SCOPES = [
  "sessions:read", "sessions:write", "sessions:turn", "sessions:approve",
  "events:read", "events:write", "events:subscribe",
  "actions:read", "actions:dispatch", "tools:invoke", "identities:read",
  "artifacts:read", "artifacts:write", "artifacts:share",
] as const;
export const DeviceScopeSchema = z.enum(DEVICE_SCOPES);
export type DeviceScope = z.infer<typeof DeviceScopeSchema>;

export const IdentityGrantsSchema = z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(64)
  .refine(ids => new Set(ids).size === ids.length, "Identity grants must be unique").readonly();
export const DeviceScopesSchema = z.array(DeviceScopeSchema).min(1).max(DEVICE_SCOPES.length)
  .refine(scopes => new Set(scopes).size === scopes.length, "Scopes must be unique")
  .refine(scopes => !scopes.includes("artifacts:share") || scopes.includes("artifacts:read"), "Artifact sharing also requires read access").readonly();

export const DevicePrincipalSchema = z.object({
  kind: z.literal("device"),
  credentialId: z.string().min(1),
  actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identityIds: IdentityGrantsSchema,
  scopes: DeviceScopesSchema,
}).strict().readonly();
export type DevicePrincipal = z.infer<typeof DevicePrincipalSchema>;
export const InstallationPrincipalSchema = z.object({
  kind: z.literal("installation"),
  actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  credentialId: z.literal("installation"),
}).strict().readonly();
export type InstallationPrincipal = z.infer<typeof InstallationPrincipalSchema>;
export const AuthPrincipalSchema = z.union([DevicePrincipalSchema, InstallationPrincipalSchema]);
export type AuthPrincipal = z.infer<typeof AuthPrincipalSchema>;

export function hasScope(principal: AuthPrincipal, scope: DeviceScope): boolean {
  return principal.kind === "installation" || principal.scopes.includes(scope);
}
export function hasIdentityGrant(principal: AuthPrincipal, identityId: number): boolean {
  return principal.kind === "installation" || principal.identityIds.includes(identityId);
}
