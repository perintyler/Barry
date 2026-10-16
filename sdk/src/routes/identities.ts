import { z } from "zod";
import { route } from "./route.js";
import { IdentitySchema, AvailableBagsResponseSchema, CreateIdentityRequestSchema, EffectiveIdentityResponseSchema, IdentityListResponseSchema, IdentityResponseSchema, UpdateIdentityRequestSchema } from "../identities/types.js";
import { BoundListResponseSchema } from "../bounds/types.js";

const BagAuthResponse = z.strictObject({ status: z.string() });
const BagAuthorizationResponse = BagAuthResponse.extend({ ok: z.literal(true) });
const BagRetryResponse = z.looseObject({});
const BagStatusResponse = z.looseObject({
  ok: z.boolean(), available: z.boolean(), error: z.string().optional(),
  shared: z.array(z.string()).optional(), needsAuth: z.array(z.string()).optional(),
  authExpired: z.array(z.string()).optional(), failed: z.array(z.string()).optional(), deferred: z.array(z.unknown()).optional(),
});
const IdentityAckSchema = z.object({ ok: z.literal(true) }).strict();
const IdentityRemovalSchema = z.object({ ok: z.literal(true), activeIdentity: z.string().nullable().optional() }).strict();

export const identitiesRoutes = {
  listIdentities: route({ method: "get", path: "/identities", operationId: "listIdentities", responses: { 200: IdentityListResponseSchema } }),
  createIdentity: route({ method: "post", path: "/identities", operationId: "createIdentity", body: CreateIdentityRequestSchema, responses: { 201: IdentityResponseSchema } }),
  getEffectiveIdentity: route({ method: "get", path: "/identities/effective", operationId: "getEffectiveIdentity", query: z.object({ "repoPath": z.string().optional() }), responses: { 200: EffectiveIdentityResponseSchema } }),
  listAvailableBags: route({ method: "get", path: "/identities/bags/available", operationId: "listAvailableBags", responses: { 200: AvailableBagsResponseSchema } }),
  listBounds: route({ method: "get", path: "/bounds", operationId: "listBounds", responses: { 200: BoundListResponseSchema } }),
  getIdentity: route({ method: "get", path: "/identities/{identity}", operationId: "getIdentity", params: z.object({ "identity": z.string().min(1).describe("The identity's name or its id") }), responses: { 200: IdentityResponseSchema } }),
  updateIdentity: route({ method: "patch", path: "/identities/{identity}", operationId: "updateIdentity", params: z.object({ "identity": z.string().min(1).describe("The identity's name or its id") }), body: UpdateIdentityRequestSchema, responses: { 200: IdentityResponseSchema } }),
  deleteIdentity: route({ method: "delete", path: "/identities/{identity}", operationId: "deleteIdentity", params: z.object({ "identity": z.string().min(1).describe("The identity's name or its id") }), responses: { 200: IdentityRemovalSchema } }),
  setActiveIdentity: route({ method: "post", path: "/identities/{identity}/set-default", operationId: "setActiveIdentity", params: z.object({ "identity": z.string().min(1).describe("The identity's name or its id") }), responses: { 200: IdentityAckSchema } }),
  getBagStatus: route({ method: "get", path: "/identities/bags/status", operationId: "getBagStatus", query: z.object({ sessionId: z.string().optional() }), responses: { 200: BagStatusResponse } }),
  retryBag: route({ method: "post", path: "/identities/bags/{bagName}/retry", operationId: "retryBag", params: z.object({ "bagName": z.string() }), responses: { 200: BagRetryResponse } }),
  authorizeBag: route({ method: "post", path: "/identities/bags/{bagName}/auth", operationId: "authorizeBag", params: z.object({ "bagName": z.string() }), responses: { 200: BagAuthorizationResponse } }),
  getBagAuthStatus: route({ method: "get", path: "/identities/bags/{bagName}/auth/status", operationId: "getBagAuthStatus", params: z.object({ "bagName": z.string() }), responses: { 200: BagAuthResponse } }),
};

export const identitiesComponents = {
  Identity: IdentitySchema,
  AvailableBagsResponse: AvailableBagsResponseSchema,
  BagAuthResponse: BagAuthResponse,
  BagAuthorizationResponse: BagAuthorizationResponse,
  BagRetryResponse: BagRetryResponse,
  BagStatusResponse: BagStatusResponse,
  BoundListResponse: BoundListResponseSchema,
  CreateIdentityRequest: CreateIdentityRequestSchema,
  EffectiveIdentityResponse: EffectiveIdentityResponseSchema,
  IdentityAck: IdentityAckSchema,
  IdentityListResponse: IdentityListResponseSchema,
  IdentityRemoval: IdentityRemovalSchema,
  IdentityResponse: IdentityResponseSchema,
  UpdateIdentityRequest: UpdateIdentityRequestSchema,
};

import { BarryError } from "../barry/errors.js";
import type { IdentityUpdate } from "../barry/types.js";

export function identityRequestOf(update: IdentityUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(update)) {
    if (!(field in UpdateIdentityRequestSchema.shape)) {
      throw new BarryError("unavailable", `Changing ${field} is not available over HTTP yet`, "Call it from a process that hosts the identities bag");
    }
    body[field] = value;
  }
  return body;
}

export function identityUpdateOf(body: z.input<typeof UpdateIdentityRequestSchema>): IdentityUpdate {
  return body;
}
