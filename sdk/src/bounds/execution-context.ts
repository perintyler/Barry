import type { Bound, AgentTrait, ToolMeta } from "./types.js";
import { expandTraitNames, resolveEffectiveBound } from "./effective-bound.js";
import { filterToolsQualified, qualifyToolId } from "./filter-tools.js";
export interface ExecutionContext {
  identity?: string;
  traits: string[];
  bound: Bound | null;
  allowedToolIds: string[];
  harness?: string;
}
/** No default grants: the caller supplies all selected traits. */
export async function resolveExecutionContext(options: {
  identity?: string;
  traitNames: readonly string[];
  traits: Record<string, AgentTrait>;
  tools: ToolMeta[];
  harness?: string;
  boundByName: (name: string) => Promise<Bound | null | undefined>;
  bounds?: readonly (Bound | null | undefined)[];
}): Promise<ExecutionContext> {
  for (const name of options.traitNames) {
    if (!options.traits[name]) throw new Error(`unknown selected trait ${name}`);
  }
  const names = expandTraitNames(options.traitNames, options.traits, options.harness);
  const bound = await resolveEffectiveBound(options);
  const allowed = filterToolsQualified(
    options.tools,
    names,
    options.traits,
    bound ?? undefined,
    options.harness,
  );
  return {
    identity: options.identity,
    traits: names,
    bound,
    allowedToolIds: [...allowed],
    harness: options.harness,
  };
}
export function assertNodeAllowed(nodeId: string, bound?: Bound | null): void {
  if (
    bound?.nodes?.deny?.includes(nodeId) ||
    (bound?.nodes?.allow !== undefined && !bound.nodes.allow.includes(nodeId))
  ) {
    throw new Error(`node access denied: ${nodeId}`);
  }
}
export function assertToolAllowed(
  context: ExecutionContext,
  tool: Pick<ToolMeta, "namespace" | "toolName">,
  nodeId: string,
): void {
  assertNodeAllowed(nodeId, context.bound);
  if (!context.allowedToolIds.includes(qualifyToolId(tool.namespace, tool.toolName)))
    throw new Error(`tool access denied: ${tool.namespace}:${tool.toolName}`);
}
