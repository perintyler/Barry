import { resolveScheduleAccess, resolveAtScheduleAccess } from "@barry-rocks/schedules-bag";
import { runMcpAction } from "@barry-rocks/schedules-bag";
import { assertToolAllowed, boundHasProcessRestrictions } from "@barry-rocks/sdk/bounds";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { hostEnvironment, installationRoot, getServiceUrl } from "@barry-rocks/sdk/services";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
/**
 * What the scheduler service plugs into the Scheduler: the real runners,
 * alerts, schedule recovery and housekeeping. Split from service.ts so a test
 * can drive the real runners without starting the service loop.
 *
 * Script actions run here, as children of the scheduler, so maintenance keeps
 * running with the API down. Agent actions go to the API, which owns sessions
 * and agent spawns.
 */

import { ActionRuns } from "@barry-rocks/actions-bag";
import { runScriptAction } from "@barry-rocks/actions-bag";
import { isScriptAction, validateActionInputs, type ScriptAction } from "@barry-rocks/sdk/internal/actions";

import { isActionJob, resolveAtScheduleAction, type ScheduleEntry } from "@barry-rocks/schedules-bag";
import type { FireOutcome, AtScheduleResult, Transition } from "@barry-rocks/schedules-bag";
import { pruneAtSchedules, recordAttempt, recoverOrphans, type AtSchedule } from "@barry-rocks/schedules-bag";
import { killGroup, probeProcess } from "@barry-rocks/schedules-bag";
import { runJobAtSchedule } from "./job-runner.js";
import { acceptJobOccurrence, awaitAtSchedule, findJobOccurrenceAtSchedule, jobFireOutcome, resolveScheduleAction, type LegacyOccurrenceRunners } from "@barry-rocks/schedules-bag";
import { getDb } from "@barry-rocks/schedules-bag";

/** Scheduled runs kept this long; failures longer, since they are what gets read. */
const KEEP_RUNS_DAYS = 30;
const KEEP_FAILED_RUNS_DAYS = 90;

export function apiBase(): string {
  return `${getServiceUrl("api")}/api/v1`;
}

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) headers.Authorization = `Bearer ${process.env.BARRY_SECRET}`;
  return headers;
}

/**
 * What a scheduled script starts with before its declared env: enough to find
 * binaries and Barry, and nothing else. This is the contract launchd gave
 * jobs — a job got the variables it listed — kept so a scheduled script does
 * not silently depend on whatever the scheduler happened to hold.
 */
export function baseEnv(): NodeJS.ProcessEnv {
  return { ...hostEnvironment(), BARRY_DIR: installationRoot() };
}

export async function runScript(action: ScriptAction, entry: ScheduleEntry): Promise<FireOutcome> {
  const access = await resolveScheduleAccess(entry);
  const metadataContext = {
    identity: access.identity,
    bags: access.bags,
    traits: access.bags,
    bound: access.bound,
    allowedToolIds: access.allowedToolIds,
  };
  if (action.run.command === "barry-mcp") {
    const reference = action.run.args[0]; if (!reference) throw new Error("MCP action requires a tool reference");
    return withStoreContext({ identity: access.identity, execution: access }, async () => {
      const run = await ActionRuns.create({ action: action.qualifiedName, bag: entry.bag, trigger: "schedule", schedule_id: entry.id, metadata: { execution_context: metadataContext, schedule_access: metadataContext } });
      try { const output = await runMcpAction(reference, entry.schedule.inputs ?? {}, access); await ActionRuns.complete(run.id, "MCP action completed", null, { type: "json", value: JSON.stringify(output) }); return { status: "complete", runId: run.id, summary: "MCP action completed" }; }
      catch (error) { await ActionRuns.fail(run.id, String(error)); throw error; }
    });
  }
  assertToolAllowed(access, { namespace: "bash", toolName: "Bash" }, installationRegistry().id);
  if (boundHasProcessRestrictions(access.bound ?? undefined)) throw new Error("raw scheduled processes cannot enforce selected bounds; use a barry-mcp action");

  const { run } = await withStoreContext({ identity: access.identity, execution: access }, () => runScriptAction(action, {
    ...(entry.schedule.inputs ? { inputs: entry.schedule.inputs } : {}),
    trigger: "schedule",
    scheduleId: entry.id,
    secretScope: access.identity ? { kind: "identity", uuid: access.identity } : { kind: "installation" },
    baseEnv: baseEnv(),
    metadata: { runner_pid: process.pid, execution_context: metadataContext, schedule_access: metadataContext },
  }));
  return { status: run.status === "complete" ? "complete" : "failed", runId: run.id, summary: run.summary ?? "" };
}

export async function runAgent(entry: ScheduleEntry): Promise<FireOutcome> {
  const response = await fetch(`${apiBase()}/schedules/${encodeURIComponent(entry.bag)}/${encodeURIComponent(entry.name)}/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ trigger: "schedule" }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`API refused the run (${response.status}): ${String(body.message ?? body.error ?? "no detail")}`);
  }
  return {
    status: body.status === "complete" ? "complete" : "failed",
    runId: typeof body.run_id === "string" ? body.run_id : null,
    summary: typeof body.summary === "string" ? body.summary : "",
  };
}

/**
 * One attempt of an at-schedule. A script runs here, recording its run and process
 * group on the attempt so a restarted scheduler can find it; an agent action
 * goes to the API. Everything that means "this cannot run" — the action is
 * gone, the inputs are refused — is `unavailable`, which is never retried.
 */
export async function runAtSchedule(schedule: AtSchedule, attemptId: string, attempt = 1): Promise<AtScheduleResult> {
  const unavailable = (why: string): AtScheduleResult => ({ outcome: "unavailable", exitCode: null, runId: null, reason: `unavailable: ${why}` });
  // A code job runs here; an action job resolves to its action below and,
  // like any agent action, runs in the API.
  if (schedule.job && !(await isActionJob(schedule))) return runJobAtSchedule(schedule, attemptId, attempt, { baseEnv: baseEnv() });
  const resolved = await resolveAtScheduleAction(schedule);
  if ("unavailable" in resolved) return unavailable(resolved.unavailable);
  // The schedule's own bound, not the action's: the caller asked for it.
  const action = { ...resolved.action, timeout: schedule.timeoutS };
  const inputErrors = validateActionInputs(action, schedule.inputs);
  if (inputErrors.length) return unavailable(inputErrors.join(" "));

  if (isScriptAction(action)) {
    const access = await resolveAtScheduleAccess(schedule);
    const metadataContext = {
      identity: access.identity,
      bags: access.bags,
      traits: access.bags,
      bound: access.bound,
      allowedToolIds: access.allowedToolIds,
    };
    if (action.run.command === "barry-mcp") {
      const reference = action.run.args[0];
      if (!reference) return unavailable("MCP action requires a tool reference");
      return withStoreContext({ identity: access.identity, execution: access }, async () => {
        const run = await ActionRuns.create({ action: action.qualifiedName, bag: schedule.bag, trigger: "schedule", schedule_id: schedule.id, metadata: { execution_context: metadataContext, schedule_access: metadataContext, one_off_attempt: attemptId } });
        recordAttempt(attemptId, { runId: run.id });
        try {
          const output = await runMcpAction(reference, schedule.inputs, access);
          await ActionRuns.complete(run.id, "MCP action completed", null, { type: "json", value: JSON.stringify(output) });
          return { outcome: "succeeded", exitCode: null, runId: run.id };
        } catch (error) {
          await ActionRuns.fail(run.id, String(error));
          return { outcome: "failed", exitCode: null, runId: run.id, reason: String(error) };
        }
      });
    }
    assertToolAllowed(access, { namespace: "bash", toolName: "Bash" }, installationRegistry().id);
    if (boundHasProcessRestrictions(access.bound ?? undefined)) return unavailable("raw scheduled processes cannot enforce selected bounds");
    const { run, timedOut } = await withStoreContext({ identity: access.identity, execution: access }, () => runScriptAction(action, {
      inputs: schedule.inputs,
      trigger: "schedule",
      scheduleId: schedule.id,
      secretScope: access.identity ? { kind: "identity", uuid: access.identity } : { kind: "installation" },
      baseEnv: baseEnv(),
      metadata: { runner_pid: process.pid, one_off_attempt: attemptId, execution_context: metadataContext, schedule_access: metadataContext },
      // The stable id a handler dedupes on: at least once means it may run twice.
      extraEnv: { BARRY_SCHEDULE_ID: schedule.id, BARRY_ATTEMPT_ID: attemptId },
      onStart: ({ runId, processGroup }) => recordAttempt(attemptId, { runId, processGroup }),
    }));
    return {
      outcome: run.status === "complete" ? "succeeded" : timedOut ? "timed_out" : "failed",
      exitCode: run.process?.exit_code ?? null,
      runId: run.id,
      ...(run.summary ? { reason: run.summary } : {}),
    };
  }

  const response = await fetch(`${apiBase()}/schedules/once/${schedule.id}/run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ attempt_id: attemptId }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const runId = typeof body.run_id === "string" ? body.run_id : null;
  if (response.status === 504) return { outcome: "timed_out", exitCode: null, runId };
  // The executor refusing the action (session context, unknown, bad inputs)
  // will refuse it every time.
  if ([404, 409, 422, 424].includes(response.status)) return unavailable(String(body.message ?? body.error ?? response.status));
  if (!response.ok) return { outcome: "failed", exitCode: null, runId, reason: `API ${response.status}: ${String(body.message ?? body.error ?? "")}` };
  return {
    outcome: body.status === "complete" ? "succeeded" : "failed",
    exitCode: null,
    runId,
    ...(typeof body.summary === "string" ? { reason: body.summary } : {}),
  };
}

/** The action run an attempt produced: by id when recorded, else the newest for the schedule since it started. */
async function attemptRun(scheduleId: string, attempt: { runId: string | null; startedAt: Date }) {
  if (attempt.runId) return ActionRuns.get(attempt.runId);
  const runs = await ActionRuns.list({ schedule_id: scheduleId, limit: 1 });
  return runs[0] && runs[0].started_at.getTime() >= attempt.startedAt.getTime() - 1000 ? runs[0] : null;
}

/**
 * Settle schedules a previous scheduler left running. Run lookups are async
 * and recovery is synchronous (it is one transaction per row), so the runs
 * of every orphan are read first.
 */
export async function recoverAtSchedules(): Promise<void> {
  const orphans = getDb()
    .prepare(
      `SELECT a.one_off_id, a.run_id, a.started_at FROM one_off_attempt a JOIN one_off o ON o.id = a.one_off_id
        WHERE o.status = 'running' AND a.outcome = 'running' AND a.runner_pid != ?`,
    )
    .all(process.pid) as Array<{ one_off_id: string; run_id: string | null; started_at: string }>;
  const runs = new Map<string, Awaited<ReturnType<typeof attemptRun>>>();
  for (const o of orphans) runs.set(o.one_off_id, await attemptRun(o.one_off_id, { runId: o.run_id, startedAt: new Date(o.started_at) }));

  const actions = recoverOrphans({
    selfPid: process.pid,
    probe: probeProcess,
    kill: (group) => killGroup(group, 1_000),
    closedRun: (id) => {
      const run = runs.get(id);
      if (!run || run.status === "started") return null;
      return { runId: run.id, succeeded: run.status === "complete", exitCode: run.process?.exit_code ?? null, summary: run.summary };
    },
    openRun: (id) => runs.get(id)?.status === "started",
  });
  for (const a of actions) if (a.action !== "left-alive") process.stdout.write(`schedules: one-off ${a.id} ${a.action}\n`);
}

export async function announce(entry: ScheduleEntry, transition: Transition, outcome: FireOutcome): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase()}/events`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        type: transition === "failure" ? "system_alert" : "task_finished",
        severity: transition === "failure" ? "error" : "success",
        source: "schedules",
        title: `${entry.id}: ${transition === "failure" ? "failed" : "recovered"}`.slice(0, 500),
        ...(outcome.summary ? { body: outcome.summary.slice(0, 2000) } : {}),
        data: { transition, schedule: entry.id, runId: outcome.runId },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Close script runs a previous scheduler process started and never finished.
 *
 * Its children run in their own process groups (so a timeout can kill a
 * script's whole tree), which means they may outlive a crashed scheduler —
 * but nothing is left to record how they ended. A `started` row owned by a
 * dead scheduler is closed as failed saying exactly that, rather than sitting
 * open forever looking like a run in progress.
 */
export async function sweepOrphans(): Promise<void> {
  const started = [...await ActionRuns.listStartedByTrigger("schedule"), ...await ActionRuns.listStartedByTrigger("job")];
  for (const run of started) {
    const owner = run.metadata.runner_pid;
    if (typeof owner !== "number" || owner === process.pid) continue;
    await ActionRuns.finishExecuted(run.id, {
      status: "failed",
      summary: `The scheduler (pid ${owner}) stopped while this ran, so its outcome was not recorded (the process may have finished on its own).`,
      process: { exit_code: null, duration_ms: Date.now() - run.started_at.getTime(), log_path: null },
    });
  }
}

export async function prune(): Promise<void> {
  const day = 86_400_000;
  pruneAtSchedules(new Date(Date.now() - KEEP_FAILED_RUNS_DAYS * day), new Date(Date.now() - KEEP_RUNS_DAYS * day));
  for (const trigger of ["schedule", "job"] as const) {
    await ActionRuns.pruneClosed({
      trigger,
      before: new Date(Date.now() - KEEP_RUNS_DAYS * day),
      failedBefore: new Date(Date.now() - KEEP_FAILED_RUNS_DAYS * day),
    });
  }
}


/**
 * The existing runners, shaped for a durable occurrence ledger (P4.3
 * preparation). Not wired into the service: a scheduler composed with an
 * occurrence ledger uses these for occurrences recorded on the legacy
 * generation, so a job occurrence is keyed by its slot and a script or agent
 * occurrence runs exactly as it does today.
 */
export function occurrenceLegacyRunners(): LegacyOccurrenceRunners {
  return {
    acceptJob: (entry, occurrence) => acceptJobOccurrence(entry, occurrence),
    awaitJob: async (atSchedule) => jobFireOutcome(await awaitAtSchedule(atSchedule.id)),
    findJobOneOff: (occurrence) => findJobOccurrenceAtSchedule(occurrence),
    runAction: async (entry) => {
      const action = await resolveScheduleAction(entry);
      return isScriptAction(action) ? runScript(action, entry) : runAgent(entry);
    },
  };
}
