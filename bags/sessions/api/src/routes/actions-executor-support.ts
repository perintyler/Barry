// Pure helpers, constants and sentinels for the detached action executor.
// Extracted verbatim from actions.ts for file size; no behavior change.
import { hardCeilingMs } from "@barry-rocks/schedules-bag";

/** How long the executor waits for a job run: its timeout, plus the scheduler's slack to notice and record it. */
export const hardCeilingS = (timeoutS: number) => Math.ceil(hardCeilingMs(timeoutS) / 1000) + 10;

/** Default and ceiling for how long a detached run may take, in seconds. */
export const DEFAULT_TIMEOUT_S = 300;
export const MAX_TIMEOUT_S = 600;
/**
 * Ceiling for a timeout the ACTION declares. Higher than a caller's, because
 * the manifest is the author's considered bound (a weekly digest legitimately
 * takes longer than ten minutes) while a request's is anyone's.
 */
export const MAX_DECLARED_TIMEOUT_S = 3600;

/**
 * The deliverable an agent action with no output_schema is run for: its
 * report, as text. Recorded as the run's summary rather than its output, so
 * "a run has output iff its action declared one" still holds.
 */
export const REPORT_SCHEMA: Record<string, unknown> = { type: "string" };
export const MAX_REPORT_SUMMARY_CHARS = 4000;

/**
 * Turns a detached run may take. An installed action is a known procedure,
 * sized for the lower cap; an ad-hoc one is often open-ended exploration,
 * which would run out of turns before it finished reading, so it gets the
 * same cap a session has.
 */
export const BAG_RUN_MAX_TURNS = 15;
export const ADHOC_RUN_MAX_TURNS = 50;

/** Sentinel so the catch can tell "the clock ran out" (504) from "the run
 * machinery failed" (502): both close the run failed, but they mean
 * different things to the caller. */
export class ExecutorTimeout extends Error {
  constructor() {
    super("action executor timed out");
  }
}

/** Sentinel for a run stopped through POST /actions/runs/:id/cancel. Kept
 * apart from ExecutorTimeout: a timeout is not a cancel, and must never close
 * a run as one. */
export class ExecutorCancelled extends Error {
  constructor(readonly reason: string) {
    super(`action run cancelled: ${reason}`);
  }
}

/**
 * The `wait_s` deadline, as a race participant.
 *
 * A unique symbol rather than a timeout rejection: this is not a failure, and
 * an error here would be indistinguishable from `ExecutorTimeout` (which DOES
 * mean the run is over). Winning the race means only "stop waiting" — the run
 * is untouched and still holds its slot until it settles.
 */
export const WAIT_ELAPSED = Symbol("wait-elapsed");

export function waitElapsed(seconds: number): Promise<typeof WAIT_ELAPSED> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(WAIT_ELAPSED), seconds * 1000);
    // Never hold the process open for a wait nobody is watching.
    t.unref?.();
  });
}

/** Longest agent error a run row keeps; the API log keeps the whole message. */
export const MAX_FAILURE_REASON_CHARS = 2000;

/**
 * What a run's row says when its agent ended without a result. Recorded on
 * the row because the caller that saw the 502 or 504 may be a schedule or a
 * `wait_s` poller that has gone, and the only other copy is the API's log.
 */
export function agentFailureReason(err: unknown, timedOutAfterS: number | null): string {
  if (timedOutAfterS !== null) return `Timed out after ${timedOutAfterS}s; the agent was stopped.`;
  const message = err instanceof Error ? err.message : String(err);
  return `The run failed: ${message.slice(0, MAX_FAILURE_REASON_CHARS)}`;
}

/**
 * Detached runs whose agent is still running, keyed by run id, mapped to the
 * function that stops it.
 *
 * The API owns each run's AbortController, so this is the only place a cancel
 * can actually stop the agent: `cancel_action` runs in the engine and could
 * only close the row, leaving the agent to run on under a row that said
 * cancelled. An entry lives only while the agent does -- it is removed the
 * moment the run settles, before any later request is handled -- so a cancel
 * either stops a running agent or finds nothing to stop. It can never mark a
 * run that already finished as cancelled.
 */
export const runningAgents = new Map<string, (reason: string) => void>();

/**
 * Native structured output wants an object root (the SDK's response-format
 * enforcement rejects bare string/number/array schemas), but actions may
 * declare any JSON Schema root. Non-object roots run wrapped in
 * `{value: <schema>}` and are unwrapped after — callers never see the wrapper.
 */
export function wrapSchemaRoot(schema: Record<string, unknown>): {
  runSchema: Record<string, unknown>;
  wrapped: boolean;
} {
  // A string root is the final message itself (runStructured takes it as
  // such), so it needs no object to carry it.
  if (schema.type === "object" || schema.type === "string") return { runSchema: schema, wrapped: false };
  return {
    runSchema: {
      type: "object",
      properties: { value: schema },
      required: ["value"],
      additionalProperties: false,
    },
    wrapped: true,
  };
}
