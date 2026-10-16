/**
 * Run one attempt of a job one-off: a `node` or `process` job, here in the
 * scheduler, as a child process.
 *
 * Built on the same `runScriptAction` a `run:` action uses, so a job run is an
 * action run row like any other (trigger `job`) — the same log, the same
 * output checks against `output_schema`, the same `validate:` — and a reader
 * of `barry action runs` sees it without learning a second record.
 *
 * What a job adds over a script action:
 *
 * - **No agent to decide.** An action's preflight is advice for the agent; a
 *   job's preflight that does not pass (including one that cannot tell) means
 *   the job does not start, recorded `unavailable`.
 * - **Caller authority.** A job a SESSION started gets no declared secrets —
 *   the session asked, the bag's credentials are not the session's to spend.
 *   Without a calling session the job runs with its bag's authority: the
 *   installation's credentials, or the schedule identity's.
 * - **Step keys.** BARRY_JOB_KEY is the caller's idempotency key (the one-off
 *   id without one), stable across retries, and BARRY_JOB_ATTEMPT counts
 *   from 1. A job is run at least once, so a side effect dedupes on the key.
 * - **Contract failures are final.** Output that does not match
 *   `output_schema`, or a `validate:` check that fails, is
 *   `validation_failed`: never retried, since the same code will produce the
 *   same answer.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assertToolAllowed, boundHasContent, boundHasProcessRestrictions, mergeBounds, type Bound } from "@barry-rocks/sdk/bounds";
import { boundToNodeFlags } from "@barry-rocks/sdk/internal/workflows";
import { stableNodePath } from "@barry-rocks/sdk/internal/services";
import { bounds } from "@barry-rocks/identities-bag";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { runActionPreflight, validateActionInputs, type ScriptAction } from "@barry-rocks/sdk/internal/actions";
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { findJob, type JobMeta } from "@barry-rocks/sdk/internal/jobs";
import type { ActionRunSpec } from "@barry-rocks/sdk/internal/actions";
import { runScriptAction, type RunScriptOptions } from "@barry-rocks/actions-bag";

import type { AtSchedule, AtScheduleResult, ScheduleAccess } from "@barry-rocks/schedules-bag";
import { resolveAtScheduleAccess, recordAttempt } from "@barry-rocks/schedules-bag";

export type CodeJob = JobMeta & { runs: Exclude<JobMeta["runs"], { using: "action" }> };

/** The job an at-schedule names, or why it cannot run. Resolved at attempt start, so an upgraded bag runs its upgraded job. */
export async function resolveAtScheduleJob(schedule: AtSchedule): Promise<{ job: JobMeta } | { unavailable: string }> {
  if (!schedule.job) return { unavailable: "names no job" };
  const { bags } = await loadBagRegistrySnapshot();
  const job = findJob(bags, schedule.job, { fromBag: schedule.bag });
  return job ? { job } : { unavailable: `job "${schedule.job}" does not exist` };
}

/** A `run:` spec for the job's process. `node` goes through `entry`, so it runs with Barry's pinned Node, never PATH's. */
export function jobRunSpec(job: CodeJob): ActionRunSpec {
  const workingDirectory = job.runs.workingDirectory ? { workingDirectory: job.runs.workingDirectory } : {};
  if (job.runs.using === "node") return { entry: job.runs.main, command: "node", args: [], ...workingDirectory };
  const [command, ...args] = job.runs.command;
  return { command: command, args, ...workingDirectory };
}

/**
 * The job as a script action, so runScriptAction can run and record it. Named
 * `<bag>:job/<name>` — what its runs record — so it cannot collide with an
 * action of the same name, the way a schedule's inline action is
 * `<bag>:schedule/<name>`.
 */
export function jobScriptAction(job: CodeJob, run: ActionRunSpec, timeoutS: number): ScriptAction {
  return {
    source: "bag",
    name: `job/${job.name}`,
    bag: job.bag,
    qualifiedName: `${job.bag}:job/${job.name}`,
    dir: job.dir,
    description: job.description ?? `Job ${job.qualifiedName}`,
    requires: job.requires,
    instructions: [],
    steps: [],
    scripts: [],
    slashCommand: false,
    context: "none",
    legacySkill: false,
    bagAccess: "enabled",
    shadowed: false,
    run,
    ...(job.runs.secrets ? { secrets: job.runs.secrets } : {}),
    ...(job.runs.env ? { env: job.runs.env } : {}),
    timeout: timeoutS,
    ...(job.inputSchema ? { inputSchema: job.inputSchema } : {}),
    ...(job.outputSchema ? { outputSchema: job.outputSchema } : {}),
    ...(job.validate ? { validate: job.validate } : {}),
  };
}

/** A job's own bounds, merged; null when it names none. Throws naming an unknown bound. */
export async function jobBound(job: Pick<JobMeta, "bounds">): Promise<Bound | null> {
  let merged: Bound | null = null;
  for (const name of job.bounds ?? []) {
    const record = await bounds.get(name);
    if (!record) throw new Error(`unknown bound ${name}`);
    merged = mergeBounds(merged, record);
  }
  return merged;
}

/**
 * How a code job launches, per kind, under its own bounds:
 *
 * - unbounded: `node` runs with Barry's pinned Node (TypeScript through tsx),
 *   `process` runs its argv — an ordinary process, as a script action is;
 * - a bounded `process` job does not start: Barry cannot confine an
 *   arbitrary program;
 * - a bounded `node` job runs under Node's permission model with the flags
 *   its bound translates to (job-launcher.ts), or does not start when the
 *   bound says something Node cannot enforce.
 */
export async function boundedLaunch(job: CodeJob): Promise<{ run: ActionRunSpec } | { unavailable: string }> {
  let bound: Bound | null;
  try {
    bound = await jobBound(job);
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
  if (!boundHasContent(bound ?? undefined)) return { run: jobRunSpec(job) };
  if (job.runs.using === "process") return { unavailable: `${job.qualifiedName} is a bounded process job; Barry cannot confine an arbitrary program` };
  if (!/\.m?js$/.test(job.runs.main)) return { unavailable: `${job.qualifiedName} is bounded, so its main must be one self-contained .mjs or .js file` };
  const translated = boundToNodeFlags(bound);
  if ("refused" in translated) return { unavailable: `${job.qualifiedName}: ${translated.refused}` };
  return {
    run: {
      command: stableNodePath(),
      // The real path: under the permission model Node may read its entry
      // file, but not the symlinks on the way to it.
      args: [...translated.flags, realpathSync(resolve(job.dir, job.runs.main))],
      ...(job.runs.workingDirectory ? { workingDirectory: job.runs.workingDirectory } : {}),
    },
  };
}

export interface JobRunnerOptions {
  /** What the process starts with before its declared env. */
  baseEnv: NodeJS.ProcessEnv;
}

export async function runJobAtSchedule(schedule: AtSchedule, attemptId: string, attempt: number, options: JobRunnerOptions): Promise<AtScheduleResult> {
  const unavailable = (why: string): AtScheduleResult => ({ outcome: "unavailable", exitCode: null, runId: null, reason: `unavailable: ${why}` });
  const resolved = await resolveAtScheduleJob(schedule);
  if ("unavailable" in resolved) return unavailable(resolved.unavailable);
  const found = resolved.job;
  if (found.runs.using === "action") return unavailable(`${found.qualifiedName} runs an action, which the API runs`);
  const job: CodeJob = { ...found, runs: found.runs };

  const inputErrors = validateActionInputs({ name: job.qualifiedName, ...(job.inputSchema ? { inputSchema: job.inputSchema } : {}) }, schedule.inputs);
  if (inputErrors.length) return unavailable(inputErrors.join(" "));

  if (schedule.callerSessionId && job.runs.secrets?.length) {
    return unavailable(`${job.qualifiedName} declares secrets (${job.runs.secrets.join(", ")}), which a job a session started cannot have; start it from a schedule, the CLI, or with the installation credential`);
  }


  if (job.preflight) {
    const preflight = await runActionPreflight(job.preflight, job.dir);
    if (!preflight.passed) return unavailable(`preflight did not pass: ${preflight.warning}`);
  }

  // A schedule's run carries the schedule's identity and bags; a job
  // asked for directly carries none and runs with its bag's authority.
  let access: ScheduleAccess | undefined;
  if (schedule.permissions.identity || schedule.permissions.bags?.length || schedule.permissions.traits?.length) {
    access = await resolveAtScheduleAccess(schedule);
    assertToolAllowed(access, { namespace: "bash", toolName: "Bash" }, installationRegistry().id);
    if (boundHasProcessRestrictions(access.bound ?? undefined)) return unavailable("raw scheduled processes cannot enforce selected bounds");
  }

  const secretScope: RunScriptOptions["secretScope"] = schedule.callerSessionId
    ? { kind: "none" }
    : access?.identity ? { kind: "identity", uuid: access.identity } : { kind: "installation" };
  const launch = await boundedLaunch(job);
  if ("unavailable" in launch) return unavailable(launch.unavailable);
  const action = jobScriptAction(job, launch.run, schedule.timeoutS);
  const metadataContext = access
    ? {
        identity: access.identity,
        bags: access.bags,
        traits: access.bags,
        bound: access.bound,
        allowedToolIds: access.allowedToolIds,
      }
    : undefined;
  const runOptions: RunScriptOptions = {
    inputs: schedule.inputs,
    trigger: "job",
    scheduleId: schedule.id,
    sessionId: schedule.callerSessionId,
    secretScope,
    baseEnv: options.baseEnv,
    metadata: {
      runner_pid: process.pid,
      one_off_attempt: attemptId,
      job: job.qualifiedName,
      ...(schedule.callerSessionId ? { caller_session_id: schedule.callerSessionId } : {}),
      ...(metadataContext ? { execution_context: metadataContext, schedule_access: metadataContext } : {}),
    },
    extraEnv: {
      BARRY_JOB_KEY: schedule.idempotencyKey ?? schedule.id,
      BARRY_JOB_ATTEMPT: String(attempt),
      BARRY_SCHEDULE_ID: schedule.id,
      BARRY_ATTEMPT_ID: attemptId,
    },
    onStart: ({ runId, processGroup }) => recordAttempt(attemptId, { runId, processGroup }),
  };
  const { run, timedOut } = access
    ? await withStoreContext({ identity: access.identity, execution: access }, () => runScriptAction(action, runOptions))
    : await runScriptAction(action, runOptions);

  const exitCode = run.process?.exit_code ?? null;
  const reason = run.summary ? { reason: run.summary } : {};
  if (run.status === "complete") {
    const outcome = run.validation_failures?.length ? "validation_failed" : "succeeded";
    return { outcome, exitCode, runId: run.id, ...reason };
  }
  // Exited 0 and still failed: its output broke the contract.
  return { outcome: timedOut ? "timed_out" : exitCode === 0 ? "validation_failed" : "failed", exitCode, runId: run.id, ...reason };
}
