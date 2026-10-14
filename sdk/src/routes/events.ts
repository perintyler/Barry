import { z } from "zod";
import { route } from "./route.js";
import { ActionAckSchema } from "../errors.js";
import { EventSchema, CreateEventRequestSchema, EventListResponseSchema, EventResponseSchema, EventUnreadCountResponseSchema } from "../events/index.js";

export const eventsRoutes = {
  listEvents: route({ method: "get", path: "/events", operationId: "listEvents", query: z.object({ type: z.string().optional(), sessionId: z.string().optional(), severity: z.string().optional(), unread: z.boolean().optional(), since: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() }), responses: { 200: EventListResponseSchema } }),
  createEvent: route({ method: "post", path: "/events", operationId: "createEvent", body: CreateEventRequestSchema, responses: { 201: EventResponseSchema } }),
  getUnreadEventCount: route({ method: "get", path: "/events/unread-count", operationId: "getUnreadEventCount", responses: { 200: EventUnreadCountResponseSchema } }),
  markEventRead: route({ method: "post", path: "/events/{eventId}/read", operationId: "markEventRead", params: z.object({ "eventId": z.string() }), responses: { 200: ActionAckSchema } }),
  markAllEventsRead: route({ method: "post", path: "/events/read-all", operationId: "markAllEventsRead", responses: { 200: ActionAckSchema } }),
};

export const eventsComponents = {
  Event: EventSchema,
  ActionAck: ActionAckSchema,
  CreateEventRequest: CreateEventRequestSchema,
  EventListResponse: EventListResponseSchema,
  EventResponse: EventResponseSchema,
  EventUnreadCountResponse: EventUnreadCountResponseSchema,
};
