import { hasValidSecret, DeviceIdSchema, DeviceListResponseSchema, DeviceRevokeResponseSchema, DeviceVerifyInputSchema, DeviceVerifyResponseSchema, PairingAuthorizeResponseSchema, PairingClaimSchema, PairingRequestSchema, PendingPairingsResponseSchema } from "@barry-rocks/sdk/internal/auth";

import { devicesRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { Router, type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { DevicePairingError, devices, installationOperator } from "./devices.js";

interface DeviceRoutesOptions {
  store?: ReturnType<typeof devices>;
  authenticateInstallation?: (request: Request) => boolean;
  resolveOperator?: () => Promise<number | null>;
}

function problem(request: Request, response: Response, status: number, detail: string): void {
  response.setHeader("Cache-Control", "no-store");
  response.status(status).type("application/problem+json").json({
    type: "about:blank", title: status === 500 ? "Internal Server Error" : "Device request refused",
    status, detail, instance: request.originalUrl.split("?")[0],
  });
}

export const deviceErrors: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  if (error && typeof error === "object" && "type" in error && error.type === "entity.parse.failed") {
    problem(request, response, 400, "invalid_json");
    return;
  }
  if (error instanceof DevicePairingError) {
    if (error.retryAfter !== undefined) response.setHeader("Retry-After", String(error.retryAfter));
    problem(request, response, error.status, error.code);
    return;
  }
  // Database and schema errors may contain submitted secrets; never include their text in logs or responses.
  request.log?.error("devices.request_failed", { requestId: request.requestId });
  problem(request, response, 500, "device_request_failed");
};

/** Mount before general authentication: only request and claim are public. */
export function createDeviceRouter(options: DeviceRoutesOptions = {}): Router {
  const router = Router();
const routes = serve(router, "/devices");
  const store = () => options.store ?? devices();
  const authenticate = options.authenticateInstallation ?? hasValidSecret;
  const resolveOperator = options.resolveOperator ?? installationOperator;
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    next();
  });
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    handler: (request, response) => problem(request, response, 429, "device_rate_limited") }));
  router.use((request, response, next) => {
    if (["POST", "PUT", "PATCH"].includes(request.method) && !request.is("application/json")) {
      problem(request, response, 415, "json_required");
      return;
    }
    next();
  });
  const route = (action: (request: Request, response: Response) => void | Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) => {
      Promise.resolve().then(() => action(request, response)).catch(next);
    };
  const operator = async (request: Request, response: Response): Promise<number | null> => {
    if (!authenticate(request)) { problem(request, response, 401, "installation_credential_required"); return null; }
    const actorId = await resolveOperator();
    if (actorId === null || !Number.isSafeInteger(actorId) || actorId <= 0) {
      problem(request, response, 503, "installation_owner_unresolved");
      return null;
    }
    return actorId;
  };

  routes.route(devicesRoutes.requestPairing, route((request, response) => {
    const input = devicesRoutes.requestPairing.body.safeParse(request.body);
    if (!input.success) { problem(request, response, 400, "invalid_pairing_request"); return; }
    const source = request.ip;
    if (!source) { problem(request, response, 400, "pairing_source_unavailable"); return; }
    response.status(201).json(PairingRequestSchema.parse(store().request(input.data, source)));
  }));
  routes.route(devicesRoutes.claimPairing, route((request, response) => {
    const input = devicesRoutes.claimPairing.body.safeParse(request.body);
    if (!input.success) { problem(request, response, 400, "invalid_claim_request"); return; }
    const claim = PairingClaimSchema.parse(store().claim(input.data.pollToken));
    const status = claim.status === "pending" ? 202 : claim.status === "rejected" ? 403 : claim.status === "authorized" ? 200 : 410;
    response.status(status).json(claim);
  }));
  routes.route(devicesRoutes.pendingPairings, route(async (request, response) => {
    if (await operator(request, response) === null) return;
    response.json(PendingPairingsResponseSchema.parse({ requests: store().pending() }));
  }));
  routes.route(devicesRoutes.authorizePairing, route(async (request, response) => {
    const actorId = await operator(request, response);
    if (actorId === null) return;
    const input = devicesRoutes.authorizePairing.body.safeParse(request.body);
    if (!input.success) { problem(request, response, 400, "invalid_authorization_request"); return; }
    response.json(PairingAuthorizeResponseSchema.parse(store().authorize(input.data.code, actorId, input.data.grant)));
  }));
  routes.route(devicesRoutes.listDevices, route(async (request, response) => {
    const actorId = await operator(request, response);
    if (actorId === null) return;
    response.json(DeviceListResponseSchema.parse({ devices: store().list(actorId) }));
  }));
  routes.route(devicesRoutes.revokeDevice, route(async (request, response) => {
    const actorId = await operator(request, response);
    if (actorId === null) return;
    const id = DeviceIdSchema.safeParse(request.params.id);
    if (!id.success) { problem(request, response, 400, "invalid_device_id"); return; }
    if (!store().revoke(actorId, id.data)) { problem(request, response, 404, "device_not_found"); return; }
    response.json(DeviceRevokeResponseSchema.parse({ revoked: true }));
  }));
  router.post("/verify", route(async (request, response) => {
    if (await operator(request, response) === null) return;
    const input = DeviceVerifyInputSchema.safeParse(request.body);
    if (!input.success) { problem(request, response, 400, "invalid_verification_request"); return; }
    const principal = store().verify(input.data.token);
    if (!principal) { problem(request, response, 401, "invalid_device_credential"); return; }
    response.json(DeviceVerifyResponseSchema.parse({ principal }));
  }));
  router.use((request, response) => problem(request, response, 404, "device_route_not_found"));
  router.use(deviceErrors);
  return router;
}
