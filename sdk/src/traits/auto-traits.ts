/**
 * Bags with namespaces or skills receive a main auto-trait and a readonly twin.
 * Service-only and action-only bags can omit auto-traits and declare authored traits.
 * The twin includes the main trait and applies readonly to the whole session.
 * A declared read trait overrides the generated twin.
 * Composition absorbs reachable child namespaces and skills from the supplied registry.
 * See docs/decisions/0045-auto-trait-eligibility.md.
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { Bag, BagTrait } from "../bags/types.js";

/** Skill directories supply auto-traits; action-only bags need authored traits. */
function collectSkillNames(bag: Bag): string[] {
  const names = new Set<string>();
  for (const dir of bag.skillsDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (statSync(join(dir, entry)).isDirectory()) names.add(entry);
    }
  }
  return [...names].sort();
}

/**
 * Remote enumerated tools supply their own namespaces; local server names
 * and explicit tool metadata contribute independent grants. A local tools
 * module defaults to its bag name, verified by shipped-namespaces tests.
 * Unknown tool namespaces contribute nothing, so sync preserves stored grants
 * and refuses pruning rather than replacing them with a guess.
 */
export function ownNamespaces(bag: Bag): Set<string> {
  const all = new Set<string>();
  const remoteWithEnumeratedTools = bag.source.type === "remote" && bag.tools.length > 0;
  if (!remoteWithEnumeratedTools) {
    for (const serverName of Object.keys(bag.mcpServers)) all.add(serverName);
  }
  for (const tool of bag.tools) all.add(tool.namespace);
  if (all.size === 0 && !bag.toolsError && (!bag.manifest || bag.manifest.toolsEntry)) all.add(bag.manifest?.extends ?? bag.name);
  return all;
}

/**
 * Expand bag names through manifest `bags:` composition.
 *
 * Returns the roots first, in the order given, then every transitively
 * reachable sub-bag in breadth-first order. Deduped, so two parents sharing a
 * child yield that child once.
 *
 * Cycle-safe (visited set), deliberately no depth cap — depth caps create
 * silent surprises where a grand-child's namespaces vanish from the parent
 * trait.
 *
 * Roots are always emitted, even when `byName` has no bag for them: callers
 * own the "unknown bag" diagnostic and would lose the name if this dropped it.
 * An unresolvable CHILD is skipped instead — composition is a best-effort
 * widening, and doctor reports the dangling reference.
 *
 * This is the one traversal behind both trait absorption and load-time
 * expansion, so the two can never disagree about what a parent contains.
 */
export function expandComposition(
  names: readonly string[],
  byName: ReadonlyMap<string, Bag>,
): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const name of names) {
    if (visited.has(name)) continue;
    visited.add(name);
    out.push(name);
    queue.push(...(byName.get(name)?.manifest?.bags ?? []));
  }

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    const sub = byName.get(name);
    if (!sub) continue;
    out.push(name);
    queue.push(...(sub.manifest?.bags ?? []));
  }

  return out;
}

/**
 * Sub-bags transitively reachable from `bag` via manifest `bags:` lists.
 * Unregistered or unloaded sub-bags are skipped here; doctor and the identity
 * sync report them.
 */
function resolveSubBags(bag: Bag, byName: ReadonlyMap<string, Bag>): Bag[] {
  // Drop the root (expandComposition always emits it first, resolvable or not)
  // and look up the rest. Children it emits are known-resolvable, so the
  // filter below only narrows the type.
  return expandComposition([bag.name], byName)
    .slice(1)
    .map((name) => byName.get(name))
    .filter((sub): sub is Bag => sub !== undefined);
}

/**
 * The full namespace set a bag's auto-trait grants: its own namespaces plus,
 * when `byName` is supplied, everything absorbed from sub-bags. Exported so
 * validation and display code can answer "what does this bag's trait grant"
 * with the same derivation used to build it.
 */
export function resolveComposedNamespaces(bag: Bag, byName?: ReadonlyMap<string, Bag>): Set<string> {
  const namespaces = ownNamespaces(bag);
  if (!byName) return namespaces;
  for (const sub of resolveSubBags(bag, byName)) {
    for (const ns of ownNamespaces(sub)) namespaces.add(ns);
  }
  return namespaces;
}

/**
 * @param byName - registry of loaded bags for sub-bag (`bags:`) absorption.
 *   Omitted → the auto-trait covers only the bag's own namespaces/skills
 *   (pre-composition behavior).
 */
export function generateAutoTraits(bag: Bag, byName?: ReadonlyMap<string, Bag>): BagTrait[] {
  if (bag.manifest?.extends) return [];
  const allNamespaces = ownNamespaces(bag);
  const skills = new Set(collectSkillNames(bag));

  if (byName) {
    for (const sub of resolveSubBags(bag, byName)) {
      for (const ns of ownNamespaces(sub)) allNamespaces.add(ns);
      for (const skill of collectSkillNames(sub)) skills.add(skill);
    }
  }

  const traits: BagTrait[] = [];

  // Skills-only bags (no namespaces at all) still get their main trait so
  // sessions can opt into the bag's skills via the trait.
  if (allNamespaces.size > 0 || skills.size > 0) {
    traits.push({
      name: bag.name,
      description: bag.description || `All ${bag.name} tools`,
      access: "readwrite",
      bags: [...allNamespaces].sort(),
      skills: [...skills].sort(),
      // Auto-traits are derived from what a bag PROVIDES (namespaces, skills).
      // Pointing at an instruction is an authoring choice about when guidance
      // is relevant, which cannot be derived — a bag declares it explicitly on
      // a manifest trait instead.
      instructions: [],
      // Empty for the same reason: a generated trait grants everything its
      // bag provides. Narrowing it is a decision a human makes on a manifest
      // trait — deriving a restriction would be guessing at intent.
      boundNames: [],
    });
    traits.push(readTwin(bag));
  }

  return traits;
}

/** The shipped bound a read twin carries. Missing at runtime → the session refuses to start. */
const READONLY_BOUND = "readonly";

/**
 * `{bag}:read`: the bag's main trait under the `readonly` bound.
 *
 * Generated, unlike the per-bag restrictions above, because it guesses
 * nothing: every bag's read twin is the same restriction applied the same
 * way. It grants through `includes` rather than copying namespaces, so it
 * follows the main trait through composition and can never grant more.
 */
function readTwin(bag: Bag): BagTrait {
  return {
    name: `${bag.name}:read`,
    description: `Read-only ${bag.name}: its tools with writes denied (makes the session read-only)`,
    // Display only: with no namespaces of its own this restricts nothing.
    // The bound is the restriction — never move it into `access`.
    access: "read",
    bags: [],
    skills: [],
    instructions: [],
    includes: [bag.name],
    boundNames: [READONLY_BOUND],
  };
}
