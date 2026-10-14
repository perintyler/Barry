import {
  resolveEffectiveBound,
  type Bound,
  type AgentTrait,
} from "../bounds/index.js";
import { selectTraits, expandTraits } from "../traits/index.js";
/** Shared effective policy for interactive, hosted, scheduled and MCP interfaces. */
export async function resolveSessionPolicy(input: {
  defaults?: readonly string[];
  identity?: {
    traits?: readonly string[];
    bags?: readonly string[];
    bag_grant?: "identity" | "session";
  };
  session?: readonly string[];
  traits: Record<string, AgentTrait>;
  harness?: string;
  bounds?: readonly (Bound | null | undefined)[];
  boundByName(this: void, name: string): Promise<Bound | undefined>;
}): Promise<{ traits: string[]; bound: Bound | null }> {
  // Explicit selections must resolve; absent installation defaults grant nothing.
  expandTraits(
    selectTraits({ identity: input.identity, session: input.session }),
    input.traits,
    input.harness,
  );
  const traits = selectTraits(input);
  const bound = await resolveEffectiveBound({
    traitNames: traits,
    traits: input.traits,
    harness: input.harness,
    bounds: input.bounds,
    boundByName: input.boundByName,
  });
  return { traits, bound };
}
