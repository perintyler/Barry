/**
 * The identities service: identity, trait and bound management.
 *
 * Split out of bags/sessions/api, which had grown to carry both session lifecycle and
 * identity administration — two surfaces with different shapes of traffic and
 * almost no shared code. Measured before the split: of ~19 local modules in
 * that server, exactly three were used by both halves, and all three are now in
 * shared packages.
 *
 * What it deliberately does NOT have, compared to the session service: no
 * websocket server, no session runtime, no crashed-session sweep, no
 * summarizer, no TTL cleanup. Identity administration is request/response, so
 * its boot is a fraction of the other's.
 */
import { applyAuth, applyBaseMiddleware, createErrorLogger, createRequestLogger, servedRoutes } from "@barry-rocks/sdk/services/http";
import express from "express";
import { boundsRouter } from "../../src/bounds.js";
import { createDeviceRouter, deviceErrors } from "../../src/device-routes.js";
import { createIdentitiesRouter } from "../../src/identities.js";
import { identityRequestAuthorization } from "../../src/request-authorization.js";
import { traitsRouter } from "../../src/traits.js";



export function identitiesApi() {
  const app = express();
  const apiV1 = express.Router();
  applyBaseMiddleware(app);
  app.use(createRequestLogger("barry-identities", { skip: (req) => req.path === "/health" }));

  /**
   * Liveness, before auth and with no I/O.
   *
   * Deliberately does NOT probe the database: this answers "is the process up",
   * and a health check that goes red because the database blinked would have launchd
   * restart a service that was working fine.
   */
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "barry-identities", uptime: Math.floor(process.uptime()) });
  });

  const devices = createDeviceRouter();
  app.use("/api/v1/devices", devices);
  // Body-parser errors occur before routing and must also avoid echoing credential text.
  app.use("/api/v1/devices", deviceErrors);

  applyAuth(app, identityRequestAuthorization());

  // Deleting an identity takes its sessions with it; the sessions bag is named
  // here, at the composition root, so the identities bag does not depend on it.
  const identityRoutes = createIdentitiesRouter();
  apiV1.use("/identities", identityRoutes);
  apiV1.use("/traits", traitsRouter);
  apiV1.use("/bounds", boundsRouter);

  apiV1.use((req, res) => {
    res.status(404).type("application/problem+json").json({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: `No route for ${req.method} ${req.originalUrl}`,
      instance: req.originalUrl,
    });
  });
  app.use("/api/v1", apiV1);
  app.use(createErrorLogger("barry-identities"));

  return { app, routes: [devices, identityRoutes, traitsRouter, boundsRouter].flatMap(router => servedRoutes(router)) };
}
