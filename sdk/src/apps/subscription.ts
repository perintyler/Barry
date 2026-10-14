import { z } from "zod";
import type { AgUiEvent } from "./ag-ui.js";
import type { PublicSessionSnapshot } from "./connection.js";

export const AgUiSubscriptionRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribe"), sessionId: z.string().min(1).max(512), after: z.string().regex(/^\d+(?::\d+)?$/).optional() }),
  z.strictObject({ type: z.literal("unsubscribe") }),
]);
export type AgUiSubscriptionRequest = z.infer<typeof AgUiSubscriptionRequestSchema>;
export type AgUiSubscriptionDelivery =
  | { type: "snapshot"; sessionId: string; snapshot: PublicSessionSnapshot }
  | { type: "event"; sessionId: string; cursor: string; event: AgUiEvent }
  | { type: "error"; message: string };
