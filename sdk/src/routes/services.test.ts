import { expect, it } from "vitest";
import { ServiceSchema, servicesRoutes } from "./services.js";
import { openApiDocument } from "./openapi.js";
it("publishes exactly five operations with their named components", () => {
  const document = openApiDocument(Object.values(servicesRoutes));
  expect(Object.values(document.paths).flatMap(item => Object.values(item).map(operation => (operation as { operationId: string }).operationId))).toEqual(["listServices", "getService", "restartService", "startService", "stopService"]);
  expect(document.components.schemas).toHaveProperty("Service");
  expect(document.components.schemas).toHaveProperty("ServiceListResponse");
  expect(document.components.schemas).toHaveProperty("ServiceResponse");
  expect(ServiceSchema.safeParse({ key: "incomplete" }).success).toBe(false);
  for (const key of ["../x", "fixture..api", "x/y"]) expect(servicesRoutes.getService.params.safeParse({ key }).success).toBe(false);
});
