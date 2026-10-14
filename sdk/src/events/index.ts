/**
 * Events: what a session, a job or Barry itself announces (progress, a
 * finished task, an alert), as the events bag stores them and the API
 * serves them.
 */
import { z } from "zod";

export const EventTypeSchema = z.enum([
  "progress",
  "notification",
  "task_finished",
  "system_alert",
]);

export const EventSeveritySchema = z.enum(["info", "warn", "error", "success"]);

export const EventSchema = z.object({
  id: z.string(),
  type: EventTypeSchema,
  sessionId: z.string().nullable(),
  source: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  severity: EventSeveritySchema,
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  deliveredVia: z.array(z.string()),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
}).strict();

export const EventListResponseSchema = z.object({
  events: z.array(EventSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const CreateEventRequestSchema = z.object({
  type: EventTypeSchema,
  title: z.string().min(1).max(500),
  sessionId: z.string().optional(),
  source: z.string().optional(),
  body: z.string().max(10000).optional(),
  severity: EventSeveritySchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const EventResponseSchema = z.object({
  event: EventSchema,
}).strict();

export const EventUnreadCountResponseSchema = z.object({
  count: z.int().nonnegative(),
}).strict();

export type BarryEvent = z.infer<typeof EventSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

export { announce, setInProcessPublisher, type AnnounceResult, type InProcessPublisher, type AnnounceOptions } from "./bus.js";
