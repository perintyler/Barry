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
    expect(apiRoutes).toHaveLength(86);
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
