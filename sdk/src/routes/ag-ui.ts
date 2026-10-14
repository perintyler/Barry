import { z } from "zod";
import { route } from "./route.js";
import { RunAgentInputSchema as AgUiRunAgentInputSchema } from "@ag-ui/core/schemas";
import { PublicSessionSnapshotSchema as AgUiSessionSnapshotSchema, PublicTurnSchema as BarryTurnSchema } from "../apps/wire.js";

const AgUiQueuedTurnSchema = z.object({ id: z.string(), state: z.literal("queued") }).strict();

export const aguiRoutes = {
  getAgUiSession: route({ method: "get", path: "/api/v2/sessions/{sessionId}", operationId: "getAgUiSession", params: z.object({ "sessionId": z.string() }), responses: { 200: AgUiSessionSnapshotSchema } }),
  runAgUiAgent: route({ method: "post", path: "/api/v2/sessions/{sessionId}/ag-ui", operationId: "runAgUiAgent", params: z.object({ "sessionId": z.string() }), body: AgUiRunAgentInputSchema, stream: true, responses: { 200: null, 202: AgUiQueuedTurnSchema } }),
  subscribeAgUiEvents: route({ method: "get", path: "/api/v2/sessions/{sessionId}/events", operationId: "subscribeAgUiEvents", params: z.object({ "sessionId": z.string() }), query: z.object({ "after": z.string().optional() }), stream: true, responses: { 200: null } }),
  cancelBarryTurn: route({ method: "post", path: "/api/v2/sessions/{sessionId}/turns/{turnId}/cancel", operationId: "cancelBarryTurn", params: z.object({ "sessionId": z.string(), "turnId": z.string() }), responses: { 200: BarryTurnSchema } }),
};

export const aguiComponents = {
  AgUiQueuedTurn: AgUiQueuedTurnSchema,
  AgUiRunAgentInput: AgUiRunAgentInputSchema,
  AgUiSessionSnapshot: AgUiSessionSnapshotSchema,
  BarryTurn: BarryTurnSchema,
};
