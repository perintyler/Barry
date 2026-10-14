import type { Bound, AgentTrait } from "./types.js";
import { mergeBounds } from "./merge-bounds.js";

/** Expand selected traits, including the compound for the actual harness. */
export function expandTraitNames(names: readonly string[], traits: Readonly<Record<string, AgentTrait>>, harness?: string): string[] {
  const expanded = new Set<string>();
  const visiting = new Set<string>();
  function visit(name: string, required: boolean): void {
    if (visiting.has(name)) throw new Error(`trait composition cycle at ${name}`);
    if (expanded.has(name)) return;
    const trait = traits[name];
    if (!trait) {
      if (required) throw new Error(`unknown included trait ${name}`);
      return;
    }
    visiting.add(name);
    expanded.add(name);
    for (const child of trait.includes ?? []) visit(child, true);
    if (trait.harnessTraits && harness) {
      const child = trait.harnessTraits[harness];
      if (!child) throw new Error(`trait ${name} has no policy for harness ${harness}`);
      visit(child, true);
    }
    visiting.delete(name);
  }
  for (const name of names) visit(name, false);
  return [...expanded];
}

/** One restriction chain for native enforcement and MCP guards. */
export async function resolveEffectiveBound(options: {
  traitNames: readonly string[];
  traits: Readonly<Record<string, AgentTrait>>;
  harness?: string;
  boundByName: (name: string) => Promise<Bound | null | undefined>;
  bounds?: readonly (Bound | null | undefined)[];
}): Promise<Bound | null> {
  let bound: Bound | null = null;
  const cache = new Map<string, Bound>();
  for (const name of expandTraitNames(options.traitNames, options.traits, options.harness)) {
    const trait = options.traits[name];
    if (trait.harnessTraits && !options.harness) throw new Error(`trait ${name} requires the running harness to resolve its policy`);
    bound = mergeBounds(bound, trait.bound ?? null);
    for (const reference of trait.boundNames ?? []) {
      let value = cache.get(reference);
      if (!value) {
        value = (await options.boundByName(reference)) ?? undefined;
        if (!value) throw new Error(`trait ${name} references unknown bound ${reference}`);
        cache.set(reference, value);
      }
      bound = mergeBounds(bound, value);
    }
  }
  for (const value of options.bounds ?? []) bound = mergeBounds(bound, value ?? null);
  return bound;
}

export function nativeToolDenials(bound: Bound | null | undefined, harness: string, inventory: readonly string[]): string[] {
  const denied = bound?.nativeTools?.[harness] ?? [];
  const unknown = denied.filter((tool) => !inventory.includes(tool));
  if (unknown.length) throw new Error(`harness ${harness} has no native tools: ${unknown.join(", ")}`);
  return inventory.filter((tool) => denied.includes(tool));
}
