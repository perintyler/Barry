import { z } from "zod";
import { ScheduleListResponseSchema, OneOffRequestSchema, OneOffResponseSchema, OneOffListResponseSchema, OneOffCancelResponseSchema, OneOffStatusSchema } from "../schedules/types.js";
import { route } from "./route.js";

export const schedulesRoutes = {
  listSchedules: route({ method: "get", path: "/schedules", operationId: "listSchedules", responses: { 200: ScheduleListResponseSchema } }),
  createOneOffSchedule: route({ method: "post", path: "/schedules/once", operationId: "createOneOffSchedule", body: OneOffRequestSchema, responses: { 200: OneOffResponseSchema, 201: OneOffResponseSchema } }),
  listOneOffSchedules: route({ method: "get", path: "/schedules/once", operationId: "listOneOffSchedules", query: z.object({ bag: z.string().optional(), status: OneOffStatusSchema.optional(), limit: z.number().int().min(1).max(200).optional() }), responses: { 200: OneOffListResponseSchema } }),
  getOneOffSchedule: route({ method: "get", path: "/schedules/once/{id}", operationId: "getOneOffSchedule", responses: { 200: OneOffResponseSchema } }),
  cancelOneOffSchedule: route({ method: "post", path: "/schedules/once/{id}/cancel", operationId: "cancelOneOffSchedule", responses: { 200: OneOffCancelResponseSchema } }),
};

export const schedulesComponents = { ScheduleListResponse: ScheduleListResponseSchema, OneOffRequest: OneOffRequestSchema, OneOffResponse: OneOffResponseSchema, OneOffListResponse: OneOffListResponseSchema, OneOffCancelResponse: OneOffCancelResponseSchema };
