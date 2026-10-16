import { z } from "zod";
import { ActionWorkIdSchema, ActionWorkSessionsSchema, ActionWorkItemSchema, ActionWorkResultSchema, ActionWorkStopAckSchema, ActionWorkflowStartSchema, ActionWorkflowAdmissionAckSchema, ActionWorkflowStopSchema, ActionWorkflowStopAckSchema } from "../actions/types.js";
import { BeginBodySchema, RunActionBodySchema, ActionExecutionResponseSchema, ActionJobPendingResponseSchema, ActionRunSummarySchema, ActionBeginResponseSchema, ActionRunResponseSchema } from "../actions/types.js";
import { route } from "./route.js";
import { ActionCatalogResponseSchema, ActionRunRecordSchema, ActionRunListResponseSchema, TriggerBodySchema, ActionTriggerResponseSchema } from "../actions/types.js";

export const actionsRoutes = {
  listWorkflowWorkSessions: route({ method: "get", path: "/actions/work-sessions", operationId: "listWorkflowWorkSessions", query: z.strictObject({}), responses: { 200: ActionWorkSessionsSchema } }),
  getWorkflowWorkCatalog: route({ method: "get", path: "/actions/work-catalog", operationId: "getWorkflowWorkCatalog", query: z.object({ session_id: z.string().min(1).max(200) }), responses: { 200: ActionCatalogResponseSchema } }),
  getSessionWorkflowWork: route({ method: "get", path: "/actions/work-items/{id}", operationId: "getSessionWorkflowWork", params: z.object({ id: ActionWorkIdSchema }), query: z.object({ session_id: z.string().min(1).max(200) }), responses: { 200: ActionWorkItemSchema } }),
  getSessionWorkflowWorkResult: route({ method: "get", path: "/actions/work-items/{id}/result", operationId: "getSessionWorkflowWorkResult", params: z.object({ id: ActionWorkIdSchema }), query: z.object({ session_id: z.string().min(1).max(200) }), responses: { 200: ActionWorkResultSchema } }),
  stopSessionWorkflowWork: route({ method: "post", path: "/actions/work-items/{id}/stop", operationId: "stopSessionWorkflowWork", params: z.object({ id: ActionWorkIdSchema }), query: z.object({ session_id: z.string().min(1).max(200) }), body: ActionWorkflowStopSchema, responses: { 202: ActionWorkStopAckSchema } }),
  startSessionWorkflowAction: route({ method: "post", path: "/actions/{name}/work-start", operationId: "startSessionWorkflowAction", params: z.object({ name: z.string().min(1).max(200).regex(/^[^:@]+:[^:@]+$/) }), query: z.object({ session_id: z.string().min(1).max(200) }), body: ActionWorkflowStartSchema, responses: { 200: ActionWorkflowAdmissionAckSchema, 201: ActionWorkflowAdmissionAckSchema } }),
  startSessionWorkflowAgentAction: route({ method: "post", path: "/actions/{name}/work-start-agent", operationId: "startSessionWorkflowAgentAction", params: z.object({ name: z.string().min(1).max(200).regex(/^[^:@]+:[^:@]+$/) }), query: z.object({ session_id: z.string().min(1).max(200) }), body: ActionWorkflowStartSchema, responses: { 200: ActionWorkflowAdmissionAckSchema, 201: ActionWorkflowAdmissionAckSchema } }),
  lookupSessionWorkflowAction: route({ method: "get", path: "/actions/work-operations/{key}", operationId: "lookupSessionWorkflowAction", params: z.object({ key: z.string().min(1).max(200) }), query: z.object({ session_id: z.string().min(1).max(200) }), responses: { 200: ActionWorkflowAdmissionAckSchema } }),
  stopSessionWorkflowAction: route({ method: "post", path: "/actions/runs/{id}/work-stop", operationId: "stopSessionWorkflowAction", params: z.object({ id: z.string() }), query: z.object({ session_id: z.string().min(1).max(500) }), body: ActionWorkflowStopSchema, responses: { 202: ActionWorkflowStopAckSchema } }),
  stopWorkflowAction: route({ method: "post", path: "/actions/runs/{id}/cancel", operationId: "stopWorkflowAction", params: z.object({ id: z.string() }), body: ActionWorkflowStopSchema, responses: { 202: ActionWorkflowStopAckSchema } }),
  beginAction: route({ method: "post", path: "/actions/{name}/begin", operationId: "beginAction", body: BeginBodySchema, responses: { 201: ActionBeginResponseSchema } }),
  runAction: route({ method: "post", path: "/actions/{name}/run", operationId: "runAction", body: RunActionBodySchema, responses: { 200: ActionExecutionResponseSchema, 202: ActionJobPendingResponseSchema } }),
  listActionRuns: route({ method: "get", path: "/actions/runs", operationId: "listActionRuns", query: z.object({ "session_id": z.string().optional(), "schedule_id": z.string().optional(), "action": z.string().optional(), "status": z.enum(["started", "complete", "failed"]).optional(), "trigger": z.enum(["session", "api", "cli", "schedule", "job"]).optional(), "limit": z.number().int().min(1).max(200).optional() }), responses: { 200: ActionRunListResponseSchema } }),
  getActionRun: route({ method: "get", path: "/actions/runs/{runId}", operationId: "getActionRun", params: z.object({ "runId": z.string() }), query: z.object({ session_id: z.string().min(1).max(500).optional() }), responses: { 200: ActionRunRecordSchema } }),
  listActions: route({ method: "get", path: "/actions/catalog", operationId: "listActions", params: z.object({ session_id: z.string().optional() }), query: z.object({ session_id: z.string().optional() }), responses: { 200: ActionCatalogResponseSchema } }),
  triggerAction: route({ method: "post", path: "/actions/trigger", operationId: "triggerAction", body: TriggerBodySchema, responses: { 201: ActionTriggerResponseSchema } }),
};

export const actionsComponents = {
  ActionWorkSessions: ActionWorkSessionsSchema, ActionWorkItem: ActionWorkItemSchema, ActionWorkResult: ActionWorkResultSchema, ActionWorkStopAck: ActionWorkStopAckSchema,
  ActionWorkflowStartRequest: ActionWorkflowStartSchema, ActionWorkflowAdmissionAck: ActionWorkflowAdmissionAckSchema,
  ActionWorkflowStopRequest: ActionWorkflowStopSchema, ActionWorkflowStopAck: ActionWorkflowStopAckSchema,
  ActionExecutionResponse: ActionExecutionResponseSchema, ActionJobPendingResponse: ActionJobPendingResponseSchema,
  ActionRunSummary: ActionRunSummarySchema,
  BeginActionRequest: BeginBodySchema, RunActionRequest: RunActionBodySchema, ActionBeginResponse: ActionBeginResponseSchema, ActionRunResponse: ActionRunResponseSchema,
  ActionCatalogResponse: ActionCatalogResponseSchema,
  ActionRunDetail: ActionRunRecordSchema,
  ActionRunListResponse: ActionRunListResponseSchema,
  TriggerActionRequest: TriggerBodySchema,
  TriggerActionResponse: ActionTriggerResponseSchema,
};
