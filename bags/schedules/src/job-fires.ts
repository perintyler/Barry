/**
 * A schedule whose payload is a `job:` fires as a job run: a one-off keyed by
 * the schedule and the fire time, so the job gets its contract, its bounds,
 * its own concurrency budget and at-least-once recovery — the same run the
 * SDK's `jobs.run` makes — and the schedule records how it went.
 */

import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { findJob, parseJobRef } from "@barry-rocks/sdk/internal/jobs";
import { createOneOff, getOneOff, type OneOff } from "./one-offs.js";
import type { ScheduleEntry } from "./catalog.js";
import type { FireOutcome } from "./scheduler.js";

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
export async function scheduleJobRun(entry: ScheduleEntry, at: Date, key = `${entry.id}@${at.toISOString()}`): Promise<OneOff> {
  const ref = scheduleJobRef(entry);
  const { bags } = await loadBagRegistrySnapshot();
  const job = findJob(bags, ref);
  if (!job) throw new Error(`schedule ${entry.id} runs job "${ref}", which does not exist`);
  return createOneOff({
    bag: job.bag,
    action: null,
    job: ref,
    inputs: entry.schedule.inputs ?? {},
    permissions: { identity: entry.schedule.identity, traits: entry.schedule.traits, bounds: entry.schedule.bounds },
    dueAt: at,
    idempotencyKey: key,
    ...(job.timeout !== undefined ? { timeoutS: job.timeout } : {}),
    createdBy: "schedule",
  }, at).oneOff;
}

/** Wait for a one-off to end. Polled: the scheduler that runs it may be this process or another. */
export async function awaitOneOff(id: string, pollMs = 1_000): Promise<OneOff> {
  for (;;) {
    const oneOff = getOneOff(id);
    if (!oneOff) throw new Error(`one-off ${id} is gone`);
    if (TERMINAL.has(oneOff.status)) return oneOff;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** What a finished job run means for the schedule that fired it. */
export function jobFireOutcome(oneOff: OneOff): FireOutcome {
  const runId = oneOff.attempts?.at(-1)?.runId ?? null;
  return {
    status: oneOff.status === "succeeded" ? "complete" : "failed",
    runId,
    summary: oneOff.reason ?? (oneOff.status === "succeeded" ? "" : oneOff.status),
  };
}

/** Fire a job schedule once and wait for its run. */
export async function runScheduledJob(entry: ScheduleEntry, at = new Date(), key?: string): Promise<FireOutcome> {
  const oneOff = await scheduleJobRun(entry, at, key);
  return jobFireOutcome(await awaitOneOff(oneOff.id));
}
