import { eventsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { createLogger } from "@barry-rocks/sdk/logging";
import type { Request, Response } from "express";
import { Router } from "express";
import { hookCounters } from "./dispatch.js";
import { decodeEventCursor, encodeEventCursor, serializeEvent } from "./domain.js";
import { Events } from "./store.js";

const log = createLogger("barry-server");

/**
 * Validate a request body, answering RFC-7807 on failure.
 *
 * Inlined rather than imported from the API server: this bag owns its routes
 * and must not reach back into `bags/sessions/api` — that is the dependency the move
 * exists to remove. It is a `safeParse` and an error shape, so a shared package
 * for it would cost more than it saves.
 */
/**
 * Structurally typed rather than against `z.ZodType`: this bag's tools are on
 * zod 3 (what @barry-rocks/sdk/tools expects) while @barry-rocks/sdk/internal/routes is on
 * zod 4, and naming either version here makes the other unassignable. Both
 * expose `safeParse` with this shape, which is all the helper needs.
 */
interface BodySchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

function parseRequestBody<T>(req: Request, res: Response, schema: BodySchema<T>): T | undefined {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;

  res.status(400).type("application/problem+json").json({
    type: "about:blank",
    title: "Invalid request body",
    status: 400,
    detail: result.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`)
      .join("; "),
    instance: req.originalUrl,
  });
  return undefined;
}

export const eventsRouter = Router();
const routes = serve(eventsRouter, "/events", { casing: "camel" });

/**
 * How this router reaches the realtime bus.
 *
 * Injected by the API at startup rather than imported: the bus registry lives
 * in bags/sessions/api, and importing it here would rebuild the very dependency
 * moving these routes into the bag removed. Defaults to reaching nobody, which
 * is honest — an unwired router reports `queued: 0` rather than claiming
 * success.
 */
let publishEvent: (eventId: string) => number = () => 0;

export function setEventPublisher(publish: (eventId: string) => number): void {
  publishEvent = publish;
}

routes.route(eventsRoutes.listEvents, async (req, res) => {
  try {
    const { type, sessionId, severity, unread, since, limit: limitStr, cursor } = req.query as Record<string, string | undefined>;

    const limit = Math.min(Math.max(Number(limitStr) || 50, 1), 100);
    const before = cursor ? decodeEventCursor(cursor) : undefined;

    const events = await Events.list({
      type: type || undefined,
      sessionId: sessionId || undefined,
      severity: severity || undefined,
      unreadOnly: unread === "true",
      since: since || undefined,
      limit: limit + 1, // fetch one extra for cursor
      before: before ?? undefined,
    });

    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    const nextCursor = hasMore ? encodeEventCursor(page[page.length - 1]) : null;

    res.json({
      ok: true,
      events: page.map(serializeEvent),
      nextCursor,
    });
  } catch (err) {
    log.error("events.list_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to list events" });
  }
});

routes.route(eventsRoutes.createEvent, async (req, res) => {
  try {
    const body = parseRequestBody(req, res, eventsRoutes.createEvent.body);
    if (!body) return;

    const event = await Events.create({
      type: body.type,
      session_id: body.sessionId ?? null,
      source: body.source ?? "api",
      title: body.title,
      body: body.body ?? null,
      severity: body.severity ?? "info",
      data: body.data ?? {},
      metadata: body.metadata ?? {},
    });

    res.status(201).json({ ok: true, event: serializeEvent(event) });
  } catch (err) {
    log.error("events.create_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to create event" });
  }
});


// POST /:eventId/announce — publish an existing event to the realtime bus.
//
// The cross-process half: the CLI, the MCP server and the launchd jobs write
// the store directly and cannot reach the API's in-memory sockets. They call
// this instead.
//
// The event is looked up rather than trusted, so an id that was never written
// cannot put a phantom on the bus. `queued` is the real subscriber count,
// not a boolean — a signal that reached nobody is worth being able to see.
eventsRouter.post("/:eventId/announce", async (req, res) => {
  try {
    const event = await Events.get(req.params.eventId);
    if (!event) {
      res.status(404).json({ ok: false, error: "Event not found" });
      return;
    }
    const queued = publishEvent(event.id);
    res.json({ ok: true, queued });
  } catch (err) {
    log.error("events.announce_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to announce event" });
  }
});

routes.route(eventsRoutes.getUnreadEventCount, async (_req, res) => {
  try {
    const count = await Events.getUnreadCount();
    res.json({ ok: true, count });
  } catch (err) {
    log.error("events.unread_count_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to get unread count" });
  }
});

/**
 * GET /hook-counters — what the record-hook seam has done since startup.
 *
 * Exists to be PULLED by the telemetry bag's collector. metrics.db has a single
 * writer by design, so this process must not write it directly; exposing
 * numbers and letting the collector scrape them on its own tick is the same
 * shape that bag already uses for Ollama.
 *
 * `dispatches` counts every event, including ones no bag hooked. That is what
 * makes silence here mean "the seam is dead" rather than "nobody subscribes".
 */
eventsRouter.get("/hook-counters", (_req, res) => {
  res.json({ ok: true, ...hookCounters() });
});

routes.route(eventsRoutes.markEventRead, async (req, res) => {
  try {
    await Events.markRead(req.params.eventId);
    res.json({ ok: true });
  } catch (err) {
    log.error("events.mark_read_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to mark event as read" });
  }
});

routes.route(eventsRoutes.markAllEventsRead, async (req, res) => {
  try {
    const { type } = (req.body ?? {}) as { type?: string };
    const count = await Events.markAllRead(type ? { type } : undefined);
    res.json({ ok: true, count });
  } catch (err) {
    log.error("events.mark_all_read_failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to mark events as read" });
  }
});
