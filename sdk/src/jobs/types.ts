import { z } from "zod";
import { OneOffStatusSchema } from "../schedules/types.js";

/**
 * Wire contract of /api/v1/jobs — run a bag's job (`jobs:` in bag.yaml) and
 * read how it went.
 *
 * Every job run is a one-off in the scheduler (`sch_…`), whatever does the
 * work: a code job runs in the scheduler's process, an action job runs its
 * action in the API. So a run is durable once accepted, deduplicated by `key`,
 * and run at least once.
 *
 * camelCase, mounted before the API's contract middleware for the reason
 * schedules is: `inputs` are the caller's own values and must not be
 * re-cased.
 */

export const JobRunRequestSchema = z.strictObject({
  /** Checked against the job's input_schema now, and again when it runs. */
  inputs: z.record(z.string(), z.unknown()).optional(),
  /**
   * Idempotency key, unique per bag: a repeated request returns the run it
   * created. Also what the job sees as BARRY_JOB_KEY, stable across retries.
   */
  key: z.string().min(1).max(200).optional(),
  /** The run's bound in seconds. Absent: the job's own `timeout`, else ten minutes. */
  timeoutS: z.int().min(1).max(3600).optional(),
  /**
   * The session asking. A session-started run gets no declared secrets and
   * only what that session may do itself; absent, the job runs with its
   * bag's authority. See the jobs route for how far this is enforced.
   */
  callerSessionId: z.string().min(1).optional(),
  /** Hold the response until the run ends or this many seconds pass. */
  waitS: z.int().min(1).max(600).optional(),
});

export const JobRunSchema = z.object({
  /** The run's one-off id, `sch_…`. */
  id: z.string(),
  /** The job, `bag:name[@version]`. */
  job: z.string(),
  status: OneOffStatusSchema,
  reason: z.string().nullable(),
  key: z.string().nullable(),
  callerSessionId: z.string().nullable(),
  /** Attempts started so far. */
  attempts: z.int().nonnegative(),
  /** The action run of the latest attempt, when it made one. */
  runId: z.string().nullable(),
  /** That run's output: JSON text when the job declares an output_schema, else stdout's tail. */
  output: z.string().nullable(),
  outputType: z.enum(["json", "text"]).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const JobRunResponseSchema = z.object({ run: JobRunSchema }).strict();
export const JobRunCancelResponseSchema = z.object({
  id: z.string(),
  cancelled: z.boolean(),
  status: OneOffStatusSchema,
  cancelRequested: z.boolean().optional(),
}).strict();

export type JobRunRequest = z.infer<typeof JobRunRequestSchema>;
export type JobRunRecord = z.infer<typeof JobRunSchema>;
