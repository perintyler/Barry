import { z } from "zod";

/**
 * Access level for agent capabilities.
 * - "read": observe without side effects
 * - "readwrite": observe and modify
 */
export type Access = "read" | "readwrite";

/**
 * Unified `{ allow, deny }` rule used across all 6 `Bound` dimensions.
 * `deny` always wins over `allow`. When `allow` is omitted, anything not in
 * `deny` is permitted; when `allow` is present, a candidate must match `allow`
 * (and every clause in `allowClauses` when multiple bounds are merged) and must
 * not match `deny`.
 */
export interface AllowDeny {
  allow?: string[];
  deny?: string[];
  /** Conjunctive allow clauses preserved when merging non-subsuming glob allowlists. */
  allowClauses?: string[][];
}

/**
 * Agent Bound — restrictions across 6 dimensions (`tools`, `inputs`, `files`,
 * `bash`, `network`, `nodes`), each using `{ allow, deny }`.
 */
export interface Bound {
  name?: string;
  description?: string;
  /** Tool and namespace allow/deny patterns (`<bag>`, `<bag>:<access>`, `*:<access>`, `<bag>:<tool>`). */
  tools?: AllowDeny;
  /** Per-tool input parameter allow/deny globs, keyed by `<namespace>:<tool>` then parameter name. */
  inputs?: Record<string, Record<string, AllowDeny>>;
  /** Filesystem path allow/deny globs. */
  files?: AllowDeny;
  /** Bash command allow/deny patterns. */
  bash?: AllowDeny;
  /** Outbound network allow/deny patterns and enforcement mode. */
  network?: AllowDeny & {
    enforce?: "guard" | "sandbox";
  };
  /** Node placement allow/deny patterns. */
  nodes?: AllowDeny;
}

/**
 * Every valid `network` action tag. Parents expand to their children —
 * see NETWORK_ACTION_HIERARCHY in network-classifier.ts.
 */
export const NETWORK_ACTIONS = [
  "all",
  "write",
  "read",
  "git:push",
  "git:fetch",
  "http:write",
  "http:read",
  "ssh:write",
  "ssh:read",
  "dns",
] as const;

export type NetworkAction = (typeof NETWORK_ACTIONS)[number];

const AllowDenySchema = z.strictObject({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
  allowClauses: z.array(z.array(z.string().min(1))).optional(),
});

const InputRuleSchema = z.union([
  AllowDenySchema,
  z.string().min(1).transform((val): AllowDeny => ({ allow: [val] })),
  z.array(z.string().min(1)).transform((val): AllowDeny => ({ allow: val })),
]);

const filePathPattern = z.string().refine(
  (path) =>
    /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("**/"),
  "files.allow requires absolute, home-relative, or **/ paths",
);

export const BoundSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tools: AllowDenySchema.optional(),
    inputs: z
      .record(z.string().min(1), z.record(z.string().min(1), InputRuleSchema))
      .optional(),
    files: z
      .object({
        allow: z.array(filePathPattern).optional(),
        deny: z.array(z.string()).optional(),
        allowClauses: z.array(z.array(filePathPattern)).optional(),
      })
      .strict()
      .optional(),
    bash: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        allowClauses: z.array(z.array(z.string())).optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        allowClauses: z.array(z.array(z.string())).optional(),
        enforce: z.enum(["guard", "sandbox"]).optional(),
      })
      .strict()
      .optional(),
    nodes: AllowDenySchema.optional(),
  })
  .strict();

/**
 * MCP tool annotations — advisory hints about a tool's behavior.
 * Local mirror of the MCP spec's ToolAnnotations to avoid SDK coupling.
 */
export interface McpAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Metadata for a tool — namespace, name, and whether it reads or writes.
 * This is just metadata, not the tool itself.
 */
export interface ToolDescriptor {
  namespace: string;
  toolName: string;
  access: "read" | "write";
  /** Trusted evidence for the versioned input/output contract. */
  contractHash?: string;
  /** MCP annotations from the tool's upstream server or definition. */
  annotations?: McpAnnotations;
  /** Declared outbound network tags or endpoints for tool-level network bounds. */
  network?: string[];
}

const namedBoundSchema = BoundSchema.extend({ name: z.string().min(1) });
export const BoundListResponseSchema = z.strictObject({ bounds: z.array(namedBoundSchema) });
export const CreateBoundRequestSchema = namedBoundSchema;
export const BoundResponseSchema = z.strictObject({ bound: namedBoundSchema });
export const UpdateBoundRequestSchema = BoundSchema.omit({ name: true });
