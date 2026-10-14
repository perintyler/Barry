/**
 * Bound merging — union of denials across every source that contributes
 * restrictions to a session (trait bounds, named bounds, barry bounds,
 * inline session bounds).
 *
 * Bounds only ever take away, so merging is a union: if any source denies
 * something, the merged bound denies it. The two exceptions are the allowlists
 * (`network.allowDomains`, `files.allowOnly`), where the restrictive direction
 * is intersection, and `network.enforce`, where the most restrictive level wins.
 *
 * This lives in agent-bound (not in a server) because both the MCP server
 * (app-level guards) and the API server (sandbox barry generation) must
 * resolve the *same* effective bound. Divergence between them silently
 * downgrades enforcement.
 */

import type { Bound } from "./types.js";

function mergeNativeTools(a?: Record<string, string[]>, b?: Record<string, string[]>): Record<string, string[]> | undefined {
  if (!a && !b) return undefined;
  return Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].map((id) => [id, unionStrings(a?.[id], b?.[id]) ?? []]));
}

function unionStrings(a?: string[], b?: string[]): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

function mergeBash(
  base?: Bound["bash"],
  override?: Bound["bash"],
): Bound["bash"] | undefined {
  if (!base && !override) return undefined;
  const deny = unionStrings(base?.deny, override?.deny);
  const denyPrograms = unionStrings(base?.denyPrograms, override?.denyPrograms);
  const merged: NonNullable<Bound["bash"]> = {};
  if (deny) merged.deny = deny;
  if (denyPrograms) merged.denyPrograms = denyPrograms;
  // Undefined-when-empty, matching mergeFiles/mergeNetwork: two bounds that
  // both carry empty bash arrays must serialize the same as a bound with no
  // bash at all, so equality/fingerprinting (scopeFingerprint) does not see
  // `{bash:{}}` and absent-bash as different scopes.
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge the `nodes` allow/deny pair, or undefined when neither side carries
 * one. Emitting `{ allow: undefined, deny: undefined }` whenever either side
 * merely mentions nodes left two equivalent bounds with different shapes.
 */
function mergeNodes(
  base?: Bound["nodes"],
  override?: Bound["nodes"],
): Bound["nodes"] | undefined {
  if (!base && !override) return undefined;
  const allow = intersectAllowlists(base?.allow, override?.allow);
  const deny = unionStrings(base?.deny, override?.deny);
  const merged: NonNullable<Bound["nodes"]> = {};
  if (allow !== undefined) merged.allow = allow;
  if (deny) merged.deny = deny;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeFiles(
  base?: Bound["files"],
  override?: Bound["files"],
): Bound["files"] | undefined {
  if (!base && !override) return undefined;
  const deny = unionStrings(base?.deny, override?.deny);
  const allowOnly = intersectAllowlists(base?.allowOnly, override?.allowOnly);
  const merged: NonNullable<Bound["files"]> = {};
  if (deny) merged.deny = deny;
  if (allowOnly) merged.allowOnly = allowOnly;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Intersect two allowlists.
 *
 * Every other bound field unions, because bounds only ever subtract and a
 * longer deny-list is more restrictive. An allowlist subtracts by *shrinking*,
 * so the restrictive direction is the intersection: the merged bound may permit
 * only what BOTH sources permit.
 *
 * `undefined` means "this source expresses no opinion" and is the identity
 * element, so it must not collapse the other side to empty. An explicit `[]`
 * does mean "allow nothing" and correctly intersects to empty.
 */
function intersectAllowlists(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const bSet = new Set(b);
  return a.filter((entry) => bSet.has(entry));
}

export function mergeNetwork(
  base?: Bound["network"],
  override?: Bound["network"],
): Bound["network"] | undefined {
  if (!base && !override) return undefined;
  const actions = unionStrings(base?.actions, override?.actions);
  const domains = unionStrings(base?.domains, override?.domains);
  const allowDomains = intersectAllowlists(base?.allowDomains, override?.allowDomains);
  // enforce: most restrictive wins — "sandbox" > "guard" > undefined
  const enforce = base?.enforce === "sandbox" || override?.enforce === "sandbox"
    ? "sandbox" as const
    : base?.enforce ?? override?.enforce;
  const merged: NonNullable<Bound["network"]> = {};
  if (actions) merged.actions = actions;
  if (domains) merged.domains = domains;
  // Preserve an empty array: "allow nothing" is a real, restrictive statement.
  if (allowDomains) merged.allowDomains = allowDomains;
  if (enforce) merged.enforce = enforce;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeBounds(
  base: Bound | null,
  override: Bound | null,
): Bound | null {
  if (!base && !override) return null;
  if (!base) { const { name: _name, description: _description, ...rules } = override!; return rules; }
  if (!override) { const { name: _name, description: _description, ...rules } = base; return rules; }
  return {
    nodes: mergeNodes(base.nodes, override.nodes),
    nativeTools: mergeNativeTools(base.nativeTools, override.nativeTools),
    deniedTools: unionStrings(base.deniedTools, override.deniedTools),
    deniedAccess: unionStrings(base.deniedAccess, override.deniedAccess),
    files: mergeFiles(base.files, override.files),
    bash: mergeBash(base.bash, override.bash),
    network: mergeNetwork(base.network, override.network),
  };
}

/**
 * True if a bound carries any actual restriction (not just `{}`).
 *
 * `network.enforce` counts: a bound of `{network:{enforce:"sandbox"}}` is a
 * real instruction to escalate enforcement, and dropping it here would strip
 * that escalation before it ever reached the merge.
 */
export function boundHasContent(bound?: Bound): boolean {
  if (!bound) return false;
  return Boolean(
    bound.nodes?.allow !== undefined || Boolean(bound.nodes?.deny?.length) ||
    Object.values(bound.nativeTools ?? {}).some((tools) => tools.length > 0) ||
      bound.deniedTools?.length ||
      bound.deniedAccess?.length ||
      bound.files?.deny?.length ||
      // An allowlist is content even when empty — `allowOnly: []` means
      // "permit nothing", the most restrictive statement available.
      bound.files?.allowOnly !== undefined ||
      bound.bash?.deny?.length ||
      bound.bash?.denyPrograms?.length ||
      bound.network?.actions?.length ||
      bound.network?.domains?.length ||
      // An allowlist is content even when empty — `allowDomains: []` means
      // "permit nothing", the most restrictive statement available.
      bound.network?.allowDomains !== undefined ||
      bound.network?.enforce,
  );
}
