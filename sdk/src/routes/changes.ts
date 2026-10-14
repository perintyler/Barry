import { z } from "zod";
import { route } from "./route.js";

const OpaqueEntity = z.record(z.string(), z.unknown());

const ChangeListResponse = z.object({ changes: z.array(OpaqueEntity) }).strict();
const ChangeResponse = z.object({ change: OpaqueEntity }).strict();
const ChangeStatsResponse = z.object({ stats: OpaqueEntity }).strict();
export const SessionChangesResponseSchema = z.object({ changes: z.array(z.object({ id: z.int(), sessionId: z.string(), filePath: z.string(), tool: z.string().nullable(), diff: z.string().nullable(), sizeBytes: z.int().nullable(), createdAt: z.string() }).strict()) }).strict();

export const changesRoutes = {
  listChanges: route({ method: "get", path: "/changes", operationId: "listChanges", responses: { 200: ChangeListResponse } }),
  getChangeStats: route({ method: "get", path: "/changes/stats", operationId: "getChangeStats", responses: { 200: ChangeStatsResponse } }),
  listSessionChanges: route({ method: "get", path: "/changes/session/{sessionId}", operationId: "listSessionChanges", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionChangesResponseSchema } }),
  listFileChanges: route({ method: "get", path: "/changes/file", operationId: "listFileChanges", responses: { 200: ChangeListResponse } }),
  getChange: route({ method: "get", path: "/changes/{changeId}", operationId: "getChange", params: z.object({ "changeId": z.string() }), responses: { 200: ChangeResponse } }),
};

export const changesComponents = {
  ChangeListResponse: ChangeListResponse,
  ChangeResponse: ChangeResponse,
  ChangeStatsResponse: ChangeStatsResponse,
  SessionChangesResponse: SessionChangesResponseSchema,
};
