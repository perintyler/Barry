import { z } from "zod";
import { DeviceIdSchema, PairingRequestInputSchema, PairingRequestSchema, PairingClaimInputSchema, PairingAuthorizedSchema, PairingPendingSchema, PairingRejectedSchema, PairingUnavailableSchema, PairingAuthorizeInputSchema, PairingAuthorizeResponseSchema, PendingPairingsResponseSchema, DeviceListResponseSchema, DeviceRevokeResponseSchema } from "../auth/pairing.js";
import { route } from "./route.js";

export const devicesRoutes = {
  requestPairing: route({ method: "post", path: "/devices/pair/request", operationId: "requestPairing", body: PairingRequestInputSchema, responses: { 201: PairingRequestSchema }, sensitive: true }),
  claimPairing: route({ method: "post", path: "/devices/pair/claim", operationId: "claimPairing", body: PairingClaimInputSchema, responses: { 200: PairingAuthorizedSchema, 202: PairingPendingSchema, 403: PairingRejectedSchema, 410: PairingUnavailableSchema }, sensitive: true }),
  pendingPairings: route({ method: "get", path: "/devices/pair/pending", operationId: "pendingPairings", responses: { 200: PendingPairingsResponseSchema }, sensitive: true }),
  authorizePairing: route({ method: "post", path: "/devices/pair/authorize", operationId: "authorizePairing", body: PairingAuthorizeInputSchema, responses: { 200: PairingAuthorizeResponseSchema }, sensitive: true }),
  listDevices: route({ method: "get", path: "/devices", operationId: "listDevices", responses: { 200: DeviceListResponseSchema }, sensitive: true }),
  revokeDevice: route({ method: "delete", path: "/devices/{id}", operationId: "revokeDevice", params: z.object({ id: DeviceIdSchema }), responses: { 200: DeviceRevokeResponseSchema }, sensitive: true }),
};

export const devicesComponents = {
  PairingRequestInput: PairingRequestInputSchema, PairingRequest: PairingRequestSchema,
  PairingClaimInput: PairingClaimInputSchema, PairingAuthorized: PairingAuthorizedSchema,
  PairingPending: PairingPendingSchema, PairingRejected: PairingRejectedSchema, PairingUnavailable: PairingUnavailableSchema,
  PairingAuthorizeInput: PairingAuthorizeInputSchema, PairingAuthorizeResponse: PairingAuthorizeResponseSchema,
  PendingPairingsResponse: PendingPairingsResponseSchema, DeviceListResponse: DeviceListResponseSchema, DeviceRevokeResponse: DeviceRevokeResponseSchema,
};
