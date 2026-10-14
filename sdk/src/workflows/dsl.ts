// Dependency-free authoring surface for self-contained artifact bundles.
// The owner/evaluator validates every emitted command at its trust boundary.
import type { ActivityCommand, ActivityOptions, Json, LeafCommand, WorkflowCommand } from "./types.js";
export type { Activity, ActivityContext, WorkflowDefinition, Json } from "./types.js";
export const activity = (type: string, input: Json, options: ActivityOptions = {}): ActivityCommand => ({
  kind: "activity", type, input, timeoutMs: options.timeoutMs ?? 86_400_000,
  attemptTimeoutMs: options.attemptTimeoutMs ?? 60_000, heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 15_000,
  retry: { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 60_000, ...options.retry },
  placement: { requires: {}, preferNodes: [], prefer: {}, ...options.placement },
});
export const sleep = (delayMs: number): LeafCommand => ({ kind: "timer", delayMs });
export const signal = (name: string, timeoutMs = 86_400_000): LeafCommand => ({ kind: "signal", name, timeoutMs });
export const now = (): LeafCommand => ({ kind: "now" });
export const random = (): LeafCommand => ({ kind: "random" });
export const all = (commands: LeafCommand[]): WorkflowCommand => ({ kind: "all", commands });
export class ActivityFailure extends Error {
  constructor(message: string, readonly code = "ActivityFailed") { super(message); this.name = "ActivityFailure"; }
}
