import { z } from "zod";
import { BeginBodySchema, RunActionBodySchema, ActionExecutionResponseSchema, ActionJobPendingResponseSchema, ActionRunSummarySchema, ActionBeginResponseSchema, ActionRunResponseSchema } from "../actions/types.js";
import { route } from "./route.js";
import { ActionCatalogResponseSchema, ActionRunRecordSchema, ActionRunListResponseSchema, TriggerBodySchema, ActionTriggerResponseSchema } from "../actions/types.js";

export const actionsRoutes = {
  beginAction: route({ method: "post", path: "/actions/{name}/begin", operationId: "beginAction", body: BeginBodySchema, responses: { 201: ActionBeginResponseSchema } }),
  runAction: route({ method: "post", path: "/actions/{name}/run", operationId: "runAction", body: RunActionBodySchema, responses: { 200: ActionExecutionResponseSchema, 202: ActionJobPendingResponseSchema } }),
  listActionRuns: route({ method: "get", path: "/actions/runs", operationId: "listActionRuns", query: z.object({ "session_id": z.string().optional(), "schedule_id": z.string().optional(), "action": z.string().optional(), "status": z.enum(["started", "complete", "failed"]).optional(), "trigger": z.enum(["session", "api", "cli", "schedule", "job"]).optional(), "limit": z.number().int().min(1).max(200).optional() }), responses: { 200: ActionRunListResponseSchema } }),
  getActionRun: route({ method: "get", path: "/actions/runs/{runId}", operationId: "getActionRun", params: z.object({ "runId": z.string() }), responses: { 200: ActionRunRecordSchema } }),
  listActionCatalog: route({ method: "get", path: "/actions/catalog", operationId: "listActionCatalog", params: z.object({ session_id: z.string().optional() }), query: z.object({ session_id: z.string().optional() }), responses: { 200: ActionCatalogResponseSchema } }),
  triggerAction: route({ method: "post", path: "/actions/trigger", operationId: "triggerAction", body: TriggerBodySchema, responses: { 201: ActionTriggerResponseSchema } }),
};

export const actionsComponents = {
  ActionExecutionResponse: ActionExecutionResponseSchema, ActionJobPendingResponse: ActionJobPendingResponseSchema,
  ActionRunSummary: ActionRunSummarySchema,
  BeginActionRequest: BeginBodySchema, RunActionRequest: RunActionBodySchema, ActionBeginResponse: ActionBeginResponseSchema, ActionRunResponse: ActionRunResponseSchema,
  ActionCatalogResponse: ActionCatalogResponseSchema,
  ActionRunDetail: ActionRunRecordSchema,
  ActionRunListResponse: ActionRunListResponseSchema,
  TriggerActionRequest: TriggerBodySchema,
  TriggerActionResponse: ActionTriggerResponseSchema,
};
