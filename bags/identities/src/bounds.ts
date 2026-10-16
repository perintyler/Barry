import { createLogger } from "@barry-rocks/sdk/logging";
import { identitiesRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { Router } from "express";
import { bounds } from "./operations/bounds.js";

const log = createLogger("barry-server");
export const boundsRouter = Router();
const routes = serve(boundsRouter, "/bounds");

routes.route(identitiesRoutes.listBounds, async (_req, res) => {
  try {
    res.json({ bounds: await bounds.list() });
  } catch (error) {
    log.error("bounds.list_failed", { error: String(error) });
    res.status(500).json({ ok: false, error: "Failed to list bounds" });
  }
});
