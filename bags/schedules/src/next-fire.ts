/**
 * When a schedule is due, and what to do about a fire that was missed.
 *
 * Pure functions of (trigger, state, now) so every rule here is testable
 * without a clock, a process or a database.
 */

import { Cron } from "croner";
import type { ScheduleTrigger } from "@barry-rocks/sdk/internal/schedules";

/**
 * How late a fire may start and still count as on time. A fire later than
 * this was MISSED (the machine slept, the scheduler was down), and the
 * schedule's `catch_up` decides whether it runs.
 *
 * Generous on purpose: the tick is seconds, but a loaded machine can stall a
 * timer for a while, and a stall must not read as a missed fire.
 */
export const ON_TIME_GRACE_MS = 120_000;

/**
 * The next time `trigger` is due strictly after `after`, or null if never
 * again (a one-off `at` that has passed).
 */
export function nextFireAfter(trigger: ScheduleTrigger, after: Date): Date | null {
  switch (trigger.kind) {
    case "cron": {
      const cron = new Cron(trigger.expression, { paused: true, timezone: trigger.timezone ?? "UTC" });
      let next = cron.nextRun(after);
      // Croner shifts nonexistent DST slots forward; the contract skips them.
      while (next && !cron.match(next)) next = cron.nextRun(next);
      return next;
    }
    case "at": {
      const at = new Date(trigger.time);
      return at.getTime() > after.getTime() ? at : null;
    }
    // Not a time: the scheduler claims a verified OS login event.
    case "login":
      return null;
  }
}

/**
 * The first due time for a schedule the scheduler has never seen.
 *
 * A recurring schedule starts at its next calendar slot, so installing a bag
 * does not immediately fire its recurring work. A one-off `at` keeps its time even if that is already past, so a
 * reminder created a moment too late still fires (subject to catch-up).
 */
export function firstFire(trigger: ScheduleTrigger, now: Date): Date | null {
  if (trigger.kind === "at") return new Date(trigger.time);
  if (trigger.kind === "login") return null;
  return nextFireAfter(trigger, now);
}

export type FireDecision =
  /** Not due yet. */
  | { kind: "wait" }
  /** Due: run now. `late` is true when this is a catch-up of a missed fire. */
  | { kind: "fire"; late: boolean }
  /** A missed fire the schedule does not catch up: record it and move on. */
  | { kind: "miss" };

/** Decide what to do about a schedule due at `nextFireAt`. */
export function decide(nextFireAt: Date | null, catchUp: "none" | "once", now: Date): FireDecision {
  if (!nextFireAt || nextFireAt.getTime() > now.getTime()) return { kind: "wait" };
  const late = now.getTime() - nextFireAt.getTime() > ON_TIME_GRACE_MS;
  if (late && catchUp === "none") return { kind: "miss" };
  return { kind: "fire", late };
}

/**
 * The next due time after a fire (or a miss) at `now`.
 *
 * Computed from `now`, not from the missed due time: after a week asleep a
 * minutely schedule owes one catch-up run, not ten thousand. That is what
 * `catch_up: once` means.
 */
export function nextAfterFiring(trigger: ScheduleTrigger, now: Date): Date | null {
  return nextFireAfter(trigger, now);
}
