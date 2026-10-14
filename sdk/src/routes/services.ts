import { z } from "zod";
import type { Service } from "../barry/types.js";
import { route } from "./route.js";

export const ServiceSchema = z.strictObject({
  key: z.string(), bag: z.string(), name: z.string(),
  kind: z.enum(["service", "app", "container", "deployment"]),
  state: z.enum(["starting", "running", "backoff", "stopped", "conflict", "unsupported"]),
  registered: z.boolean(), enabled: z.boolean(), system: z.boolean(),
  pid: z.number().int().nullable(), port: z.number().int().nullable(), address: z.string().nullable(),
  health: z.enum(["ok", "failing", "unknown"]), restarts: z.number().int(),
  startedAt: z.string().nullable(), lastExitCode: z.number().int().nullable(), workingDirectory: z.string(),
  loopbackOnly: z.boolean().nullable(), conflict: z.string().nullable(), problem: z.string().nullable(),
}) satisfies z.ZodType<Service>;
const ServiceListResponse = z.strictObject({ services: z.array(ServiceSchema) });
const ServiceResponse = z.strictObject({ service: ServiceSchema });
const params = z.object({ key: z.string().regex(/^[A-Za-z0-9._-]+$/).refine(key => !key.includes("..")) });
export const servicesRoutes = {
  listServices: route({ method: "get", path: "/services", operationId: "listServices", responses: { 200: ServiceListResponse } }),
  getService: route({ method: "get", path: "/services/{key}", operationId: "getService", params, responses: { 200: ServiceResponse } }),
  startService: route({ method: "post", path: "/services/{key}/start", operationId: "startService", params, responses: { 200: ServiceResponse } }),
  stopService: route({ method: "post", path: "/services/{key}/stop", operationId: "stopService", params, responses: { 200: ServiceResponse } }),
  restartService: route({ method: "post", path: "/services/{key}/restart", operationId: "restartService", params, responses: { 200: ServiceResponse } }),
};
export const servicesComponents = { Service: ServiceSchema, ServiceListResponse, ServiceResponse };
