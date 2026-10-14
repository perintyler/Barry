import type { ToolMeta, AgentTrait, Bound } from "./types.js";
import { resolveTraits, toolGrant } from "./resolve-traits.js";
import { getImpliedDeniedTools } from "./network-classifier.js";

/**
 * The identity a tool is authorized under: namespace AND name, never one alone.
 *
 * Two bags may both export `status`. Authorization is decided per (namespace,
 * name) — `filterToolsQualified` below gets that right — but returning a bare
 * name collapses the pair, and a consumer testing membership by name then
 * admits every tool sharing an allowed name. Granting `system` also admitted
 * `git`'s `status`.
 */
export function qualifyToolId(namespace: string, toolName: string): string {
  return `${namespace}:${toolName}`;
}

/**
 * Filter tools based on traits and optional bound, returning QUALIFIED ids.
 *
 * 1. Resolve traits → namespace grants + explicit tool grants
 * 2. Filter tools: include if namespace or toolName is enabled AND access permits
 * 3. Exclude denied tools (by namespace or toolName)
 * 4. Exclude write tools for deniedAccess entries
 * 5. Exclude tools implied by network action restrictions
 * 6. Return `namespace:toolName` for each survivor
 *
 * Prefer this over `filterTools` anywhere the result gates invocation. The
 * bare-name version cannot express "this name from that namespace" and is kept
 * only for callers that genuinely want names for display.
 */
export function filterToolsQualified(
  tools: ToolMeta[],
  traitNames: string[],
  allTraits: Record<string, AgentTrait>,
  bound?: Bound,
  harness?: string,
): string[] {
  return allowedToolMeta(tools, traitNames, allTraits, bound, harness).map((t) =>
    qualifyToolId(t.namespace, t.toolName),
  );
}

/**
 * Filter tools based on traits and optional bound.
 *
 * Returns BARE names, which cannot distinguish two namespaces exporting the
 * same tool. Use `filterToolsQualified` for authorization decisions.
 */
export function filterTools(
  tools: ToolMeta[],
  traitNames: string[],
  allTraits: Record<string, AgentTrait>,
  bound?: Bound,
  harness?: string,
): string[] {
  return allowedToolMeta(tools, traitNames, allTraits, bound, harness).map((t) => t.toolName);
}

/**
 * The single authorization pass both views derive from.
 *
 * Kept as one function deliberately: two copies of this predicate would drift,
 * and a qualified view that disagreed with the bare one about what is allowed
 * would be worse than either alone.
 */
function allowedToolMeta(
  tools: ToolMeta[],
  traitNames: string[],
  allTraits: Record<string, AgentTrait>,
  bound?: Bound,
  harness?: string,
): ToolMeta[] {
  const grants = resolveTraits(traitNames, allTraits, harness);
  const { byNamespace } = grants;
  // Case-insensitive, matching native-policy's casing (native-policy.ts): a
  // bound of deniedTools: [bash] must take back both native Bash and MCP Bash,
  // not leave the MCP tool reachable because its catalog name is capitalised.
  const denied = new Set((bound?.deniedTools ?? []).map((name) => name.toLowerCase()));
  if (bound?.files?.deny?.length || bound?.files?.allowOnly !== undefined) denied.add("bash");
  const denyAccess = new Set(bound?.deniedAccess ?? []);

  // Network action restrictions imply tool denials (e.g. actions: ["write"] → deny push)
  if (bound?.network?.actions?.length) {
    for (const tool of getImpliedDeniedTools(bound.network.actions)) {
      denied.add(tool.toLowerCase());
    }
  }
  const allowed: ToolMeta[] = [];

  for (const tool of tools) {
    // Resolve access: explicit tool grant (qualified ns:tool, or a legacy bare
    // name) takes precedence over the namespace grant.
    const traitAccess = toolGrant(grants, tool.namespace, tool.toolName) ?? byNamespace.get(tool.namespace);
    if (!traitAccess) continue;

    if (denied.has(tool.namespace.toLowerCase()) || denied.has(tool.toolName.toLowerCase())) continue;

    // Write tools require readwrite from trait
    if (tool.access === "write" && traitAccess === "read") continue;

    if (tool.access === "write" && (denyAccess.has("write") || denyAccess.has(tool.namespace) || denyAccess.has(tool.toolName))) continue;

    // The whole meta, not a name: the caller decides which identity it needs,
    // and the namespace is only recoverable here.
    allowed.push(tool);
  }

  return allowed;
}
