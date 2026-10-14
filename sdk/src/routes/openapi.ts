import { z } from "zod";
import { agUiContractSchemas } from "../apps/wire.js";
import { components } from "./components.js";
import type { Route } from "./route.js";

function parameterSchema(schema: z.ZodType) {
  const { $schema: _dialect, ...value } = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  // Zod emits implicit safe-integer bounds; the published parameters omit them.
  if (value.minimum === Number.MIN_SAFE_INTEGER) delete value.minimum;
  if (value.maximum === Number.MAX_SAFE_INTEGER) delete value.maximum;
  return value;
}

const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

export function openApiDocument(routes: readonly Route[], names: Record<string, z.ZodType> = components) {
  const bySchema = new Map<z.ZodType, string>();
  for (const [name, schema] of Object.entries(names)) {
    const previous = bySchema.get(schema);
    if (previous && previous !== name) throw new Error(`Schema has two component names: ${previous}, ${name}`);
    bySchema.set(schema, name);
  }
  const ref = (schema: z.ZodType) => {
    const name = bySchema.get(schema);
    if (!name) throw new Error("Body or response schema has no component name");
    return { $ref: `#/components/schemas/${name}` };
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const declaration of routes) {
    const { path, method, operationId, body, responses, params, query, stream } = declaration;
    const item = paths[path] ??= {};
    if (item[method]) throw new Error(`Route served twice: ${method} ${path}`);
    if (path.startsWith("/api/")) item.servers = [{ url: "/" }];
    const parameters = [];
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1];
      const schema = params?.shape[name] ?? z.string();
      parameters.push({ name, in: "path", required: true, ...(schema.description ? { description: schema.description } : {}), schema: parameterSchema(schema) });
    }
    for (const [name, schema] of Object.entries(query?.shape ?? {})) {
      parameters.push({ name, in: "query", required: !schema.isOptional(), ...(schema.description ? { description: schema.description } : {}), schema: parameterSchema(schema) });
    }
    item[method] = {
      operationId,
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: { required: true, content: { "application/json": { schema: ref(body) } } } } : {}),
      responses: {
        ...Object.fromEntries(Object.entries(responses).map(([status, schema]) => [status, {
          description: "Success",
          ...(stream && schema === null ? { content: { "text/event-stream": { schema: { type: "string" } } } } : schema ? { content: { "application/json": { schema: ref(schema) } } } : {}),
        }])),
        default: { description: "Request failed", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Barry API", version: "1.0.0", description: "The single supported HTTP contract for Barry applications." },
    servers: [{ url: "/api/v1" }],
    paths: sorted(Object.fromEntries(Object.entries(paths).map(([path, item]) => [path, sorted(item)]))),
    components: { schemas: sorted({ ...agUiContractSchemas(), ...Object.fromEntries(Object.entries(names).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" })])) }) },
  };
}
