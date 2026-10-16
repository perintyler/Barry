/**
 * A schedule whose payload is a `job:` fires as a job run: a one-off keyed by
 * the schedule and the fire time, so the job gets its contract, its bounds,
 * its own concurrency budget and at-least-once recovery — the same run the
 * SDK's `jobs.run` makes — and the schedule records how it went.
 */

import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { findJob, parseJobRef } from "@barry-rocks/sdk/internal/jobs";
import { createAtSchedule, getAtSchedule, type AtSchedule } from "./at-schedules.js";
import type { ScheduleEntry } from "./registry.js";
import type { FireOutcome } from "./scheduler.js";
import type { ProducerOccurrence } from "./work-producer-occurrences.js";
import { getDb } from "./db.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

/** The job a schedule runs, qualified: a bare name is the schedule's own bag's. */
export function scheduleJobRef(entry: ScheduleEntry): string {
  const payload = entry.schedule.payload;
  if (payload.kind !== "job") throw new Error(`schedule ${entry.id} does not run a job`);
  return parseJobRef(payload.ref).bag ? payload.ref : `${entry.bag}:${payload.ref}`;
}

/**
 * Accept one fire of a job schedule. `key` defaults to the schedule and fire
 * time, so a fire repeated after a crash is the same run, not a second one.
 */
export async function scheduleJobRun(entry: ScheduleEntry, at: Date, key = `${entry.id}@${at.toISOString()}`): Promise<AtSchedule> {
  const ref = scheduleJobRef(entry);
  const { bags } = await loadBagRegistrySnapshot();
  const job = findJob(bags, ref);
  if (!job) throw new Error(`schedule ${entry.id} runs job "${ref}", which does not exist`);
  const selectedBags = entry.schedule.bags;
  return createAtSchedule({
    bag: job.bag,
    action: null,
    job: ref,
    inputs: entry.schedule.inputs ?? {},
    permissions: {
      ...(entry.schedule.identity ? { identity: entry.schedule.identity } : {}),
      ...(selectedBags ? { bags: selectedBags } : {}),
      ...(entry.schedule.bounds ? { bounds: entry.schedule.bounds } : {}),
    },
    dueAt: at,
    idempotencyKey: key,
    ...(job.timeout !== undefined ? { timeoutS: job.timeout } : {}),
    createdBy: "schedule",
  }, at).schedule;
}

/** Wait for an at-schedule to end. Polled: the scheduler that runs it may be this process or another. */
export async function awaitAtSchedule(id: string, pollMs = 1_000): Promise<AtSchedule> {
  for (;;) {
    const schedule = getAtSchedule(id);
    if (!schedule) throw new Error(`one-off ${id} is gone`);
    if (TERMINAL.has(schedule.status)) return schedule;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** What a finished job run means for the schedule that fired it. */
export function jobFireOutcome(schedule: AtSchedule): FireOutcome {
  const runId = schedule.attempts?.at(-1)?.runId ?? null;
  return {
    status: schedule.status === "succeeded" ? "complete" : "failed",
    runId,
    summary: schedule.reason ?? (schedule.status === "succeeded" ? "" : schedule.status),
  };
}

/** Fire a job schedule once and wait for its run. */
export async function runScheduledJob(entry: ScheduleEntry, at = new Date(), key?: string): Promise<FireOutcome> {
  const schedule = await scheduleJobRun(entry, at, key);
  return jobFireOutcome(await awaitAtSchedule(schedule.id));
}

/**
 * Accept a recorded occurrence of a job schedule as its one-off, keyed by the
 * occurrence's admission key — the slot, not the dispatch time — so a
 * dispatch repeated after a crash replays the same one-off.
 */
export function acceptJobOccurrence(entry: ScheduleEntry, occurrence: Pick<ProducerOccurrence, "slotAt" | "createdAt" | "idempotencyKey">): Promise<AtSchedule> {
  return scheduleJobRun(entry, occurrence.slotAt ?? occurrence.createdAt, occurrence.idempotencyKey);
}

/** The at-schedule an occurrence's key already created, if any: how recovery finds accepted work. */
export function findJobOccurrenceAtSchedule(occurrence: Pick<ProducerOccurrence, "idempotencyKey" | "definition">): AtSchedule | null {
  if (occurrence.definition.kind !== "job") return null;
  const row = getDb().prepare("SELECT id FROM one_off WHERE idempotency_key = ? AND job = ?")
    .get(occurrence.idempotencyKey, occurrence.definition.reference) as { id: string } | undefined;
  return row ? getAtSchedule(row.id) : null;
}
