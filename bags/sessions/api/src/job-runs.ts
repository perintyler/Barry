/**
 * Accept a job run and read it back — the one implementation behind the jobs
 * route and the detached executor's `job:` actions, so a job asked for over
 * HTTP, by run_action, or through an action's `job:` is checked, stored and
 * reported the same way.
 *
 * A run is a one-off in the scheduler (bags/schedules/scheduler/src/job-runner.ts runs
 * a code job; an action job's one-off comes back to the API to run its
 * action). Accepted means durable: the row exists before the caller is
 * answered.
 */

import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { findAction, validateActionInputs } from "@barry-rocks/sdk/internal/actions";
import { findJob, jobActionRef, parseJobRef, type JobMeta } from "@barry-rocks/sdk/internal/jobs";
import { ActionRuns } from "@barry-rocks/actions-bag";

import {
  DEFAULT_TIMEOUT_S,
  IdempotencyConflictError,
  InputTooLargeError,
  createAtSchedule,
  getAtSchedule,
  type AtSchedule,
} from "@barry-rocks/schedules-bag";
import { callerScriptBound, permitsRawProcess, resolveCallerBounds } from "./routes/caller-bounds.js";

export interface JobRunInput {
  /** `bag:name[@version]`. */
  ref: string;
  inputs?: Record<string, unknown>;
  key?: string;
  timeoutS?: number;
  callerSessionId?: string;
}

/** Why a run was refused: an RFC 9457 title and detail, or a body to send as is. */
export type JobRunRefusal = { status: number; title: string; detail: string } | { status: number; body: Record<string, unknown> };

export const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

/** Refuse a session that may not start this job, or null when it may. */
async function refuseCaller(job: JobMeta, callerSessionId: string): Promise<JobRunRefusal | null> {
  const grant = await resolveCallerBounds(callerSessionId, {});
  if ("status" in grant) return grant;
  // An action job's agent runs with the caller's access, as a subagent does.
  if (job.runs.using === "action") return null;
  if (job.runs.secrets?.length) {
    return { status: 409, title: "Secrets need bag authority", detail: `${job.qualifiedName} declares secrets (${job.runs.secrets.join(", ")}); a session cannot start it. Run it from a schedule, the CLI, or with the installation credential.` };
  }
  let allowed = false;
  try {
    allowed = permitsRawProcess(await callerScriptBound(grant));
  } catch {
    allowed = false;
  }
  return allowed ? null : { status: 409, title: "Unenforceable grant", detail: `The calling session cannot run a raw process (it needs Bash and no bound), so it cannot start ${job.qualifiedName}.` };
}

/** Check a request and store its run, or say why not. Throws only on store trouble. */
export async function acceptJobRun(input: JobRunInput): Promise<{ schedule: AtSchedule; oneOff: AtSchedule; created: boolean } | { refused: JobRunRefusal }> {
  if (!parseJobRef(input.ref).bag) return { refused: { status: 400, title: "Qualified job required", detail: `name the job as bag:name, not "${input.ref}"` } };
  const { bags } = await loadBagRegistrySnapshot();
  const job = findJob(bags, input.ref);
  if (!job) return { refused: { status: 404, title: "Unknown job", detail: `no job "${input.ref}"` } };

  // Checked now so a typo fails the caller rather than surfacing later as an
  // `unavailable` run, and again when the attempt starts.
  let contract: Pick<JobMeta, "inputSchema"> = job;
  if (job.runs.using === "action") {
    const action = await findAction(bags, jobActionRef(job, job.runs.action));
    if (!action || action.run !== undefined || action.job !== undefined || action.context !== "none") {
      return { refused: { status: 422, title: "Job cannot run", detail: `${job.qualifiedName} runs action "${job.runs.action}", which is not a detached prompt action` } };
    }
    contract = action;
  }
  const inputErrors = validateActionInputs({ name: job.qualifiedName, ...(contract.inputSchema ? { inputSchema: contract.inputSchema } : {}) }, input.inputs);
  if (inputErrors.length) return { refused: { status: 422, title: "Invalid inputs", detail: inputErrors.join(" ") } };
  if (input.callerSessionId) {
    const refused = await refuseCaller(job, input.callerSessionId);
    if (refused) return { refused };
  }

  try {
    return createAtSchedule({
      bag: job.bag,
      action: null,
      job: input.ref,
      inputs: input.inputs ?? {},
      dueAt: new Date(),
      ...(input.key ? { idempotencyKey: input.key } : {}),
      timeoutS: input.timeoutS ?? job.timeout ?? DEFAULT_TIMEOUT_S,
      callerSessionId: input.callerSessionId ?? null,
      createdBy: input.callerSessionId ?? "api",
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return { refused: { status: 409, title: "Idempotency key conflict", detail: error.message } };
    if (error instanceof InputTooLargeError) return { refused: { status: 413, title: "Payload too large", detail: error.message } };
    throw error;
  }
}

/** Poll a run until it ends or `waitS` passes. */
export async function awaitJobRun(id: string, waitS: number | undefined): Promise<AtSchedule | null> {
  let schedule = getAtSchedule(id);
  if (!waitS || !schedule) return schedule;
  const deadline = Date.now() + waitS * 1000;
  while (schedule && !TERMINAL_JOB_STATUSES.has(schedule.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(50, deadline - Date.now()))));
    schedule = getAtSchedule(id);
  }
  return schedule;
}

/** A run as the contract serves it, with the latest attempt's output. */
export async function serializeJobRun(schedule: AtSchedule) {
  const latest = schedule.attempts?.at(-1);
  const run = latest?.runId ? await ActionRuns.get(latest.runId) : null;
  return {
    id: schedule.id,
    job: schedule.job ?? "",
    status: schedule.status,
    reason: schedule.reason,
    key: schedule.idempotencyKey,
    callerSessionId: schedule.callerSessionId,
    attempts: schedule.attempts?.length ?? 0,
    runId: latest?.runId ?? null,
    output: run?.output ?? null,
    outputType: run?.output_type ?? null,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}
