import { expandTraitNames } from "./effective-bound.js";
import type { AgentTrait, Access } from "./types.js";
import { createLogger } from "../logging/emit.js";

const legacyGrantLog = createLogger("bounds.traits", { transport: "stderr" });

/**
 * Resolved traits — the output of resolving a task's traits.
 * Maps namespace or toolName → effective access level.
 */
export type ResolvedTraits = Map<string, Access>;

export interface ResolvedTraitGrants {
  /** namespace → access */
  byNamespace: ResolvedTraits;
  /**
   * qualified `namespace:tool` id → access (explicit per-tool grants).
   *
   * Keyed on the qualified id, never a bare name: two bags may both export
   * `status`, and a grant for a bare `status` previously admitted every
   * namespace's `status` AND took precedence over the namespace grant. A
   * caller resolves a tool's grant with `toolGrant(grants, namespace, tool)`.
   */
  byTool: ResolvedTraits;
  /**
   * Legacy bare-tool-name grants (`tools: ["status"]`, no namespace).
   *
   * Kept for backward compatibility with manifests that have not qualified
   * their `tools:` entries. A bare name matches that name in ANY namespace,
   * which is the imprecision SDK-4 is about, so each one emits a one-time
   * deprecation warning. Prefer qualified `ns:tool` ids.
   */
  byToolLegacy: ResolvedTraits;
}

/** Resolve the per-tool grant for a (namespace, tool), qualified first then legacy. */
export function toolGrant(grants: ResolvedTraitGrants, namespace: string, toolName: string): Access | undefined {
  return grants.byTool.get(`${namespace}:${toolName}`) ?? grants.byToolLegacy.get(toolName);
}

const warnedLegacyGrants = new Set<string>();

/**
 * Resolve a list of trait names into namespace and tool grant maps.
 *
 * Expands composite traits (via `includes`), then unions all grants.
 * When multiple traits grant the same namespace or tool with different access
 * levels, the more permissive level wins (readwrite > read).
 *
 * `AgentTrait.tools` entries may be qualified (`ns:tool`) or a bare legacy
 * name. Qualified ids key `byTool`; a bare name keys `byToolLegacy` and warns.
 */
export function resolveTraits(
  traitNames: string[],
  allTraits: Record<string, AgentTrait>,
  harness?: string,
): ResolvedTraitGrants {
  const byNamespace: ResolvedTraits = new Map();
  const byTool: ResolvedTraits = new Map();
  const byToolLegacy: ResolvedTraits = new Map();

  const expanded = expandTraitNames(traitNames, allTraits, harness);

  for (const traitName of expanded) {
    const trait = allTraits[traitName];
    if (!trait) continue;

    for (const ns of trait.namespaces) {
      const current = byNamespace.get(ns);
      if (!current || morePermissive(trait.access, current)) {
        byNamespace.set(ns, trait.access);
      }
    }

    for (const tool of trait.tools ?? []) {
      // A qualified id contains a single `:` separating a non-empty namespace
      // from a non-empty tool name; anything else is a legacy bare name.
      const colon = tool.indexOf(":");
      const qualified = colon > 0 && colon < tool.length - 1 && tool.indexOf(":", colon + 1) === -1;
      const target = qualified ? byTool : byToolLegacy;
      if (!qualified && !warnedLegacyGrants.has(tool)) {
        warnedLegacyGrants.add(tool);
        legacyGrantLog.warn("bounds.legacy_bare_tool_grant", {
          detail: `trait "${trait.name}" grants bare tool name "${tool}"; this admits that tool in every namespace. Qualify it as "namespace:${tool}". Bare names are deprecated.`,
        });
      }
      const current = target.get(tool);
      if (!current || morePermissive(trait.access, current)) {
        target.set(tool, trait.access);
      }
    }
  }

  return { byNamespace, byTool, byToolLegacy };
}

function morePermissive(a: Access, b: Access): boolean {
  if (a === "readwrite" && b === "read") return true;
  return false;
}
