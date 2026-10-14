import { createLogger } from "@barry-rocks/sdk/logging";
import { identitiesRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { Router } from "express";
import { bounds } from "./operations/bounds.js";
import { InvalidBoundError } from "./config/bounds.js";

const log = createLogger("barry-server");
export const boundsRouter = Router();
const routes = serve(boundsRouter, "/bounds");

routes.route(identitiesRoutes.listBounds, async (_req, res) => {
  try { res.json({ bounds: await bounds.list() }); }
  catch (error) {
    log.error("bounds.list_failed", { error: String(error) });
    res.status(500).json({ ok: false, error: "Failed to list bounds" });
  }
});

routes.route(identitiesRoutes.createBound, async (req, res) => {
  const parsed = identitiesRoutes.createBound.body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.message }); return; }
  const { name, description, ...bound } = parsed.data;
  try {
    if (await bounds.get({ name })) { res.status(409).json({ ok: false, error: `Bound "${name}" already exists` }); return; }
    await bounds.create({ name, description: description ?? null, bound });
    res.status(201).json({ ok: true, bound: await bounds.get({ name }) });
  } catch (error) {
    res.status(error instanceof InvalidBoundError ? 400 : 500).json({ ok: false, error: String(error) });
  }
});

routes.route(identitiesRoutes.updateBound, async (req, res) => {
  const name = req.params.name;
  const parsed = identitiesRoutes.updateBound.body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.message }); return; }
  try {
    if (bounds.shipped().some(bound => bound.name === name)) { res.status(409).json({ ok: false, error: `Bound "${name}" is defined in the base identity's identity.yaml` }); return; }
    const existing = (await bounds.stored()).find(bound => bound.name === name);
    if (!existing) { res.status(404).json({ ok: false, error: "Bound not found" }); return; }
    const { description, ...rules } = parsed.data;
    await bounds.upsert({ name, description: description ?? existing.description, bound: { ...existing.bound, ...rules } });
    res.json({ ok: true, bound: await bounds.get({ name }) });
  } catch (error) {
    res.status(error instanceof InvalidBoundError ? 400 : 500).json({ ok: false, error: String(error) });
  }
});
