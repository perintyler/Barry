import { z } from "zod";

/**
 * Wire contract of /api/v1/schedules/once — an action run once, later. See
 * bags/schedules/README.md for what each field guarantees.
 *
 * camelCase, but the router is mounted before the API's contract middleware:
 * that middleware camelCases response keys recursively, and `inputs` are the
 * caller's own values, which must come back exactly as they were given.
 */

export const OneOffStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled", "uncertain"]);
export const OneOffAttemptOutcomeSchema = z.enum(["running", "succeeded", "failed", "timed_out", "abandoned"]);

export const OneOffRequestSchema = z.strictObject({
  /** A declared action, `bag:name`. */
  action: z.string().regex(/^[^:]+:.+$/, "a declared action, bag:name"),
  identity: z.string().optional(),
  traits: z.array(z.string()).optional(),
  bounds: z.array(z.string()).optional(),
  dueAt: z.iso.datetime(),
  /** Checked against the action's input_schema now and again when it runs. */
  inputs: z.record(z.string(), z.unknown()).optional(),
  /** Unique per bag: a repeated request returns the schedule it created. */
  idempotencyKey: z.string().min(1).max(200).optional(),
  timeoutS: z.int().min(1).max(3600).optional(),
  /** Opt-in retry of a failing run. Absent means one attempt. */
  retry: z.strictObject({ attempts: z.int().min(1).max(5) }).optional(),
});

export const OneOffAttemptSchema = z.object({
  id: z.string(),
  number: z.int().positive(),
  /** The action run this attempt produced. */
  runId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  outcome: OneOffAttemptOutcomeSchema,
  exitCode: z.int().nullable(),
}).strict();

export const OneOffSchema = z.object({
  id: z.string(),
  bag: z.string(),
  action: z.string().nullable(),
  job: z.string().nullable().optional(),
  permissions: z.object({ identity: z.string().optional(), traits: z.array(z.string()).optional(), bounds: z.array(z.string()).optional() }).optional(),
  inputs: z.record(z.string(), z.unknown()),
  dueAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  status: OneOffStatusSchema,
  reason: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  timeoutS: z.int(),
  retryAttempts: z.int(),
  failures: z.int().nonnegative(),
  recoveries: z.int().nonnegative(),
  attempts: z.array(OneOffAttemptSchema).optional(),
}).strict();

export const OneOffResponseSchema = z.object({ schedule: OneOffSchema }).strict();
export const OneOffListResponseSchema = z.object({ schedules: z.array(OneOffSchema) }).strict();
/** `cancelRequested`: it was running, so it was asked to stop and will end `cancelled`. */
export const OneOffCancelResponseSchema = z.object({ cancelled: z.boolean(), status: OneOffStatusSchema, cancelRequested: z.boolean().optional() }).strict();

export type OneOffRequest = z.infer<typeof OneOffRequestSchema>;
export type OneOffRecord = z.infer<typeof OneOffSchema>;

/** The recurring schedules route still answers in snake_case. */
export const ScheduleSummarySchema = z.object({
  id: z.string(),
  trigger: z.string(),
  action: z.string(),
  job: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean(),
  paused: z.boolean(),
  next_fire_at: z.iso.datetime().nullable(),
  last_fired_at: z.iso.datetime().nullable(),
  last_status: z.string().nullable(),
  last_summary: z.string().nullable(),
  last_run_id: z.string().nullable(),
  consecutive_failures: z.int().nonnegative(),
  skipped_fires: z.int().nonnegative(),
  missed_fires: z.int().nonnegative(),
}).strict();

export const ScheduleListResponseSchema = z.object({
  scheduler: z.object({
    status: z.enum(["ok", "degraded", "down"]),
    reason: z.string().optional(),
    heartbeat_at: z.iso.datetime().nullable(),
  }).strict(),
  load_errors: z.array(z.string()).default([]),
  schedules: z.array(ScheduleSummarySchema),
}).strict();
