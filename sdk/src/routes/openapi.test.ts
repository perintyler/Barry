import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiRoutes, openApiDocument, route } from "./index.js";

const body = z.strictObject({ name: z.string() });
const declaration = route({ method: "post", path: "/example/{id}", operationId: "example", params: z.object({ id: z.int().describe("Row id") }), query: z.object({ limit: z.int().max(10).optional(), q: z.string() }), body, responses: { 201: body } });

describe("OpenAPI from routes", () => {
  it("references named bodies and responses", () => {
    const document = openApiDocument([declaration], { Example: body });
    expect(document.paths[declaration.path]?.post).toMatchObject({ requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Example" } } } }, responses: { 201: { content: { "application/json": { schema: { $ref: "#/components/schemas/Example" } } } } } });
  });
  it("publishes path and query constraints", () => {
    expect(openApiDocument([declaration], { Example: body }).paths[declaration.path]?.post).toMatchObject({ parameters: [
      { name: "id", in: "path", required: true, description: "Row id", schema: { type: "integer" } },
      { name: "limit", in: "query", required: false, schema: { maximum: 10 } },
      { name: "q", in: "query", required: true },
    ] });
  });
  it("sets the root server for absolute v2 paths", () => {
    const absolute = route({ ...declaration, path: "/api/v2/example/{id}", stream: true, responses: { 200: null, 202: body } });
    expect(openApiDocument([absolute], { Example: body }).paths[absolute.path]).toMatchObject({ servers: [{ url: "/" }], post: { responses: { 200: { content: { "text/event-stream": { schema: { type: "string" } } } } } } });
  });
  it("refuses unnamed schemas", () => expect(() => openApiDocument([declaration], {})).toThrow("no component name"));
  it("refuses two names for one schema", () => expect(() => openApiDocument([declaration], { One: body, Two: body })).toThrow("two component names"));
  it("publishes OpenAPI 3.1 at /api/v1", () => {
    const document = openApiDocument(apiRoutes);
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "/api/v1" }]);
    expect(apiRoutes).toHaveLength(92);
    expect(document.paths["/actions/work-items/{id}"]?.get).toMatchObject({ operationId: "getSessionWorkflowWork",
      parameters: expect.arrayContaining([{ name: "session_id", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }]),
      responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkItem" } } } } },
    });
    expect(document.paths["/actions/work-items/{id}/result"]?.get).toMatchObject({ operationId: "getSessionWorkflowWorkResult" });
    expect(document.paths["/actions/work-items/{id}/stop"]?.post).toMatchObject({ operationId: "stopSessionWorkflowWork",
      responses: { 202: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkStopAck" } } } } },
    });
    expect(document.paths["/actions/{name}/work-start"]?.post).toMatchObject({ operationId: "startSessionWorkflowAction",
      parameters: expect.arrayContaining([{ name: "session_id", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }]),
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkflowStartRequest" } } } },
    });
    expect(document.paths["/actions/{name}/work-start-agent"]?.post).toMatchObject({ operationId: "startSessionWorkflowAgentAction",
      parameters: expect.arrayContaining([{ name: "session_id", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } }]),
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkflowStartRequest" } } } },
    });
    expect(document.paths["/actions/work-operations/{key}"]?.get).toMatchObject({ operationId: "lookupSessionWorkflowAction" });
    expect(document.paths["/actions/runs/{id}/work-stop"]?.post).toMatchObject({ operationId: "stopSessionWorkflowAction",
      parameters: expect.arrayContaining([{ name: "session_id", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 500 } }]),
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkflowStopRequest" } } } },
      responses: { 202: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkflowStopAck" } } } } },
    });
    expect(document.paths["/actions/runs/{id}/cancel"]).toMatchObject({
      post: {
        operationId: "stopWorkflowAction",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkflowStopRequest" } } } },
        responses: { 202: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionWorkflowStopAck" } } } } },
      },
    });
    expect(document.paths["/sessions/{sessionId}/prepare"]).toMatchObject({ post: { operationId: "prepareSession", responses: { 202: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionAck" } } } } } } });
    expect(document.paths["/sessions/{sessionId}/backfill"]).toMatchObject({
      post: {
        operationId: "backfillSession",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/BackfillSessionRequest" } } } },
        responses: { 202: { content: { "application/json": { schema: { $ref: "#/components/schemas/ActionAck" } } } } },
      },
    });
    expect(document.paths["/prompts/guarantee"]).toMatchObject({
      post: { operationId: "listDeliveryGuarantees" },
    });
    expect(document.components.schemas).toHaveProperty("AgUiEvent");
    expect(document.components.schemas).toHaveProperty("AgUiSubscriptionRequest");
  });
});
