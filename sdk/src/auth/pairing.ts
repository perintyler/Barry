import { z } from "zod";
import { DevicePrincipalSchema, DeviceScopesSchema, IdentityGrantsSchema } from "./principal.js";

const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DeviceTokenSchema = z.string().regex(/^barry_dt_[A-Za-z0-9_-]{32}$/);
export const PollTokenSchema = z.string().regex(/^barry_pr_[A-Za-z0-9_-]{32}$/);
export const PairingCodeSchema = z.string().regex(/^(?:\d{6}|\d{3}-\d{3})$/);
export const DeviceIdSchema = z.string().regex(/^device_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
// eslint-disable-next-line no-control-regex -- a device's name is shown to people; control characters are refused
const ClientNameSchema = z.string().min(1).max(100).refine(name => Boolean(name.trim()) && !/[\x00-\x1f\x7f]/.test(name));

export const PairingRequestInputSchema = z.object({
  clientName: ClientNameSchema,
  requestedScopes: DeviceScopesSchema,
  requestedIdentityIds: IdentityGrantsSchema,
}).strict();
export const PairingRequestSchema = z.object({
  requestId: z.string().min(1), pairingCode: PairingCodeSchema, pollToken: PollTokenSchema,
  expiresAt: TimestampSchema, expiresIn: z.number().int().positive(),
}).strict();
export const PairingGrantSchema = z.object({
  scopes: DeviceScopesSchema, identityIds: IdentityGrantsSchema, expiresAt: TimestampSchema.optional(),
}).strict();
export const PairingAuthorizeInputSchema = z.object({ code: PairingCodeSchema, grant: PairingGrantSchema.nullable() }).strict();
export const PairingAuthorizeResponseSchema = z.object({ status: z.enum(["authorized", "rejected"]), clientName: ClientNameSchema }).strict();
export const PairingClaimInputSchema = z.object({ pollToken: PollTokenSchema }).strict();
export const PairingPendingSchema = z.object({ status: z.literal("pending") }).strict();
export const PairingRejectedSchema = z.object({ status: z.literal("rejected") }).strict();
export const PairingUnavailableSchema = z.object({ status: z.enum(["expired", "consumed"]) }).strict();
export const PairingAuthorizedSchema = z.object({ status: z.literal("authorized"), deviceId: DeviceIdSchema, deviceToken: DeviceTokenSchema,
  scopes: DeviceScopesSchema, identityIds: IdentityGrantsSchema }).strict();
export const PairingClaimSchema = z.discriminatedUnion("status", [PairingPendingSchema, PairingRejectedSchema, PairingUnavailableSchema, PairingAuthorizedSchema]);
export const PendingPairingSchema = PairingRequestInputSchema.extend({
  requestId: z.string().min(1), pairingCode: PairingCodeSchema, expiresAt: TimestampSchema,
}).strict();
export const PendingPairingsResponseSchema = z.object({ requests: z.array(PendingPairingSchema) }).strict();
export const DeviceRecordSchema = z.object({
  id: DeviceIdSchema, name: ClientNameSchema, tokenPrefix: z.string().regex(/^barry_dt_[A-Za-z0-9_-]{8}$/),
  actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), scopes: DeviceScopesSchema, identityIds: IdentityGrantsSchema,
  createdAt: TimestampSchema, unusedExpiresAt: TimestampSchema, expiresAt: TimestampSchema.nullable(), firstUsedAt: TimestampSchema.nullable(),
  lastUsedAt: TimestampSchema.nullable(), revokedAt: TimestampSchema.nullable(),
}).strict();
export const DeviceListResponseSchema = z.object({ devices: z.array(DeviceRecordSchema) }).strict();
export const DeviceRevokeResponseSchema = z.object({ revoked: z.literal(true) }).strict();
export const DeviceVerifyInputSchema = z.object({ token: DeviceTokenSchema }).strict();
export const DeviceVerifyResponseSchema = z.object({ principal: DevicePrincipalSchema }).strict();

export type PairingInput = z.infer<typeof PairingRequestInputSchema>;
export type PairingGrant = z.infer<typeof PairingGrantSchema>;
export type PairingRequest = z.infer<typeof PairingRequestSchema>;
export type PairingClaim = z.infer<typeof PairingClaimSchema>;
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;
