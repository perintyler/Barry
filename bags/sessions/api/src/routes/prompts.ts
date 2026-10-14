/**
 * The delivery routes every process other than this one calls
 * (`@barry-rocks/sessions-bag/client`'s `waitForPrompts`, `registerListener`,
 * `unregisterListener`, `getListeners`, `recordWake`), answered from this
 * process's delivery state (`../delivery.ts`).
 *
 * Mounted ahead of the v1 contract middleware: the client reads these bodies
 * as they are written here, and a guarantees map is keyed by session id, which
 * camelCasing would rewrite.
 */

import { serve } from "@barry-rocks/sdk/services/http";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { Router } from "express";
import { z } from "zod";
import { isDeliveryGuarantee, isListenerKind } from "@barry-rocks/sessions-bag/delivery";
import type { DeliveryHost } from "../delivery.js";

/** The longest a wait may block; a surface re-registers and waits again each time round. */
const WAIT_TIMEOUT_MS = 25_000;

const SessionId = z.string().min(1).max(500);
const WaitRequest = z.strictObject({
  sessionIds: z.array(SessionId).max(100),
  timeoutMs: z.number().int().positive().max(WAIT_TIMEOUT_MS).optional(),
});

export function promptsRouter(delivery: DeliveryHost): Router {
  const router = Router();
  const routes = serve(router, "/prompts", { casing: "verbatim" });

  /**
   * Long-poll for a pending prompt.
   *
   * PEEK ONLY — a waiter is told a prompt exists, and drains it with
   * `popPrompts`. Draining here would make the wait itself the delivery, and a
   * caller whose request died in flight would take the message with it.
   */
  router.post("/wait", async (req, res, next) => {
    const input = WaitRequest.safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: "Invalid prompt wait request" });
    // A caller that hangs up stops the wait rather than leaving it parked.
    const gone = new AbortController();
    res.once("close", () => gone.abort());
    try {
      const ready = await delivery.waitForPrompts(input.data.sessionIds, input.data.timeoutMs ?? WAIT_TIMEOUT_MS, gone.signal);
      if (!res.destroyed && !res.writableEnded) res.json({ ready });
    } catch (error) {
      next(error);
    }
  });

  /**
   * A delivery surface reporting that it is alive and what it can promise, or
   * (`active: false`) that it has gone. This is how a sender is told what will
   * happen to a message from observation rather than from an adapter's name.
   */
  router.post("/listeners", async (req, res, next) => {
    const { sessionId, kind, guarantee, active } = req.body ?? {};
    if (typeof sessionId !== "string" || !SessionId.safeParse(sessionId).success || !isListenerKind(kind)) {
      return res.status(400).json({ ok: false, error: "sessionId and a known listener kind are required" });
    }
    try {
      if (active === false) {
        await delivery.unregisterListener(sessionId, kind);
      } else {
        // Refused rather than defaulted: a surface recorded with a guarantee it
        // never claimed would have a sender told a promise no one made.
        if (!isDeliveryGuarantee(guarantee)) {
          return res.status(400).json({ ok: false, error: `unknown delivery guarantee: ${String(guarantee)}` });
        }
        await delivery.registerListener(sessionId, kind, guarantee);
      }
      const listeners = await delivery.getListeners([sessionId]);
      res.json({ ok: true, guarantee: listeners[sessionId]?.guarantee ?? "none" });
    } catch (error) {
      next(error);
    }
  });

  /** What the live surfaces for these sessions can promise right now. */
  routes.post(sessionsRoutes.listDeliveryGuarantees, async (req, res, next) => {
    const input = sessionsRoutes.listDeliveryGuarantees.body.safeParse(req.body);
    if (!input.success) return res.status(400).json({ ok: false, error: "Invalid sessionIds" });
    try {
      res.json({ guarantees: await delivery.getListeners(input.data.sessionIds) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Ask whether a wake is within budget, and consume it if so (`consume:
   * false` only asks).
   */
  router.post("/wake-budget", async (req, res, next) => {
    const { sessionId, fromSession, consume } = req.body ?? {};
    if (typeof sessionId !== "string" || !SessionId.safeParse(sessionId).success) {
      return res.status(400).json({ ok: false, error: "sessionId is required" });
    }
    const sender = typeof fromSession === "string" ? fromSession : undefined;
    try {
      res.json(consume === false ? delivery.checkWake(sessionId, sender) : await delivery.recordWake(sessionId, sender));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
