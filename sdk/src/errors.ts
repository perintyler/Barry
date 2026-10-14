/**
 * What any Barry HTTP route may answer besides its own resource: a problem
 * (RFC 9457), a warning beside a success, or an acknowledgement with no body.
 */
import { z } from "zod";

export const ProblemDetailsSchema = z.object({
  type: z.string().default("about:blank"),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
}).strict();

/**
 * A non-fatal condition reported alongside a successful mutation — e.g. a bag
 * whose host binary is missing, or one declaring launchd services the API
 * deliberately does not register itself.
 */
export const ApiWarningSchema = z.object({
  kind: z.string(),
  bag: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
}).strict();

/** A success with nothing to return. */
export const ActionAckSchema = z.object({}).strict();

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
export type ApiWarning = z.infer<typeof ApiWarningSchema>;
