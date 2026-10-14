import { Router, type RequestHandler } from "express";
import { Barry, BarryError, isBarryError, requestCaller } from "@barry-rocks/sdk";
import { servicesRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";

export function servicesRouter(): Router {
  const router = Router(), register = serve(router, "/services", { casing: "verbatim" });
  const handler = (operation: "list" | "get" | "start" | "stop" | "restart"): RequestHandler => (req, res) => {
    void (async () => {
      try {
        const key = req.params.key;
        if (operation !== "list" && (!/^[A-Za-z0-9._-]+$/.test(key) || key.includes("..")))
          throw new BarryError("invalid", "invalid service key");
        const asking = Barry.as(requestCaller(req.authPrincipal));
        res.json(operation === "list" ? { services: await asking.services() } : { service: await asking.service(key)[operation]() });
      } catch (error) {
        const status = isBarryError(error) ? error.status : 500;
        res.status(status).type("application/problem+json").json({ type: "about:blank", title: isBarryError(error) ? error.reason : "Service operation failed", status, detail: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
  register.get(servicesRoutes.listServices, handler("list"));
  register.get(servicesRoutes.getService, handler("get"));
  register.post(servicesRoutes.startService, handler("start"));
  register.post(servicesRoutes.stopService, handler("stop"));
  register.post(servicesRoutes.restartService, handler("restart"));
  return router;
}
