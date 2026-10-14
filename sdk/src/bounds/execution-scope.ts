import { createHash } from "node:crypto";
import { z } from "zod";
import { BoundSchema, type Bound, type ToolMeta } from "./types.js";
import { resolveExecutionContext, assertNodeAllowed, type ExecutionContext } from "./execution-context.js";
import { mergeBounds } from "./merge-bounds.js";
import { filterToolsQualified, qualifyToolId } from "./filter-tools.js";

const reference = z.string().min(1).max(200);
export const executionScopeSchema = z.strictObject({
  identity: reference.optional(), traits: z.array(reference).max(100),
  bound: BoundSchema.nullable(), harness: reference.optional(),
  tools: z.record(reference, z.enum(["read", "write"])).refine(value => Object.keys(value).length <= 1000),
  contracts: z.record(reference, z.string().regex(/^[a-f0-9]{64}$/)).refine(value => Object.keys(value).length <= 1000).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExecutionScope = z.infer<typeof executionScopeSchema>;

/** Canonical policy evidence; never contains credentials or transport tokens. */
export function scopeFingerprint(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") return `{${Object.keys(item).filter(key => Reflect.get(item, key) !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(Reflect.get(item, key))}`).join(",")}}`;
    return JSON.stringify(item ?? null);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Resolve explicit selections. No identity/default trait union occurs here. */
export async function approveExecutionScope(options: Parameters<typeof resolveExecutionContext>[0]): Promise<ExecutionScope> {
  const context = await resolveExecutionContext(options);
  const tools = Object.fromEntries(options.tools.filter(tool => context.allowedToolIds.includes(qualifyToolId(tool.namespace, tool.toolName))).map(tool => [qualifyToolId(tool.namespace, tool.toolName), tool.access]));
  const contracts = Object.fromEntries(options.tools.filter(tool => tool.contractHash && Object.hasOwn(tools, qualifyToolId(tool.namespace, tool.toolName))).map(tool => [qualifyToolId(tool.namespace, tool.toolName), tool.contractHash!]));
  const value = { identity: context.identity, traits: context.traits, bound: context.bound, harness: context.harness, tools, contracts };
  return executionScopeSchema.parse(JSON.parse(JSON.stringify({ ...value, fingerprint: scopeFingerprint(value) })));
}

/** Each bound must allow the operation; grants can only shrink after approval. */
export function intersectExecutionScope(approved: ExecutionScope, current: ExecutionContext, catalog: readonly ToolMeta[], restrictions: readonly (Bound | null)[] = []): ExecutionContext {
  approved = executionScopeSchema.parse(approved);
  const { fingerprint, ...evidence } = approved;
  if (scopeFingerprint(evidence) !== fingerprint) throw new Error("execution scope fingerprint mismatch");
  if (approved.identity !== current.identity || approved.harness !== current.harness) throw new Error("execution identity or harness changed");
  const bound = [approved.bound, current.bound, ...restrictions].reduce<Bound | null>((result, next) => mergeBounds(result, next), null);
  const allowed = new Set(filterToolsQualified([...catalog], ["__scope"], { __scope: { name: "__scope", namespaces: [...new Set(catalog.map(tool => tool.namespace))], access: "readwrite" } }, bound ?? undefined));
  return { ...current, bound, allowedToolIds: catalog.filter(tool => {
    const id = qualifyToolId(tool.namespace, tool.toolName);
    return approved.tools[id] === tool.access && (!approved.contracts?.[id] || approved.contracts[id] === tool.contractHash) && current.allowedToolIds.includes(id) && allowed.has(id);
  }).map(tool => qualifyToolId(tool.namespace, tool.toolName)) };
}

export function assertScopeDelegation(scope: ExecutionScope, delegator: ExecutionContext, catalog: readonly ToolMeta[]): void {
  // An explicit run-as authorization is checked separately by the application.
  const effective = intersectExecutionScope(scope, { ...delegator, identity: scope.identity, harness: scope.harness }, catalog);
  if (Object.keys(scope.tools).some(id => !effective.allowedToolIds.includes(id))) throw new Error("selected job capabilities exceed delegable authority");
  if (scope.bound?.nodes?.allow) for (const node of scope.bound.nodes.allow) assertNodeAllowed(node, delegator.bound);
}
