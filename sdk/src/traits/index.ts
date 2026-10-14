import { parentOf } from "../bags/extensions.js";
import { expandTraitNames } from "../bounds/effective-bound.js";
import { resolveTraits } from "../bounds/resolve-traits.js";
import type { AgentTrait } from "../bounds/types.js";
export type { AgentTrait as Trait } from "../bounds/types.js";


/** Root bag names eligible for their own trait; callers validate them against the trait catalog. See docs/decisions/0045-auto-trait-eligibility.md. */
export function bagTraits(bags: readonly string[]): string[] {
  return bags.filter((bag) => parentOf(bag) === null);
}

/** Selection is explicit: installed or packed bags are not grants by default. */
export function selectTraits(input: {
  defaults?: readonly string[];
  identity?: {
    traits?: readonly string[];
    bags?: readonly string[];
    bag_grant?: "session" | "identity";
  };
  session?: readonly string[];
}): string[] {
  return [
    ...new Set([
      ...(input.defaults ?? []),
      ...(input.identity?.traits ?? []),
      ...(input.session ?? []),
      ...(input.identity?.bag_grant === "identity"
        ? bagTraits(input.identity.bags ?? [])
        : []),
    ]),
  ];
}

/** Validate and expand once so grants and restrictions use the same harness branch. */
export function expandTraits(
  names: readonly string[],
  catalog: Readonly<Record<string, AgentTrait>>,
  harness?: string,
): string[] {
  for (const name of names)
    if (!catalog[name]) throw new Error(`unknown selected trait ${name}`);
  return expandTraitNames(names, catalog, harness);
}

export const Traits = {
  select: selectTraits,
  expand: expandTraits,
  grants: resolveTraits,
} as const;
export * from "./auto-traits.js";

/** Bare harness traits resolve against the running bag; another harness's grants never leak. */
export function resolveHarnessNames(names: readonly string[], namesAvailable: ReadonlySet<string>, harness: { bag?: string; bags: readonly string[] }, kind: "trait" | "bound"): { names: string[]; ungranted: string[] } {
  const resolved: string[] = [];
  const ungranted: string[] = [];
  for (const name of names) {
    if (namesAvailable.has(name)) resolved.push(name);
    else if (harness.bag && namesAvailable.has(`${harness.bag}:${name}`)) resolved.push(`${harness.bag}:${name}`);
    else if (harness.bags.some(bag => namesAvailable.has(`${bag}:${name}`))) ungranted.push(name);
    else throw new Error(`unknown selected ${kind} ${name}`);
  }
  return { names: [...new Set(resolved)], ungranted: [...new Set(ungranted)] };
}
