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
import type { ScheduleEntry, ScheduleListing } from "./registry.js";
import { countDueSlots, decide, firstFire, nextAfterFiring } from "./next-fire.js";
import { claimLoginEvent, countSkippedFire, listStates, updateState, writeHeartbeat, type ScheduleState } from "./store.js";
import { claimDue, finishAttempt, type FinishOutcome, type AtSchedule, type AtScheduleKind } from "./at-schedules.js";
import {
  MAX_COUNTED_SLOTS,
  claimLoginOccurrence,
  dueOccurrences,
  getOccurrence,
  newScheduleOccurrence,
  owedQueuedOccurrence,
  pendingNotifications,
  recordNotificationIntent,
  recordOccurrence,
  settleNotification,
  workEligibility,
  type ExecutorGeneration,
} from "./work-producer-occurrences.js";
import type { DispatchResult, ScheduleOccurrenceDispatcher } from "./work-producer-dispatcher.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("schedules.scheduler", { transport: "stderr" });


/** How an at-schedule attempt ended, as its runner reports it. */
export interface AtScheduleResult {
  outcome: FinishOutcome;
  exitCode: number | null;
  runId: string | null;
  reason?: string;
}

/** Action schedule attempts running at once; the rest wait their turn, still pending. */
export const MAX_AT_SCHEDULES_RUNNING = 4;

/**
 * Job runs at once — a budget of their own. Jobs arrive from the SDK and from
 * subagents in bursts, and a shared cap would let a burst hold every slot a
 * schedule needs (or the other way round).
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
  /** Run one attempt of an at-schedule (`attempt` counts from 1). Should report failure as a result, not throw. */
  runAtSchedule(schedule: AtSchedule, attemptId: string, attempt: number): Promise<AtScheduleResult>;
  /** Settle schedules a dead runner left running (see recoverOrphans). */
  recoverAtSchedules(): void;
  /** This process, as recorded on the attempts it claims. */
  runner: { pid: number; startedAt: number | null };
  /** The verified current OS login event; null means unavailable. */
  loginEventId(): string | null;
  now(): Date;
  /**
   * Durable occurrences (P4.3 preparation). Default OFF: without it the
   * scheduler behaves exactly as before. With it, every due occurrence is
   * recorded with its dispatch intent in the transaction that advances
   * next_fire_at, and dispatched — and recovered — through the ledger.
   */
  occurrences?: ScheduleOccurrenceLedger;
}

/** What the scheduler needs to run on durable occurrences. */
export interface ScheduleOccurrenceLedger {
  dispatcher: ScheduleOccurrenceDispatcher;
  /**
   * The executor generation a NEW occurrence of this schedule is recorded
   * with. Recorded occurrences keep theirs. A work.v2 choice for a schedule
   * Work cannot admit (inline action, unversioned job) is recorded as legacy,
   * with the reason, rather than refused at its slot.
   */
  generation(entry: ScheduleEntry): ExecutorGeneration;
  /** At most this many due occurrences are (re)dispatched per tick. */
  drainLimit?: number;
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
  private readonly atSchedulesInFlight = new Map<string, { kind: AtScheduleKind; run: Promise<void> }>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** Runs still going, for a clean shutdown. */
  get running(): Promise<void>[] {
    return [...this.inFlight.values(), ...[...this.atSchedulesInFlight.values()].map((o) => o.run)];
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
    if (this.deps.occurrences) {
      this.drainOccurrences(now, this.deps.occurrences);
      await this.deliverNotifications();
    } else {
      await this.retryAnnouncements(states);
    }
    this.tickAtSchedules(now);
    writeHeartbeat(this.listing.schedules.length, this.listing.errors);
  }

  /** Recover what a dead runner left, then start due schedules while each budget has room. */
  private tickAtSchedules(now: Date): void {
    this.deps.recoverAtSchedules();
    for (const [kind, cap] of [["action", MAX_AT_SCHEDULES_RUNNING], ["job", MAX_JOB_RUNS_RUNNING]] as const) {
      const running = [...this.atSchedulesInFlight.values()].filter((o) => o.kind === kind).length;
      const claims = claimDue({
        now,
        kind,
        limit: cap - running,
        runnerPid: this.deps.runner.pid,
        runnerStartedAt: this.deps.runner.startedAt,
      });
      for (const claim of claims) this.startAtSchedule(kind, claim.schedule, claim.attemptId, claim.attempt);
    }
  }

  private startAtSchedule(kind: AtScheduleKind, schedule: AtSchedule, attemptId: string, attempt: number): void {
    const run = this.deps
      .runAtSchedule(schedule, attemptId, attempt)
      .catch((error: unknown): AtScheduleResult => ({
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
          scheduleId: schedule.id,
          attemptId,
          outcome: result.outcome,
          exitCode: result.exitCode,
          runId: result.runId,
          ...(result.reason ? { reason: result.reason } : {}),
          now: this.deps.now(),
        });
      })
      .finally(() => this.atSchedulesInFlight.delete(attemptId));
    this.atSchedulesInFlight.set(attemptId, { kind, run });
  }

  private consider(entry: ScheduleEntry, state: ScheduleState | null, now: Date): void {
    if (this.deps.occurrences) {
      this.considerDurable(entry, state, now, this.deps.occurrences);
      return;
    }
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

  /** The generation a new occurrence of `entry` is recorded with, and why when it differs from the choice. */
  private generationFor(entry: ScheduleEntry, ledger: ScheduleOccurrenceLedger): { generation: ExecutorGeneration; note?: string } {
    const chosen = ledger.generation(entry);
    if (chosen === "legacy") return { generation: "legacy" };
    const eligibility = workEligibility(entry);
    return eligibility.eligible ? { generation: chosen } : { generation: "legacy", note: eligibility.reason };
  }

  /**
   * consider(), on durable occurrences. The occurrence for a due slot is
   * recorded — with its nominal slot, never the dispatch time — in the same
   * transaction that advances next_fire_at, so a crash in between can no
   * longer lose it. Skips, misses and coalesced slots are recorded too.
   */
  private considerDurable(entry: ScheduleEntry, state: ScheduleState | null, now: Date, ledger: ScheduleOccurrenceLedger): void {
    const { trigger, catchUp, overlap } = entry.schedule;
    const key = triggerKey(trigger);
    if (!state || state.trigger_key !== key) {
      updateState(entry.id, { trigger_key: key, next_fire_at: firstFire(trigger, now) });
      return;
    }
    if (state.paused) return;
    const { generation, note } = this.generationFor(entry, ledger);
    const notes = note ? { generation_note: note } : {};

    if (trigger.kind === "login") {
      if (this.inFlight.has(entry.id)) return;
      const eventId = this.deps.loginEventId();
      if (!eventId) return;
      const occurrence = newScheduleOccurrence({ entry, kind: "login", discriminator: eventId, policy: { late: false, coalesced_slots: 1, login_event_id: eventId, ...notes }, generation });
      const recorded = claimLoginOccurrence(occurrence, eventId, now);
      if (recorded) this.startOccurrence(entry, recorded.occurrence.occurrenceId, ledger);
      return;
    }

    const decision = decide(state.next_fire_at, catchUp, now);
    if (decision.kind === "wait" || !state.next_fire_at) return;
    const slot = state.next_fire_at;
    const next = nextAfterFiring(trigger, now);
    const kind = trigger.kind === "at" ? "at" : "slot";
    const late = decision.kind === "miss" || decision.late;
    const policy = { late, coalesced_slots: late ? countDueSlots(trigger, slot, now, MAX_COUNTED_SLOTS) : 1, ...notes };

    if (decision.kind === "miss") {
      recordOccurrence({
        onConflict: "keep-original",
        occurrence: newScheduleOccurrence({ entry, kind, discriminator: slot, policy, generation }),
        state: "missed",
        statePatch: { next_fire_at: next },
        alsoInTransaction: () => countSkippedFire(entry.id, "missed"),
        now,
      });
      return;
    }

    if (this.inFlight.has(entry.id)) {
      // `queue` owes one re-run however many slots land meanwhile: the first
      // is recorded as the queued occurrence, later ones as coalesced into it.
      // Durable, so a restart no longer forgets the owed run.
      if (overlap === "queue") {
        const owed = owedQueuedOccurrence(entry.id);
        recordOccurrence({
          onConflict: "keep-original",
          occurrence: newScheduleOccurrence({ entry, kind: owed ? kind : "queued", discriminator: slot, policy, generation }),
          state: owed ? "coalesced" : "pending",
          statePatch: { next_fire_at: next },
          now,
        });
      } else {
        recordOccurrence({
          onConflict: "keep-original",
          occurrence: newScheduleOccurrence({ entry, kind, discriminator: slot, policy, generation }),
          state: "skipped",
          statePatch: { next_fire_at: next },
          alsoInTransaction: () => countSkippedFire(entry.id, "skipped"),
          now,
        });
      }
      return;
    }

    const recorded = recordOccurrence({
      onConflict: "keep-original",
      occurrence: newScheduleOccurrence({ entry, kind, discriminator: slot, policy, generation }),
      state: "pending",
      statePatch: { last_fired_at: now, next_fire_at: next },
      now,
    });
    this.startOccurrence(entry, recorded.occurrence.occurrenceId, ledger);
  }

  /**
   * Re-dispatch what is owed: occurrences recorded but never handed over
   * (a crash after recording), queued re-runs after a restart, and Work
   * occurrences whose admission is unconfirmed — observed by their original
   * key. A dead dispatcher's in-flight rows are settled first.
   */
  private drainOccurrences(now: Date, ledger: ScheduleOccurrenceLedger): void {
    ledger.dispatcher.recoverAbandoned();
    for (const occurrence of dueOccurrences(now, ledger.drainLimit ?? 32)) {
      const scheduleId = occurrence.scheduleId;
      if (!scheduleId || this.inFlight.has(scheduleId)) continue;
      const entry = this.listing.schedules.find((e) => e.id === scheduleId) ?? null;
      // A legacy runner needs the loaded schedule; without it the occurrence waits, visible.
      if (!entry && occurrence.executorGeneration === "legacy") continue;
      this.startOccurrence(entry, occurrence.occurrenceId, ledger);
    }
    for (const owed of ledger.dispatcher.acceptedWithoutOutcome()) {
      const recorded = getOccurrence(owed.occurrenceId);
      const scheduleId = recorded?.occurrence.scheduleId;
      if (!scheduleId || this.inFlight.has(scheduleId)) continue;
      const entry = this.listing.schedules.find((e) => e.id === scheduleId);
      if (entry) this.observeAccepted(entry, owed.occurrenceId, owed.oneOffId, ledger);
    }
  }

  private startOccurrence(entry: ScheduleEntry | null, occurrenceId: string, ledger: ScheduleOccurrenceLedger): void {
    const scheduleId = entry?.id ?? getOccurrence(occurrenceId)?.occurrence.scheduleId;
    if (!scheduleId) return;
    const run = ledger.dispatcher.dispatch(occurrenceId, entry)
      .then((result) => (entry ? this.recordDispatch(entry, occurrenceId, result) : undefined))
      .catch((error: unknown) => {
        diagnostics.error("schedules.occurrence_failed", { detail: `schedules: occurrence ${occurrenceId} crashed: ${error instanceof Error ? error.stack : String(error)}` });
      })
      .finally(() => {
        this.inFlight.delete(scheduleId);
        const owed = entry ? owedQueuedOccurrence(scheduleId) : null;
        if (entry && owed) {
          updateState(scheduleId, { last_fired_at: this.deps.now() });
          this.startOccurrence(entry, owed.occurrenceId, ledger);
        }
      });
    this.inFlight.set(scheduleId, run);
  }

  /** Wait on a legacy job one-off a dead dispatcher had already accepted. Observation only. */
  private observeAccepted(entry: ScheduleEntry, occurrenceId: string, oneOffId: string, ledger: ScheduleOccurrenceLedger): void {
    const run = ledger.dispatcher.observeAccepted(occurrenceId, oneOffId)
      .then((outcome) => this.recordDurable(entry, occurrenceId, outcome))
      .catch((error: unknown) => {
        diagnostics.error("schedules.occurrence_observe_failed", { detail: `schedules: observing ${occurrenceId} failed: ${error instanceof Error ? error.message : String(error)}` });
      })
      .finally(() => this.inFlight.delete(entry.id));
    this.inFlight.set(entry.id, run);
  }

  private async recordDispatch(entry: ScheduleEntry, occurrenceId: string, result: DispatchResult): Promise<void> {
    switch (result.kind) {
      case "ran":
        await this.recordDurable(entry, occurrenceId, result.outcome);
        return;
      case "accepted":
        // The owner owns it now, including its outcome and any retry.
        updateState(entry.id, { last_run_id: result.workId, last_status: "accepted", last_summary: `accepted by the Work owner as ${result.workId}${result.recovered ? " (recovered by key)" : ""}` });
        return;
      case "unknown":
        updateState(entry.id, { last_status: "unknown", last_summary: `admission not confirmed (${result.code}); the original key will be observed, nothing is started again` });
        return;
      case "refused":
        await this.recordDurable(entry, occurrenceId, { status: "failed", runId: null, summary: `refused (${result.code}): ${result.message}` });
        return;
      case "skipped":
        return;
    }
  }

  /**
   * record(), on durable occurrences: the schedule state as before, and the
   * failure/recovery notice committed as a ledger intent — grouped per
   * failure streak — delivered separately, so a notice that cannot be sent is
   * retried as a notice and never reruns the work.
   */
  private async recordDurable(entry: ScheduleEntry, occurrenceId: string, outcome: FireOutcome): Promise<void> {
    const before = listStates().get(entry.id);
    const failing = outcome.status === "failed";
    updateState(entry.id, {
      last_run_id: outcome.runId,
      last_status: outcome.status,
      last_summary: outcome.summary.slice(0, 2000),
      consecutive_failures: failing ? (before?.consecutive_failures ?? 0) + 1 : 0,
      ...(failing ? {} : { failure_announced: false }),
    });
    recordNotificationIntent({ scheduleId: entry.id, occurrenceId, outcome: outcome.status, summary: outcome.summary, now: this.deps.now() });
    await this.deliverNotifications();
  }

  /** Send owed notices; each is delivered at most once and retried until it is. */
  private async deliverNotifications(): Promise<void> {
    for (const notice of pendingNotifications()) {
      const entry = this.listing.schedules.find((e) => e.id === notice.scheduleId);
      if (!entry) continue;
      const delivered = await this.deps.announce(entry, notice.transition, {
        status: notice.transition === "failure" ? "failed" : "complete",
        runId: null,
        summary: notice.transition === "failure" && notice.failures > 1 ? `failing (${notice.failures} in a row): ${notice.lastSummary ?? ""}` : (notice.lastSummary ?? ""),
      });
      settleNotification(notice.notificationKey, delivered, this.deps.now());
      if (delivered && notice.transition === "failure") updateState(entry.id, { failure_announced: true });
    }
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
