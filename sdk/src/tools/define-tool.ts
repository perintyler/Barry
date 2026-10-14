import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  secrets: Record<string, string>;
  /** Prefer this over the environment in a server shared by multiple sessions. */
  sessionId?: string;
  /** For describing capabilities only; the host enforces authorization. */
  availableTools?: string[];
  /**
   * Bags this session's identity enabled, composition already expanded — the
   * same set that built the session's prompt. Present only when a session with
   * an identity was resolved.
   *
   * Catalog tools scope their listings to this so they describe what the
   * session actually has. `search_instructions` promises "available to this
   * session" and `find_actions` reads as a session listing; both enumerated
   * every bag on the machine instead, because the option to scope them existed
   * and nothing passed it.
   *
   * Descriptive, not authorization — the same contract as `availableTools`.
   * ABSENT MEANS UNKNOWN, NOT EMPTY: an anonymous session (no identity) and the
   * CLI both arrive without it, and must keep seeing everything. Scoping those
   * to nothing would render an empty catalog indistinguishable from a machine
   * with no instructions installed.
   *
   * Bag REGISTRY names, not tool namespaces. The two diverge — `datadog-mcp`
   * serves the `datadog` namespace — and the instruction and action catalogs
   * both match on registry name.
   */
  bagNames?: string[];
}

/**
 * Accept parameter schemas from either supported zod major through their common output member, without requiring one major’s private schema internals.
 * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
 */
// zod 4 core schemas (what z.ZodRawShape is typed with) carry it as
// `_zod.output` instead, so both spellings are accepted.
export type ToolParamSchema = { readonly _output: unknown } | { readonly _zod: { readonly output: unknown } };
export type ToolShape = { readonly [key: string]: ToolParamSchema };
type OutputOf<S> = S extends { readonly _zod: { readonly output: infer O } }
  ? O
  : S extends { readonly _output: infer O }
    ? O
    : never;
type OptionalKeys<T extends ToolShape> = {
  [K in keyof T]: undefined extends OutputOf<T[K]> ? K : never;
}[keyof T];
/** What `z.infer<z.ZodObject<T>>` gives, computed from `_output` so it works for both majors. */
export type ToolParams<T extends ToolShape> = {
  [K in Exclude<keyof T, OptionalKeys<T>>]: OutputOf<T[K]>;
} & {
  [K in OptionalKeys<T>]?: OutputOf<T[K]>;
};

export interface ToolDefinition<T extends ToolShape = ToolShape, R = unknown> {
  namespace: string;
  access: "read" | "write";
  name: string;
  description: string;
  schema: T;
  secrets?: string[];
  annotations?: McpAnnotations;
  /** Barry's host can hide callable tools until tool_search discovers them. */
  deferred?: boolean;
  _meta?: Record<string, unknown>;
  /** JSON Schema avoids tying result contracts to a particular Zod version. */
  outputSchema?: Record<string, unknown>;
  handler: (params: ToolParams<T>, context?: ToolContext) => Promise<R>;
  cliFormat?: (result: R) => string;
}

export function defineTool<T extends ToolShape, R>(definition: ToolDefinition<T, R>): ToolDefinition<T, R> {
  return definition;
}

// Heterogeneous collections must accept each tool's narrower parameters and result.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

// Share a package-independent, versioned wire marker across bundled copies.
// See docs/decisions/0017-sdk-discovery-and-wire-contracts.md.
const MCP_RESULT = Symbol.for("barry.mcpResult.v1");

export function mcpResult<T extends CallToolResult>(response: T): T {
  return Object.assign({}, response, { [MCP_RESULT]: true });
}

export function isMcpResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && MCP_RESULT in value;
}
