/** Inject hook dispatch so event writes do not import registry discovery or process spawning. */

/** What a hook is told. Mirrors engine's BarryHookPayload, structurally. */

import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("events.hooks", { transport: "stderr" });
export interface EventHookPayload {
  event: "event-created";
  id: string;
  record: Record<string, unknown>;
}

/** One hook's outcome, as the dispatcher reports it. */
export interface EventHookOutcome {
  bag: string;
  ok: boolean;
  durationMs: number;
  reason?: string;
}

export type EventHookDispatcher = (payload: EventHookPayload) => Promise<EventHookOutcome[]>;

let dispatcher: EventHookDispatcher | null = null;

/** Registered by the engine at startup; pass null to unregister (tests). */
export function setEventHookDispatcher(next: EventHookDispatcher | null): void {
  dispatcher = next;
}

export function hasEventHookDispatcher(): boolean {
  return dispatcher !== null;
}

/**
 * Fire hooks for one event, reporting every failure.
 *
 * Never throws and never rejects: the row is already committed by the time this
 * runs, so a hook problem must not reach the caller. But nothing is swallowed
 * either — a hook that quietly stops firing is the failure this codebase treats
 * as worse than no hook at all, so every bad outcome is named with its bag.
 */
export async function fireEventHooks(payload: EventHookPayload): Promise<EventHookOutcome[]> {
  if (!dispatcher) return [];
  try {
    const outcomes = await dispatcher(payload);
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        diagnostics.warn("events.hook_failed", { detail: `events: hook from bag "${outcome.bag}" failed for ${payload.id} — ${outcome.reason ?? "no reason given"}` });
      }
    }
    return outcomes;
  } catch (err) {
    // The dispatcher itself broke, which is a different failure from a hook
    // failing and would otherwise look identical to "no bags have hooks".
    diagnostics.warn("events.hook_dispatch_failed", { detail: `events: hook dispatch failed for ${payload.id} — ${err instanceof Error ? err.message : String(err)}` });
    return [];
  }
}
