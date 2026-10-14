import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { Router } from "express";
import { getSessionRecord } from "../db.js";
import { buildSessionChangesPage } from "../session-changes-page.js";

/** Serve the session diff viewer; git mutations belong to git tools and session worktree lifecycle routes. */
export const sessionChangesRouter = Router();
const routes = serve(sessionChangesRouter, "/sessions", { casing: "camel" });

routes.route(sessionsRoutes.getSessionChangeSummary, async (req, res) => {
  try {
    const record = await getSessionRecord(req.params.sessionId);
    if (!record) return res.status(404).send("Session not found");

    const sessionName = record.metadata?.name || record.system_prompt?.slice(0, 60) || req.params.sessionId.slice(0, 8);
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.type("html").send(buildSessionChangesPage(req.params.sessionId, sessionName));
  } catch (error) {
    res.status(500).send("Error: " + (error as Error).message);
  }
});
