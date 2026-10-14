import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { Router } from "express";
import { hostname, userInfo } from "os";
import { getActiveSessions } from "../db.js";

export const statusRouter = Router();
const routes = serve(statusRouter, "/status", { casing: "camel" });

routes.route(sessionsRoutes.getStatus, async (_req, res) => {
  try {
    const activeSessions = await getActiveSessions();
    res.json({
      ok: true,
      hostname: hostname(),
      user: userInfo().username,
      activeSessions: activeSessions.length,
      uptime: process.uptime(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});
