import { scheduleRuntime } from "../lib/schedule-runtime.js";
import { cachedHostProbes } from "./doctor.js";
import { identityRecords } from "@barry-rocks/identities-bag";
import { defaultHarness, FALLBACK_HARNESS } from "@barry-rocks/sdk/internal/identities";
import { assertOwnedActionRun, assertOwnedSchedule, ownsSchedule, filterOwnedRuns, runOwnerMetadata, runSecretTarget, withRunBounds } from "../resource-target.js";
import { CliError } from "../lib/cli-error.js";
/**
 * barry schedule — see, run, pause and read the history of schedules.
 *
 * Reads the stores directly (like `barry action runs`), so it works with the
 * API down. `run` executes a script schedule here and hands an agent schedule
 * to the API, which owns agent spawns.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ActionRuns } from "@barry-rocks/actions-bag";
import { runScriptAction } from "@barry-rocks/actions-bag";
import { isScriptAction } from "@barry-rocks/sdk/internal/actions";
import { findSchedule, listSchedules, resolveScheduleAction } from "@barry-rocks/schedules-bag";
import { scheduleContext } from "@barry-rocks/schedules-bag";
import { listStates, updateState } from "@barry-rocks/schedules-bag";
import { cancelAtSchedule, getAtSchedule, listAtSchedules } from "@barry-rocks/schedules-bag";
import { runScheduledJob } from "@barry-rocks/schedules-bag";
import { ScheduleOccurrenceDispatcher, acceptJobOccurrence, awaitAtSchedule, findJobOccurrenceAtSchedule, getOccurrence, jobFireOutcome, newScheduleOccurrence, probeProcess, processStartTime, recordOccurrence, type FireOutcome, type ScheduleEntry } from "@barry-rocks/schedules-bag";
import { schedulerHealth } from "@barry-rocks/schedules-bag";
import { summarizeSchedule } from "@barry-rocks/schedules-bag";
import { getServicePort } from "@barry-rocks/sdk/services";

const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  const span = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  if (abs < 1) return "just now";
  return s > 0 ? `in ${span}` : `${span} ago`;
}

async function requireSchedule(id: string) {
  const entry = await findSchedule(id);
  if (!entry) {
    const { schedules } = await listSchedules();
    throw new CliError(`Unknown schedule "${id}". Schedules are <bag>/<name>: ${schedules.map((s) => s.id).join(", ") || "(none)"}`, 1);
  }
  assertOwnedSchedule(entry.schedule.identity);
  return entry;
}

/** barry schedule list */
export async function scheduleListCommand(options: { json?: boolean }): Promise<void> {
  const { schedules, errors } = await listSchedules();
  const states = listStates();
  const health = schedulerHealth();
  const probes = cachedHostProbes();
  const { adapters } = await (await import("../adapters/installed.js")).adapterStore();
  const rows = await Promise.all(schedules.filter(s => ownsSchedule(s.schedule.identity)).map(async entry => {
    const row = summarizeSchedule(entry, states.get(entry.id));
    if (entry.schedule.payload.kind === "job") return row;
    try {
      const action = await resolveScheduleAction(entry);
      if (isScriptAction(action) || action.job) return row;
      const identity = entry.schedule.identity ? await identityRecords.find(entry.schedule.identity) : undefined;
      const harness = action.agent?.agent ?? (identity ? defaultHarness(identityRecords.config(identity.record).adapters) : undefined) ?? FALLBACK_HARNESS;
      return { ...row, runtime: scheduleRuntime(harness, adapters.installed(), probes) };
    } catch (error) {
      return { ...row, runtime: { scope: "local" as const, warning: error instanceof Error ? error.message : "could not assess adapter" } };
    }
  }));
  if (options.json) {
    console.log(JSON.stringify({ scheduler: health.status, load_errors: errors, schedules: rows }, null, 2));
    return;
  }

  const healthLine =
    health.status === "ok"
      ? `${GREEN}●${RESET} scheduler running ${DIM}(beat ${when(health.heartbeat.at.toISOString())})${RESET}`
      : `${health.status === "down" ? RED : YELLOW}●${RESET} scheduler ${health.status}: ${health.reason}`;
  console.log(healthLine);
  for (const error of errors) console.log(`${RED}!${RESET} ${error}`);
  console.log("");

  for (const r of rows) {
    const icon = !r.enabled || r.paused ? `${DIM}○${RESET}` : r.consecutive_failures > 0 ? `${RED}●${RESET}` : r.last_status ? `${GREEN}●${RESET}` : `${DIM}●${RESET}`;
    const flags = [!r.enabled && "disabled", r.paused && "paused", r.consecutive_failures > 0 && `${r.consecutive_failures} failing`]
      .filter(Boolean)
      .join(", ");
    console.log(`${icon} ${BOLD}${r.id}${RESET}  ${r.trigger}  ${DIM}→ ${r.action}${RESET}${flags ? `  ${YELLOW}${flags}${RESET}` : ""}`);
    console.log(`    ${DIM}last ${when(r.last_fired_at)}${r.last_status ? ` (${r.last_status})` : ""} · next ${r.paused ? "paused" : when(r.next_fire_at)}${r.skipped_fires ? ` · ${r.skipped_fires} skipped` : ""}${r.missed_fires ? ` · ${r.missed_fires} missed` : ""}${RESET}`);
    if ("runtime" in r && r.runtime) {
      if ("warning" in r.runtime) console.log(`    ${YELLOW}local runtime: ${r.runtime.warning}${RESET}`);
      else for (const check of r.runtime.checks ?? []) if (check.status !== "ok") console.log(`    ${YELLOW}local runtime: ${check.observed}${RESET}`);
    }
  }
  if (rows.length === 0) console.log(`${DIM}No schedules. Declare them under schedules: in a bag.yaml.${RESET}`);

  const active = [
    ...listAtSchedules({ status: "pending", limit: 50 }),
    ...listAtSchedules({ status: "running", limit: 50 }),
    ...listAtSchedules({ status: "uncertain", limit: 20 }),
    ...listAtSchedules({ status: "failed", limit: 10 }),
  ].filter(atSchedule => ownsSchedule(atSchedule.permissions.identity));
  if (active.length) {
    console.log(`\n${BOLD}At-schedules${RESET}`);
    for (const o of active) {
      const colour = o.status === "failed" || o.status === "uncertain" ? RED : o.status === "running" ? YELLOW : DIM;
      console.log(`${colour}●${RESET} ${o.id}  ${o.action ?? "inline"}  ${o.status} ${DIM}due ${when(o.dueAt.toISOString())}${o.reason ? ` · ${o.reason}` : ""}${RESET}`);
    }
  }
}

export function scheduleCancelCommand(id: string): void {
  assertOwnedSchedule(getAtSchedule(id)?.permissions.identity);
  const result = cancelAtSchedule(id);
  if (!result) {
    console.error(`No at-schedule "${id}".`);
    process.exitCode = 1;
    return;
  }
  console.log(result.cancelled ? `${id} cancelled` : result.cancelRequested ? `${id} is running; asked it to stop` : `${id} is ${result.status}; not cancelled`);
  if (!result.cancelled && !result.cancelRequested) process.exitCode = 1;
}

/** barry schedule show <id> — the schedule and its recent runs */
export async function scheduleShowCommand(id: string, options: { limit?: string; json?: boolean }): Promise<void> {
  if (id.startsWith("sch_")) {
    const atSchedule = getAtSchedule(id);
    if (!atSchedule) {
      console.error(`No at-schedule "${id}".`);
      process.exitCode = 1;
      return;
    }
    assertOwnedSchedule(atSchedule.permissions.identity);
    if (options.json) {
      console.log(JSON.stringify(atSchedule, null, 2));
      return;
    }
    console.log(`${BOLD}${atSchedule.id}${RESET}  ${atSchedule.action ?? "inline action"}  ${atSchedule.status}`);
    console.log(`${DIM}due ${when(atSchedule.dueAt.toISOString())} · ${atSchedule.failures} failed · ${atSchedule.recoveries} recovered · timeout ${atSchedule.timeoutS}s${RESET}`);
    if (atSchedule.reason) console.log(atSchedule.reason);
    for (const a of atSchedule.attempts ?? []) {
      console.log(`  #${a.number} ${a.outcome}${a.exitCode !== null ? ` (exit ${a.exitCode})` : ""} ${DIM}${when(a.startedAt.toISOString())}${a.runId ? ` · ${a.runId}` : ""}${RESET}`);
    }
    return;
  }
  const entry = await requireSchedule(id);
  const summary = summarizeSchedule(entry, listStates().get(id));
  const runs = await filterOwnedRuns(await ActionRuns.list({ schedule_id: id, limit: Number(options.limit ?? 20) }));
  if (options.json) {
    console.log(JSON.stringify({ ...summary, runs }, null, 2));
    return;
  }
  console.log(`${BOLD}${summary.id}${RESET}  ${summary.trigger}  ${DIM}→ ${summary.action}${RESET}`);
  if (summary.description) console.log(summary.description);
  if (summary.last_status === "failed" && summary.last_summary) console.log(`${RED}last failure:${RESET} ${summary.last_summary}`);
  console.log(`${DIM}next ${summary.paused ? "paused" : when(summary.next_fire_at)} · ${summary.consecutive_failures} failing in a row · ${summary.skipped_fires} skipped · ${summary.missed_fires} missed${RESET}`);
  console.log("");
  for (const run of runs) {
    const icon = run.status === "complete" ? `${GREEN}●${RESET}` : run.status === "started" ? `${YELLOW}◌${RESET}` : `${RED}●${RESET}`;
    const took = run.process ? ` ${(run.process.duration_ms / 1000).toFixed(1)}s` : "";
    console.log(`${icon} ${when(run.started_at.toISOString())}${took} ${DIM}${run.id}${run.trigger && run.trigger !== "schedule" ? ` (${run.trigger})` : ""}${RESET}  ${run.summary ?? ""}`);
  }
  if (runs.length === 0) console.log(`${DIM}No runs yet.${RESET}`);
}

/** A manual occurrence id: what makes "run it now" retryable without running twice. */
const MANUAL_OCCURRENCE = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * barry schedule run <id> — run it now, outside its trigger.
 *
 * With `occurrence` (P4 preparation; not registered as a CLI option yet), the
 * run is a durable manual occurrence: recorded once under that id, and a
 * retry with the same id observes or replays that occurrence instead of
 * starting a second run. Without it, behaviour is unchanged.
 */
export async function scheduleRunCommand(id: string, options: { occurrence?: string } = {}): Promise<void> {
  const entry = await requireSchedule(id);
  if (options.occurrence !== undefined) {
    await scheduleRunOccurrence(entry, options.occurrence);
    return;
  }
  if (entry.schedule.payload.kind === "job") {
    // A job run, which the scheduler service runs; this waits for it.
    const now = new Date();
    const outcome = await runScheduledJob(entry, now, `${entry.id}@run-${now.toISOString()}`);
    console.error(`${outcome.status === "complete" ? GREEN : RED}●${RESET} ${outcome.status} — ${outcome.summary} ${DIM}${outcome.runId ?? ""}${RESET}`);
    if (outcome.status !== "complete") process.exitCode = 1;
    return;
  }
  const action = await resolveScheduleAction(entry);
  if (isScriptAction(action)) {
    const callerBounds = await scheduleContext(entry);
    const { run } = await withRunBounds(() => runScriptAction(action, {
      ...(entry.schedule.inputs ? { inputs: entry.schedule.inputs } : {}),
      secretScope: runSecretTarget(), metadata: runOwnerMetadata(),
      trigger: "cli",
      scheduleId: entry.id,
    }), callerBounds);
    console.error(`${run.status === "complete" ? GREEN : RED}●${RESET} ${run.status} — ${run.summary ?? ""} ${DIM}${run.id}${RESET}`);
    if (run.output) console.log(run.output);
    if (run.status !== "complete") process.exitCode = 1;
    return;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) headers.Authorization = `Bearer ${process.env.BARRY_SECRET}`;
  const response = await fetch(`http://127.0.0.1:${getServicePort("api")}/api/v1/schedules/${encodeURIComponent(entry.bag)}/${encodeURIComponent(entry.name)}/run`, {
    method: "POST",
    headers,
    body: "{}",
  }).catch((error: unknown) => {
    throw new CliError(`Could not reach the API to run an agent schedule: ${error instanceof Error ? error.message : String(error)}`, 1);
  });
  const body = (await response.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2));
  if (!response.ok || body.status !== "complete") process.exitCode = 1;
}

/**
 * Run one manual occurrence of a schedule through the occurrence ledger, on
 * the legacy generation: a job one-off keyed by the occurrence, or the script
 * here / the agent in the API as `run` does today. An occurrence that was
 * already dispatched is reported, never run again.
 */
async function scheduleRunOccurrence(entry: ScheduleEntry, manualId: string): Promise<void> {
  if (!MANUAL_OCCURRENCE.test(manualId)) throw new CliError("A manual occurrence id is 1-100 letters, digits, '.', '_', ':' or '-'.", 2);
  const now = new Date();
  const recorded = recordOccurrence({
    occurrence: newScheduleOccurrence({ entry, kind: "manual", discriminator: manualId, policy: { late: false, coalesced_slots: 1, manual_id: manualId }, generation: "legacy" }),
    state: "pending",
    now,
  });
  const occurrenceId = recorded.occurrence.occurrenceId;
  console.error(`${DIM}occurrence ${occurrenceId}${recorded.created ? "" : " (recorded earlier)"}${RESET}`);
  const dispatcher = new ScheduleOccurrenceDispatcher({
    admission: null,
    legacy: {
      acceptJob: (e, occurrence) => acceptJobOccurrence(e, occurrence),
      awaitJob: async (atSchedule) => jobFireOutcome(await awaitAtSchedule(atSchedule.id)),
      findJobOneOff: (occurrence) => findJobOccurrenceAtSchedule(occurrence),
      runAction: (e) => runScheduleActionOnce(e),
    },
    runner: { pid: process.pid, startedAt: processStartTime(process.pid) },
    probe: probeProcess,
    now: () => new Date(),
  });
  dispatcher.recoverAbandoned();
  const result = await dispatcher.dispatch(occurrenceId, entry);
  if (result.kind === "ran") {
    console.error(`${result.outcome.status === "complete" ? GREEN : RED}●${RESET} ${result.outcome.status} — ${result.outcome.summary} ${DIM}${result.outcome.runId ?? ""}${RESET}`);
    if (result.outcome.status !== "complete") process.exitCode = 1;
    return;
  }
  const state = getOccurrence(occurrenceId)?.dispatch;
  console.error(`${YELLOW}◌${RESET} occurrence ${occurrenceId} is ${state?.state ?? result.kind}${state?.workId ? ` as ${state.workId}` : ""}${state?.outcome ? ` (${state.outcome})` : ""}; it is not run again.${state?.lastError ? ` ${DIM}${state.lastError}${RESET}` : ""}`);
  if (state?.outcome !== "complete") process.exitCode = 1;
}

/** The script/agent half of `run`, as one outcome. */
async function runScheduleActionOnce(entry: ScheduleEntry): Promise<FireOutcome> {
  const action = await resolveScheduleAction(entry);
  if (isScriptAction(action)) {
    const callerBounds = await scheduleContext(entry);
    const { run } = await withRunBounds(() => runScriptAction(action, {
      ...(entry.schedule.inputs ? { inputs: entry.schedule.inputs } : {}),
      secretScope: runSecretTarget(), metadata: runOwnerMetadata(),
      trigger: "cli",
      scheduleId: entry.id,
    }), callerBounds);
    if (run.output) console.log(run.output);
    return { status: run.status === "complete" ? "complete" : "failed", runId: run.id, summary: run.summary ?? "" };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) headers.Authorization = `Bearer ${process.env.BARRY_SECRET}`;
  const response = await fetch(`http://127.0.0.1:${getServicePort("api")}/api/v1/schedules/${encodeURIComponent(entry.bag)}/${encodeURIComponent(entry.name)}/run`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const body = (await response.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2));
  return {
    status: response.ok && body.status === "complete" ? "complete" : "failed",
    runId: typeof body.run_id === "string" ? body.run_id : null,
    summary: typeof body.summary === "string" ? body.summary : "",
  };
}

/** barry schedule pause|resume <id> */
export async function schedulePauseCommand(id: string, paused: boolean): Promise<void> {
  await requireSchedule(id);
  // Resume recomputes the due time from now: time spent paused is not caught up.
  updateState(id, paused ? { paused } : { paused, trigger_key: null });
  console.log(`${id} ${paused ? "paused" : "resumed"}`);
}

/** barry schedule logs <id> — the log of its latest (or a given) run */
export async function scheduleLogsCommand(id: string, options: { run?: string; follow?: boolean }): Promise<void> {
  await requireSchedule(id);
  const run = options.run
    ? await ActionRuns.get(options.run)
    : (await ActionRuns.list({ schedule_id: id, limit: 1 }))[0];
  if (!run) {
    console.error(`No runs recorded for ${id}.`);
    process.exitCode = 1;
    return;
  }
  if (run.schedule_id !== id) throw new Error("run belongs to another schedule");
  await assertOwnedActionRun(run);
  const logPath = run.process?.log_path;
  if (!logPath || !existsSync(logPath)) {
    // Agent runs have no process log; their record is the run itself.
    console.error(`Run ${run.id} has no log file${run.process ? " (it was pruned)" : " — it was an agent run; see `barry action show " + run.id + "`"}.`);
    process.exitCode = 1;
    return;
  }
  console.error(`${DIM}${logPath}${RESET}`);
  if (options.follow) {
    spawn("tail", ["-f", logPath], { stdio: "inherit" });
    return;
  }
  process.stdout.write(readFileSync(logPath, "utf8"));
}
