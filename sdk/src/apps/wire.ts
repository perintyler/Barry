import { z } from "zod";
import { EventSchema, MessageSchema, RunAgentInputSchema } from "@ag-ui/core/schemas";
import { AgUiSubscriptionRequestSchema } from "./subscription.js";
import { ReviewPolicySchema } from "../sessions/continuations.js";

export const PublicTurnSchema = z.strictObject({
  id: z.string(), sessionId: z.string(), runId: z.string(),
  state: z.enum(["queued", "running", "waiting_for_input", "recovery_required", "completed", "failed", "cancelled"]),
  revision: z.int().positive(),
  reviewPolicy: ReviewPolicySchema,
  interrupts: z.array(z.strictObject({
    id: z.string(), runId: z.string(),
    call: z.strictObject({ id: z.string(), tool: z.string(), input: z.unknown(), description: z.string().optional() }),
    expiresAt: z.string().optional(), status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]),
  })),
  result: z.unknown().optional(), error: z.string().optional(),
});

export const PublicSessionSnapshotSchema = z.strictObject({
  threadId: z.string(), turn: PublicTurnSchema.nullable(), cursor: z.int().nonnegative(),
  messages: z.array(MessageSchema), protocolVersion: z.string(), appExtensionVersion: z.int().positive(), agUiPackageVersion: z.string(),
  capabilities: z.strictObject({ approvalContinuation: z.enum(["durable", "live", "unsupported"]), frontendTools: z.boolean(), approveWithEdits: z.boolean(), attachments: z.boolean(), replay: z.boolean() }),
});

/** Upstream owns AG-UI schemas; Apps owns only Barry's extensions. */
export function agUiContractSchemas(): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    AgUiRunAgentInput: RunAgentInputSchema, AgUiEvent: EventSchema,
    AgUiSessionSnapshot: PublicSessionSnapshotSchema, BarryTurn: PublicTurnSchema,
    AgUiSubscriptionRequest: AgUiSubscriptionRequestSchema,
  }).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" })]));
}
