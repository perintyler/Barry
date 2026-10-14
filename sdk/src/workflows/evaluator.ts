import { ActivityFailure, encode, encodeCommand, type Json, type Outcome, type WorkflowDefinition, type WorkflowCommand } from "./types.js";
import { z } from "zod";

export interface ReplaySnapshot {
  input: Json;
  groups: { definition: string; outcomes: (Outcome | null)[] }[];
}
export type Proposal =
  | { kind: "waiting" }
  | { kind: "group"; position: number; definition: string }
  | { kind: "complete"; value: Json }
  | { kind: "failed" | "blocked"; message: string };

export function validateProposal(value: unknown, snapshot: ReplaySnapshot): Proposal {
  const proposal = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("waiting") }),
    z.strictObject({ kind: z.literal("group"), position: z.number().int().nonnegative(), definition: z.string() }),
    z.strictObject({ kind: z.literal("complete"), value: z.json() }),
    z.strictObject({ kind: z.enum(["failed", "blocked"]), message: z.string().max(4096) }),
  ]).parse(value);
  if (proposal.kind === "group") {
    if (proposal.position !== snapshot.groups.length || snapshot.groups.some(group => group.outcomes.includes(null))) throw new Error("proposal skipped recorded work");
    proposal.definition = encodeCommand(JSON.parse(proposal.definition));
  }
  if (proposal.kind === "complete") { encode(proposal.value); if (snapshot.groups.some(group => group.outcomes.includes(null))) throw new Error("proposal skipped unresolved work"); }
  return proposal;
}

/** Pure interpreter: no storage, clocks, transport or side effects. */
export function evaluate(definition: WorkflowDefinition, snapshot: ReplaySnapshot): Proposal {
  let position = 0;
  try {
    const generator = definition.run(snapshot.input);
    if (!generator || typeof generator.next !== "function" || Symbol.asyncIterator in generator) return { kind: "blocked", message: "workflow must return a synchronous generator" };
    let step = generator.next();
    while (!step.done) {
      if (position >= 1000) return { kind: "blocked", message: "workflow command limit reached" };
      let serialized: string;
      try { serialized = encodeCommand(step.value); }
      catch (error) { return { kind: "blocked", message: String(error).slice(0, 4096) }; }
      const recorded = snapshot.groups[position];
      if (!recorded) return { kind: "group", position, definition: serialized };
      if (serialized !== recorded.definition) return { kind: "blocked", message: `command ${position} differs from history` };
      if (recorded.outcomes.some(value => value === null)) return { kind: "waiting" };
      const outcomes = recorded.outcomes as Outcome[];
      const failure = outcomes.find(value => !value.ok);
      position++;
      if (failure && !failure.ok) step = generator.throw(new ActivityFailure(failure.error.message, failure.error.code));
      else {
        const values = outcomes.map(value => value.ok ? value.value : null);
        step = generator.next((JSON.parse(serialized) as WorkflowCommand).kind === "all" ? values : values[0]);
      }
    }
    if (position < snapshot.groups.length) return { kind: "blocked", message: "workflow returned before recorded command" };
    return { kind: "complete", value: JSON.parse(encode(step.value)) as Json };
  } catch (error) {
    return { kind: position < snapshot.groups.length ? "blocked" : "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) };
  }
}
