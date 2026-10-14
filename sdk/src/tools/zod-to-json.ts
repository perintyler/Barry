import { createLogger } from "../logging/emit.js";
import { toJSONSchema as toJsonSchemaV4, object as zObjectV4 } from "zod/v4";
import { zodToJsonSchema } from "zod-to-json-schema";
import { normalizeWireSchema } from "./normalize-json-schema.js";

/** Callers may supply their structured conversion logger. */
export interface SchemaConversionLogger {
  error(event: string, meta: Record<string, unknown>): void;
  warn(event: string, meta: Record<string, unknown>): void;
}

const defaultLogger: SchemaConversionLogger = createLogger("sdk-tools", { transport: "stderr" });

/**
 * Structural ZodObject check. `instanceof` is unusable here: bags resolve
 * their own zod copy (three are installed — 3.25.x and two 4.x), so a schema
 * built in a bag's realm is never an instance of *our* ZodObject. It would
 * silently fall through, throw, and ship the tool with an empty parameter
 * schema. This workspace is on zod 4 now, but that changes nothing here: an
 * external bag brings its own copy, so the realms are still distinct and the
 * duck-typing is still what makes the check work. It also spans the v3/v4
 * split, where the marker moved (_def.typeName === "ZodObject" -> _def.type).
 */
function isZodObject(schema: unknown): schema is { safeParse: unknown; shape: Record<string, unknown> } {
  if (!schema || typeof schema !== "object") return false;
  const candidate = schema as { safeParse?: unknown; shape?: unknown };
  return typeof candidate.safeParse === "function" && typeof candidate.shape === "object";
}

/**
 * Convert a zod v4 (or v4-mini) schema to JSON Schema.
 *
 * `toJSONSchema` is overloaded on schema-vs-registry, and the duck-typed value
 * we hold matches neither well enough for TS to pick the schema overload. The
 * structural check that got us here (safeParse + shape, no `_def`) is the real
 * guarantee; this wrapper localizes that single unavoidable cast.
 *
 * Every schema converted here is a tool's INPUT, so it is described from the
 * caller's side, as the MCP SDK lists it: a defaulted field is optional, and a
 * transform is described by what it accepts. The output side cannot represent
 * a transform at all, and the conversion threw.
 */
function convertV4Schema(schema: object): Record<string, unknown> {
  const convert = toJsonSchemaV4 as (s: object, options: { io: "input" }) => Record<string, unknown>;
  return convert(schema, { io: "input" });
}

/** The definition zod 3's `z.object(shape)` carries, as zod-to-json-schema reads it. */
function v3ObjectOf(shape: Record<string, unknown>): { _def: Record<string, unknown> } {
  return {
    _def: {
      typeName: "ZodObject",
      shape: () => shape,
      unknownKeys: "strip",
      catchall: { _def: { typeName: "ZodNever" } },
    },
  };
}

/**
 * Convert a zod schema (v3, v4, v4-mini, foreign-realm, or a raw shape) to
 * JSON Schema. Battle-hardened in engine against this repo's zod-version
 * zoo; see the inline comments for each case's war story.
 */
export function zodSchemaToJson(
  schema: unknown,
  toolName?: string,
  log: SchemaConversionLogger = defaultLogger,
): Record<string, unknown> {
  if (!schema) return { type: "object" };

  // zod-to-json-schema reads v3 internals (`_def.typeName`) unguarded. A schema
  // can pass isZodObject() and still not carry `_def`: the MCP SDK normalizes a
  // tool declared with an empty shape (`schema: {}`) into a zod-*mini* object,
  // which keeps its internals on `_zod` instead. That threw a TypeError on every
  // tools/list, and since the tool takes no arguments anyway, the correct
  // conversion is simply the empty object schema.
  if (isZodObject(schema) && !("_def" in schema)) {
    try {
      // zod v4 ships its own converter and reads a foreign realm's schema
      // fine (it walks `_zod`, not instanceof), so this keeps the parameters
      // rather than shipping the tool bare.
      const json = convertV4Schema(schema);
      if (json && (json.type || json.properties)) return normalizeWireSchema(json);
      throw new Error("v4 conversion produced an empty schema");
    } catch (error) {
      // An argument-less tool is the common case here and converts to the
      // empty object schema, so only a non-empty shape is a real loss.
      const fields = Object.keys(schema.shape ?? {});
      if (fields.length === 0) {
        return { type: "object", properties: {}, additionalProperties: false };
      }
      log.error("schema_v4_conversion_failed", {
        tool: toolName ?? "<unknown>",
        fields,
        error: error instanceof Error ? error.message : String(error),
        hint: "zod v4 schema could not be converted — the tool reaches the model with NO parameters",
      });
      return { type: "object" };
    }
  }

  // A raw shape whose members were built in another realm (a bag bundling its
  // own zod, e.g. via mcp-adapter). Build the object with our v4 and use its
  // converter, which walks `_zod` and reads a foreign realm's schema fine.
  if (!isZodObject(schema) && typeof schema === "object") {
    const members = Object.values(schema as Record<string, unknown>);
    const hasV4Member = members.some(
      (m) => !!m && typeof m === "object" && "_zod" in m,
    );
    if (hasV4Member) {
      try {
        const json = convertV4Schema(zObjectV4(schema as never));
        if (json && (json.type || json.properties)) return normalizeWireSchema(json);
        throw new Error("v4 shape conversion produced an empty schema");
      } catch (error) {
        log.error("schema_v4_shape_conversion_failed", {
          tool: toolName ?? "<unknown>",
          fields: Object.keys(schema),
          error: error instanceof Error ? error.message : String(error),
          hint: "zod v4 raw shape could not be converted — the tool reaches the model with NO parameters",
        });
        return { type: "object" };
      }
    }
  }

  try {
    // What lands here carries `_def`, which means zod v3. This workspace is on
    // v4, so it is a bag bundling its own v3 copy -- still the common case,
    // since ~50 external bags pin 3.25.76 and migrate on their own schedule.
    //
    // zod-to-json-schema stays a runtime dependency for exactly this, and the
    // reason is worth stating because removing it looks safe: v4's converter
    // walks `_zod`, which NO v3 object has -- not the top-level schema and not
    // its members -- so there is no rebuild-in-our-realm trick. Dropping it
    // turned every foreign v3 schema into a bare {type:"object"}: the
    // parameterless-tool failure this module exists to prevent. Caught by
    // the differential schema tests using a real foreign v3 installation.
    // Route by what the value IS, not by what the workspace version implies:
    // a v3 object carries `_def`, a v4 one carries `_zod`, and both arrive
    // here from different callers. Getting this backwards silently empties
    // the schema, so it is decided per value.
    // Which converter can read this? Decide from the MEMBERS, not the wrapper.
    //
    // A v4 object carries both `_def` and `_zod`, so "has _def" does not mean
    // v3 -- and a hand-assembled cross-realm object (the shape a proxy passes,
    // and what bag-proxy.test.ts builds) copies `_def` across without `_zod`,
    // which makes the wrapper indistinguishable from v3 by that test. The
    // members are unambiguous: only a v4 schema has `_zod`.
    //
    // Raw shapes of v3 members DO arrive here: the MCP SDK normalizes a shape
    // before listing it, but toolContractHash reads a bag's tool definition
    // directly, and a bag on zod 3 declares its schema as a plain shape.
    const members = isZodObject(schema) ? schema.shape : (schema as Record<string, unknown>);
    const memberValues = Object.values(members ?? {});
    const hasV4Members = memberValues.some((m) => !!m && typeof m === "object" && "_zod" in m);
    const looksV3 = memberValues.length > 0 && !hasV4Members;

    const json = looksV3
      // v3: only zod-to-json-schema can read `_def`. A v3 object goes in as
      // is; a raw shape has no `_def` of its own and needs a v3 object around
      // it, which only the bag's own zod can build. The converter reads
      // nothing but the definition, so describe the object `z.object(shape)`
      // would build instead: strip unknown keys, no catchall.
      ? (zodToJsonSchema((isZodObject(schema) ? schema : v3ObjectOf(members)) as never, { pipeStrategy: "input" }) as Record<string, unknown>)
      // Always rebuild from the MEMBERS, never hand the wrapper straight to
      // the converter: a cross-realm object copies `_def` but not `_zod`, so
      // the converter throws walking it -- while its members are perfectly
      // readable v4 schemas. Rebuilding costs nothing and works for a genuine
      // v4 object too, whose shape round-trips unchanged.
      : convertV4Schema(zObjectV4(members as never));

    if (!json || (!json.type && !json.properties)) {
      throw new Error("conversion produced an empty schema");
    }
    return normalizeWireSchema(json);
  } catch (error) {
    // Losing a schema means the model sees a parameterless tool — never silent.
    log.warn("schema_conversion_failed", {
      tool: toolName ?? "<unknown>",
      error: error instanceof Error ? error.message : String(error),
    });
    return { type: "object" };
  }
}
