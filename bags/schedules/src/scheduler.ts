/**
 * The scheduler: decides what is due, starts it, and records what happened.
 *
 * One process runs every schedule, instead of one launchd plist per job. That
 * is what makes cron, timezones, one-off runs and pause possible, and keeps
 * secrets out of plists. The cost is a single point of failure, so the loop
 * writes a heartbeat every tick and the API raises an alert when it goes
 * stale (see health.ts) — a dead scheduler must not look like a quiet one.
 *
 * Everything that touches the outside world arrives through SchedulerDeps, so
 * the rules below are tested against a fake clock and fake runners.
 */

import type { ActionMeta } from "@barry-rocks/sdk/internal/actions";
import type { ScheduleTrigger } from "@barry-rocks/sdk/internal/schedules";
import type { ScheduleEntry, ScheduleListing } from "./catalog.js";
import { decide, firstFire, nextAfterFiring } from "./next-fire.js";
import { claimLoginEvent, countSkippedFire, listStates, updateState, writeHeartbeat, type ScheduleState } from "./store.js";
import { claimDue, finishAttempt, type FinishOutcome, type OneOff, type OneOffKind } from "./one-offs.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("schedules.scheduler", { transport: "stderr" });


/** How a one-off attempt ended, as its runner reports it. */
export interface OneOffResult {
  outcome: FinishOutcome;
  exitCode: number | null;
  runId: string | null;
  reason?: string;
}

/** Action one-off attempts running at once; the rest wait their turn, still pending. */
export const MAX_ONE_OFFS_RUNNING = 4;

/**
 * Job runs at once — a budget of their own. Jobs arrive from the SDK and from
 * subagents in bursts, and a shared cap would let a burst hold every slot a
 * schedule's one-off needs (or the other way round).
 */
export const MAX_JOB_RUNS_RUNNING = 8;

/** What one fire produced, however it ran. */
export interface FireOutcome {
  status: "complete" | "failed";
  runId: string | null;
  summary: string;
}

export type Transition = "failure" | "recovery";

export interface SchedulerDeps {
  listSchedules(): Promise<ScheduleListing>;
  resolveAction(entry: ScheduleEntry): Promise<ActionMeta>;
  /** Run a `run:` action here, in the scheduler's process. */
  runScript(action: ActionMeta, entry: ScheduleEntry): Promise<FireOutcome>;
  /** Run an agent action through the API executor. */
  runAgent(entry: ScheduleEntry): Promise<FireOutcome>;
  /** Fire a `job:` schedule: start its job run and wait for it (job-fires.ts). */
  runJob(entry: ScheduleEntry): Promise<FireOutcome>;
  /** Tell a human a schedule started failing or recovered. False if it could not be delivered. */
  announce(entry: ScheduleEntry, transition: Transition, outcome: FireOutcome): Promise<boolean>;
  /** Run one attempt of a one-off (`attempt` counts from 1). Should report failure as a result, not throw. */
  runOneOff(oneOff: OneOff, attemptId: string, attempt: number): Promise<OneOffResult>;
  /** Settle one-offs a dead runner left running (see recoverOrphans). */
  recoverOneOffs(): void;
  /** This process, as recorded on the attempts it claims. */
  runner: { pid: number; startedAt: number | null };
  /** The verified current OS login event; null means unavailable. */
  loginEventId(): string | null;
  now(): Date;
}

/** How often the schedule list is reloaded from bags. Cheap, and edits land without a restart. */
export const RELOAD_EVERY_MS = 60_000;

/** A stable spelling of a trigger, to tell when a bag.yaml edit changed it. */
export function triggerKey(trigger: ScheduleTrigger): string {
  return JSON.stringify(trigger);
}

export class Scheduler {
  private listing: ScheduleListing = { schedules: [], errors: [] };
  private loadedAt = 0;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly oneOffsInFlight = new Map<string, { kind: OneOffKind; run: Promise<void> }>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** Runs still going, for a clean shutdown. */
  get running(): Promise<void>[] {
    return [...this.inFlight.values(), ...[...this.oneOffsInFlight.values()].map((o) => o.run)];
  }

  /** Force the next tick to reload schedules. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  async tick(): Promise<void> {
    const now = this.deps.now();
    if (now.getTime() - this.loadedAt >= RELOAD_EVERY_MS) {
      this.listing = await this.deps.listSchedules();
      this.loadedAt = now.getTime();
    }

    const states = listStates();
    for (const entry of this.listing.schedules) {
      if (!entry.schedule.enabled) continue;
      this.consider(entry, states.get(entry.id) ?? null, now);
    }
    await this.retryAnnouncements(states);
    this.tickOneOffs(now);
    writeHeartbeat(this.listing.schedules.length, this.listing.errors);
  }

  /** Recover what a dead runner left, then start due one-offs while each budget has room. */
  private tickOneOffs(now: Date): void {
    this.deps.recoverOneOffs();
    for (const [kind, cap] of [["action", MAX_ONE_OFFS_RUNNING], ["job", MAX_JOB_RUNS_RUNNING]] as const) {
      const running = [...this.oneOffsInFlight.values()].filter((o) => o.kind === kind).length;
      const claims = claimDue({
        now,
        kind,
        limit: cap - running,
        runnerPid: this.deps.runner.pid,
        runnerStartedAt: this.deps.runner.startedAt,
      });
      for (const claim of claims) this.startOneOff(kind, claim.oneOff, claim.attemptId, claim.attempt);
    }
  }

  private startOneOff(kind: OneOffKind, oneOff: OneOff, attemptId: string, attempt: number): void {
    const run = this.deps
      .runOneOff(oneOff, attemptId, attempt)
      .catch((error: unknown): OneOffResult => ({
        // A runner that threw is a bug in it, not the action failing — but
        // the attempt still has to close, or it would sit `running` until
        // the next scheduler restart re-ran it.
        outcome: "failed",
        exitCode: null,
        runId: null,
        reason: `runner error: ${error instanceof Error ? error.message : String(error)}`,
      }))
      .then((result) => {
        finishAttempt({
          oneOffId: oneOff.id,
          attemptId,
          outcome: result.outcome,
          exitCode: result.exitCode,
          runId: result.runId,
          ...(result.reason ? { reason: result.reason } : {}),
          now: this.deps.now(),
        });
      })
      .finally(() => this.oneOffsInFlight.delete(attemptId));
    this.oneOffsInFlight.set(attemptId, { kind, run });
  }

  private consider(entry: ScheduleEntry, state: ScheduleState | null, now: Date): void {
    const { trigger, catchUp, overlap } = entry.schedule;
    const key = triggerKey(trigger);

    // First sight, or the trigger changed under a stored due time: compute a
    // fresh one. (A one-off `at` that already fired has next_fire_at null and
    // the same key, so it stays done.)
    if (!state || state.trigger_key !== key) {
      updateState(entry.id, { trigger_key: key, next_fire_at: firstFire(trigger, now) });
      return;
    }
    if (state.paused) return;

    if (trigger.kind === "login") {
      if (!this.inFlight.has(entry.id) && claimLoginEvent(entry.id, this.deps.loginEventId(), now)) {
        this.start(entry);
      }
      return;
    }

    const decision = decide(state.next_fire_at, catchUp, now);
    if (decision.kind === "wait") return;
    const next = nextAfterFiring(trigger, now);

    if (decision.kind === "miss") {
      countSkippedFire(entry.id, "missed");
      updateState(entry.id, { next_fire_at: next });
      return;
    }

    if (this.inFlight.has(entry.id)) {
      // A due fire while the last run is still going. `skip` drops it;
      // `queue` runs once more when the current run ends — once, however many
      // fires land meanwhile.
      if (overlap === "queue") this.queued.add(entry.id);
      else countSkippedFire(entry.id, "skipped");
      updateState(entry.id, { next_fire_at: next });
      return;
    }

    updateState(entry.id, { last_fired_at: now, next_fire_at: next });
    this.start(entry);
  }

  private start(entry: ScheduleEntry): void {
    const run = this.fire(entry)
      .then(() => undefined)
      .catch((error: unknown) => {
        // fire() records its own failures; this is the last line for a bug in
        // it, so the schedule is not left looking "in flight" forever.
        diagnostics.error("schedules.entry_failed", { detail: `schedules: ${entry.id} crashed: ${error instanceof Error ? error.stack : String(error)}` });
      })
      .finally(() => {
        this.inFlight.delete(entry.id);
        if (this.queued.delete(entry.id)) {
          updateState(entry.id, { last_fired_at: this.deps.now() });
          this.start(entry);
        }
      });
    this.inFlight.set(entry.id, run);
  }

  /** Run a schedule once and record the outcome. Exposed for "run now". */
  async fire(entry: ScheduleEntry): Promise<FireOutcome> {
    let outcome: FireOutcome;
    try {
      if (entry.schedule.payload.kind === "job") {
        outcome = await this.deps.runJob(entry);
      } else {
        const action = await this.deps.resolveAction(entry);
        outcome = action.run !== undefined
          ? await this.deps.runScript(action, entry)
          : await this.deps.runAgent(entry);
      }
    } catch (error) {
      // Could not even start: a missing action, inputs its schema refuses, an
      // unreachable API. No run row exists, so the reason lives on the state
      // and in the alert — it must not vanish into a log.
      outcome = { status: "failed", runId: null, summary: error instanceof Error ? error.message : String(error) };
    }
    await this.record(entry, outcome);
    return outcome;
  }

  private async record(entry: ScheduleEntry, outcome: FireOutcome): Promise<void> {
    const before = listStates().get(entry.id);
    const failing = outcome.status === "failed";
    const wasFailing = (before?.consecutive_failures ?? 0) > 0;
    updateState(entry.id, {
      last_run_id: outcome.runId,
      last_status: outcome.status,
      last_summary: outcome.summary.slice(0, 2000),
      consecutive_failures: failing ? (before?.consecutive_failures ?? 0) + 1 : 0,
      ...(failing ? {} : { failure_announced: false }),
    });

    if (failing && !wasFailing) {
      const delivered = await this.deps.announce(entry, "failure", outcome);
      updateState(entry.id, { failure_announced: delivered });
    } else if (!failing && wasFailing && before?.failure_announced) {
      // Only a failure someone was told about gets a recovery notice.
      await this.deps.announce(entry, "recovery", outcome);
    }
  }

  /** Re-send failure alerts that could not be delivered when they happened. */
  private async retryAnnouncements(states: Map<string, ScheduleState>): Promise<void> {
    for (const entry of this.listing.schedules) {
      const state = states.get(entry.id);
      if (!state || state.consecutive_failures === 0 || state.failure_announced) continue;
      const delivered = await this.deps.announce(entry, "failure", {
        status: "failed",
        runId: state.last_run_id,
        summary: `failing (${state.consecutive_failures} in a row)`,
      });
      if (delivered) updateState(entry.id, { failure_announced: true });
    }
  }
}
