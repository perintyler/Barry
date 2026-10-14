import { z } from "zod";
import { route } from "./route.js";
import { JobRunCancelResponseSchema, JobRunRequestSchema, JobRunResponseSchema } from "../jobs/types.js";

export const jobsRoutes = {
  startJobRun: route({ method: "post", path: "/jobs/{ref}/runs", operationId: "startJobRun", params: z.object({ "ref": z.string() }), body: JobRunRequestSchema, responses: { 200: JobRunResponseSchema, 201: JobRunResponseSchema } }),
  getJobRun: route({ method: "get", path: "/jobs/runs/{id}", operationId: "getJobRun", params: z.object({ "id": z.string() }), query: z.object({ "waitS": z.number().int().min(0).max(600).describe("Wait up to this many seconds for the run to finish").optional() }), responses: { 200: JobRunResponseSchema } }),
  cancelJobRun: route({ method: "post", path: "/jobs/runs/{id}/cancel", operationId: "cancelJobRun", params: z.object({ "id": z.string() }), responses: { 200: JobRunCancelResponseSchema } }),
};

export const jobsComponents = {
  JobRunCancelResponse: JobRunCancelResponseSchema,
  JobRunRequest: JobRunRequestSchema,
  JobRunResponse: JobRunResponseSchema,
};
