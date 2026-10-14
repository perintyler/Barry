import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod-v3-oracle";
import { zodSchemaToJson } from "./zod-to-json.js";
import { validateAgainstSchema } from "./validate.js";

describe("zodSchemaToJson", () => {
  // These assertions are deliberately about the CONVERTED PARAMETERS, not
  // merely about the call not throwing. A lost schema is silent: the tool
  // still reaches the model, it just takes no arguments. Only checking that
  // `properties` carries the declared fields catches that.
  it("converts a ZodObject", () => {
    const json = zodSchemaToJson(z.object({ name: z.string(), count: z.number() }));
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties as Record<string, unknown>)).toEqual(["name", "count"]);
  });

  it("converts a raw shape by wrapping it in z.object", () => {
    const json = zodSchemaToJson({ query: z.string() });
    expect(Object.keys(json.properties as Record<string, unknown>)).toEqual(["query"]);
  });

  it("converts a zod 3 raw shape exactly as the zod 3 object it describes", () => {
    const shape = { path: z3.string().describe("repo"), files: z3.array(z3.string()).optional() };
    const warnings: string[] = [];
    const log = { error: (event: string) => warnings.push(event), warn: (event: string) => warnings.push(event) };

    const json = zodSchemaToJson(shape, "git:add", log);

    expect(warnings).toEqual([]);
    expect(json).toEqual(zodSchemaToJson(z3.object(shape), "git:add", log));
    expect(json.required).toEqual(["path"]);
    expect(Object.keys(json.properties as Record<string, unknown>)).toEqual(["path", "files"]);
  });

  it("describes an input from the caller's side, as tools/list does", () => {
    const json = zodSchemaToJson({
      at: z.union([z.number(), z.string()]).transform((v) => Number(v)),
      limit: z.number().default(10),
    });
    expect(json.required).toEqual(["at"]);
    expect((json.properties as Record<string, unknown>).at).toEqual({ type: ["number", "string"] });
  });

  it("round-trips through validateAgainstSchema", () => {
    // The two halves must agree: a schema converted from zod must be directly
    // usable by the ajv side. Conversion and validation share the same JSON Schema contract.
    const json = zodSchemaToJson(z.object({ n: z.number() }));
    expect(validateAgainstSchema(json, { n: 1 })).toEqual({ ok: true });
    expect(validateAgainstSchema(json, { n: "one" }).ok).toBe(false);
  });
});
