/**
 * Delivers recorded schedule occurrences to their executor generation, and
 * settles what a dead dispatcher left behind (P4.3/P4.5 preparation).
 *
 * The generation is chosen once, when the occurrence is recorded, and read
 * back from the ledger every time after — a restart, a lost reply or a later
 * configuration change cannot move an occurrence to a different owner.
 *
 * - `work.v2`: canonical Work admission through WorkProducerAdmission. After
 *   possible admission it is observed by its original key and, if not found,
 *   redelivered as the identical submission. It never runs locally.
 * - `legacy` job: the existing one-off path, keyed by the occurrence's key,
 *   so the one-off row IS the acceptance record. A dead dispatcher's
 *   occurrence is recovered by looking that row up, never by a second run.
 * - `legacy` script/agent: the existing runners, which have no idempotency.
 *   A dead dispatcher's occurrence becomes `unknown` and stays there for a
 *   human: whether it ran cannot be known, and running it again is the one
 *   thing this never does.
 */

import type { ScheduleEntry } from "./registry.js";
import type { AtSchedule } from "./at-schedules.js";
import type { FireOutcome } from "./scheduler.js";
import type { ProcessState } from "./process.js";
import type { AdmissionResult, WorkProducerAdmission, WorkProducerDispatchPort, WorkProducerOccurrence, WorkProducerOrigin } from "./work-producer-admission.js";
import type { WorkSubmission } from "@barry-rocks/sdk/internal/workflows";
import {
  abandonedDispatches,
  beginDispatch,
  bindAuthority,
  getOccurrence,
  markAccepted,
  markRefused,
  markUnknown,
  recordOutcome,
  type OccurrenceDispatch,
  type ProducerOccurrence,
} from "./work-producer-occurrences.js";
import { getDb } from "./db.js";

/** A retry time that never comes: the occurrence waits for a human, visibly. ISO text compares as text, so it must stay four-digit. */
const NEVER = new Date("9999-12-31T23:59:59.999Z");

/** The existing legacy runners, as the dispatcher needs them. */
export interface LegacyOccurrenceRunners {
  /** Accept a job occurrence as an at-schedule keyed by the occurrence's admission key (job-fires.ts). */
  acceptJob(entry: ScheduleEntry, occurrence: ProducerOccurrence): Promise<AtSchedule>;
  /** Wait for an accepted job at-schedule and say what it meant for the schedule. */
  awaitJob(schedule: AtSchedule): Promise<FireOutcome>;
  /** The job at-schedule an occurrence's key already created, if any. */
  findJobOneOff(occurrence: ProducerOccurrence): AtSchedule | null;
  /** Run a script or agent action (scheduler.ts runScript/runAgent). */
  runAction(entry: ScheduleEntry): Promise<FireOutcome>;
}

export type DispatchResult =
  /** A legacy runner ran it to an outcome. */
  | { kind: "ran"; outcome: FireOutcome }
  /** Accepted by an owner; the outcome is the owner's to report. */
  | { kind: "accepted"; workId: string; workflowId: string | null; recovered: boolean }
  /** Admission may have happened; observe again later with the same key. */
  | { kind: "unknown"; code: string; message: string }
  /** Refused for good; a human decides. */
  | { kind: "refused"; code: string; message: string }
  /** Not dispatchable now (accepted, refused, owned elsewhere, not due). */
  | { kind: "skipped"; state: string };

/** The ledger as WorkProducerAdmission's store port. */
export function ledgerDispatchPort(now: () => Date): WorkProducerDispatchPort {
  return {
    bindAuthority: (id, binding) => bindAuthority(id, binding, now()),
    markAccepted: (id, accepted) => markAccepted(id, accepted, now()),
    markUnknown: (id, error, retryAt) => markUnknown(id, error, retryAt, now()),
    markRefused: (id, error) => markRefused(id, error, now()),
  };
}

/** Where a schedule occurrence enters Work: the scheduler, or a manual run. */
export function occurrenceOrigin(occurrence: ProducerOccurrence): WorkProducerOrigin {
  return {
    entry_point: occurrence.kind === "manual" ? "schedules.manual" : "schedules.scheduler",
    trigger: occurrence.kind === "manual" ? "manual" : "schedule",
    occurrence_id: occurrence.occurrenceId,
    producer_ref: occurrence.producerRef,
  };
}

/**
 * The Work submission an occurrence is, from its stored fields only. Inline
 * actions have no Work definition and stay on the legacy generation.
 */
export function occurrenceSubmission(occurrence: ProducerOccurrence): WorkProducerOccurrence["submission"] {
  const { definition } = occurrence;
  if (definition.kind === "inline") throw new Error(`occurrence ${occurrence.occurrenceId} runs an inline action, which has no Work definition`);
  // Round-trip through JSON: the stored inputs are JSON already, and this
  // gives the submission a plain JSON value rather than a live object.
  const inputs: WorkSubmission["inputs"] = JSON.parse(JSON.stringify(occurrence.inputs));
  return {
    version: 2,
    request_id: occurrence.requestId,
    idempotency_key: occurrence.idempotencyKey,
    definition,
    inputs,
    origin: occurrenceOrigin(occurrence),
  };
}

function adapterOccurrence(occurrence: ProducerOccurrence, dispatch: OccurrenceDispatch, possiblyAdmitted: boolean): WorkProducerOccurrence {
  return {
    occurrenceId: occurrence.occurrenceId,
    executorGeneration: occurrence.executorGeneration,
    submission: occurrenceSubmission(occurrence),
    selection: occurrence.context,
    possiblyAdmitted,
    boundAuthorityRef: dispatch.authorityRef,
    boundRequestHash: dispatch.requestHash,
  };
}

/** Whether an occurrence in `unknown` may be observed/redelivered without risking a second effect. */
export function recoverable(occurrence: ProducerOccurrence): boolean {
  return occurrence.executorGeneration === "work.v2" || occurrence.definition.kind === "job";
}

export class ScheduleOccurrenceDispatcher {
  constructor(
    private readonly deps: {
      /** Null keeps every occurrence on the legacy generation; a work.v2 occurrence then waits, visible, for one. */
      admission: WorkProducerAdmission | null;
      legacy: LegacyOccurrenceRunners;
      runner: { pid: number; startedAt: number | null };
      probe: (pid: number, startedAt: number | null) => ProcessState;
      now: () => Date;
    },
  ) {}

  /**
   * Deliver one recorded occurrence. Returns `skipped` when it is not
   * dispatchable by this process right now. `entry` is the schedule as
   * currently loaded; it is used only by legacy runners, never to change the
   * stored occurrence.
   */
  async dispatch(occurrenceId: string, entry: ScheduleEntry | null): Promise<DispatchResult> {
    const before = getOccurrence(occurrenceId);
    if (!before) throw new Error(`occurrence ${occurrenceId} is not recorded`);
    const { occurrence } = before;
    if (before.dispatch.state === "unknown" && !recoverable(occurrence)) return { kind: "skipped", state: "unknown" };
    if (occurrence.executorGeneration === "work.v2" && !this.deps.admission) return { kind: "skipped", state: before.dispatch.state };
    const possiblyAdmitted = before.dispatch.state === "unknown";
    const now = this.deps.now();
    const claimed = beginDispatch(occurrenceId, this.deps.runner, now);
    if (!claimed) return { kind: "skipped", state: before.dispatch.state };

    if (occurrence.executorGeneration === "work.v2") {
      return this.fromAdmission(await this.deps.admission!.admit(adapterOccurrence(occurrence, claimed, possiblyAdmitted), claimed.attempts));
    }
    if (!entry) {
      // A legacy runner needs the schedule; without it nothing has started.
      markUnknown(occurrenceId, { code: "undelivered:schedule_unloaded", message: "the schedule is no longer loaded" }, new Date(now.getTime() + 60_000), this.deps.now());
      return { kind: "unknown", code: "undelivered:schedule_unloaded", message: "the schedule is no longer loaded" };
    }
    if (occurrence.definition.kind === "job") return this.legacyJob(occurrence, entry, possiblyAdmitted);
    return this.legacyAction(occurrence, entry);
  }

  private fromAdmission(result: AdmissionResult): DispatchResult {
    switch (result.state) {
      case "accepted":
        return { kind: "accepted", workId: result.workId, workflowId: result.workflowId, recovered: result.recovered };
      case "unknown":
        return { kind: "unknown", code: result.code, message: result.message };
      case "refused":
        return { kind: "refused", code: result.code, message: result.message };
    }
  }

  private async legacyJob(occurrence: ProducerOccurrence, entry: ScheduleEntry, possiblyAdmitted: boolean): Promise<DispatchResult> {
    const now = this.deps.now();
    let oneOff: AtSchedule | null = possiblyAdmitted ? this.deps.legacy.findJobOneOff(occurrence) : null;
    const recovered = oneOff !== null;
    if (!oneOff) {
      try {
        // Keyed by the occurrence: a repeat after a crash replays the same at-schedule.
        oneOff = await this.deps.legacy.acceptJob(entry, occurrence);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // createAtSchedule either committed (then findJobOneOff sees it next time)
        // or did not; both are safe to look up and replay by key.
        markUnknown(occurrence.occurrenceId, { code: "legacy_job_accept", message }, new Date(now.getTime() + 60_000), this.deps.now());
        return { kind: "unknown", code: "legacy_job_accept", message };
      }
    }
    markAccepted(occurrence.occurrenceId, { workId: oneOff.id, workflowId: null }, this.deps.now());
    const outcome = await this.deps.legacy.awaitJob(oneOff);
    recordOutcome(occurrence.occurrenceId, outcome.status, this.deps.now());
    return { kind: "ran", outcome: recovered ? { ...outcome, summary: `recovered accepted one-off ${oneOff.id}: ${outcome.summary}` } : outcome };
  }

  private async legacyAction(occurrence: ProducerOccurrence, entry: ScheduleEntry): Promise<DispatchResult> {
    let outcome: FireOutcome;
    try {
      outcome = await this.deps.legacy.runAction(entry);
    } catch (error) {
      // It may have started (an agent run reaches the API before failing).
      // Report the failure to the schedule, but keep the occurrence unknown
      // rather than claiming it never ran — and never run it again.
      const message = error instanceof Error ? error.message : String(error);
      markUnknown(occurrence.occurrenceId, { code: "legacy_start_error", message }, NEVER, this.deps.now());
      return { kind: "ran", outcome: { status: "failed", runId: null, summary: message } };
    }
    markAccepted(occurrence.occurrenceId, { workId: outcome.runId ?? `legacy:${occurrence.occurrenceId}`, workflowId: null }, this.deps.now());
    recordOutcome(occurrence.occurrenceId, outcome.status, this.deps.now());
    return { kind: "ran", outcome };
  }

  /**
   * Settle `dispatching` rows whose dispatcher is gone. Every one of them may
   * have been admitted or launched, so each becomes `unknown` — recoverable
   * ones (Work, legacy jobs) are observed by key on their next dispatch;
   * legacy script/agent ones stay for a human. A dispatcher that is still
   * alive, or whose identity cannot be read, is left alone.
   */
  recoverAbandoned(): Array<{ occurrenceId: string; action: "left-alive" | "unknown" | "needs-attention" }> {
    const now = this.deps.now();
    const settled: Array<{ occurrenceId: string; action: "left-alive" | "unknown" | "needs-attention" }> = [];
    for (const { occurrence, dispatch } of abandonedDispatches(this.deps.runner)) {
      const state = dispatch.dispatcherPid === null ? "gone" : this.deps.probe(dispatch.dispatcherPid, dispatch.dispatcherStartedAt);
      if (state !== "gone") {
        settled.push({ occurrenceId: occurrence.occurrenceId, action: "left-alive" });
        continue;
      }
      if (recoverable(occurrence)) {
        markUnknown(occurrence.occurrenceId, { code: "dispatcher_died", message: `dispatcher pid ${dispatch.dispatcherPid ?? "?"} stopped mid-dispatch; observing the original key` }, now, now);
        settled.push({ occurrenceId: occurrence.occurrenceId, action: "unknown" });
      } else {
        markUnknown(occurrence.occurrenceId, { code: "legacy_outcome_unknown", message: `dispatcher pid ${dispatch.dispatcherPid ?? "?"} stopped while the run may have been going; not run again` }, NEVER, now);
        settled.push({ occurrenceId: occurrence.occurrenceId, action: "needs-attention" });
      }
    }
    return settled;
  }

  /** Wait on an accepted legacy job one-off and record what it meant. Observation only: nothing is created or run. */
  async observeAccepted(occurrenceId: string, oneOffId: string): Promise<FireOutcome> {
    const oneOff = this.deps.legacy.findJobOneOff(getOccurrence(occurrenceId)!.occurrence);
    if (!oneOff || oneOff.id !== oneOffId) throw new Error(`accepted one-off ${oneOffId} for ${occurrenceId} is gone`);
    const outcome = await this.deps.legacy.awaitJob(oneOff);
    recordOutcome(occurrenceId, outcome.status, this.deps.now());
    return outcome;
  }

  /**
   * Legacy job occurrences that were accepted but whose outcome was never
   * recorded (the dispatcher died while waiting). Awaiting the existing
   * one-off is observation only; nothing runs again.
   */
  acceptedWithoutOutcome(): Array<{ occurrenceId: string; oneOffId: string }> {
    return (getDb().prepare(
      `SELECT d.occurrence_id, d.work_id FROM work_producer_dispatch d JOIN work_producer_occurrence o ON o.occurrence_id = d.occurrence_id
        WHERE d.state = 'accepted' AND d.outcome IS NULL AND o.executor_generation = 'legacy' AND json_extract(o.definition_json, '$.kind') = 'job'`,
    ).all() as Array<{ occurrence_id: string; work_id: string }>).map((r) => ({ occurrenceId: r.occurrence_id, oneOffId: r.work_id }));
  }
}
