import { Barry } from "@barry-rocks/sdk";
/**
 * MCP tools for schedules: see them, create one-offs and recurring ones at
 * runtime, pause, and run now.
 */


import { getServiceUrl } from "@barry-rocks/sdk/services";
import { ScheduleSchema, scheduleScriptAction, type ScheduleTrigger } from "@barry-rocks/sdk/internal/schedules";
import { z } from "zod";
import { listSchedules, findSchedule, parseRuntimeSpec, RUNTIME_BAG, type ScheduleEntry } from "./registry.js";
import { deleteRuntimeSchedule, insertRuntimeSchedule, listStates, updateState, type ScheduleState } from "./store.js";
import { cancelAtSchedule, createAtSchedule, listAtSchedules, type AtSchedule } from "./at-schedules.js";
import { parseActionRef } from "@barry-rocks/sdk/internal/actions";
import { parseJobRef } from "@barry-rocks/sdk/internal/jobs";
import { schedulerHealth } from "./health.js";
import { assertScheduleSelection } from "./permissions.js";

export function describeTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "cron":
      return `cron ${trigger.expression}${trigger.timezone ? ` (${trigger.timezone})` : ""}`;
    case "at":
      return `at ${trigger.time}`;
    case "login":
      return "at login";
  }
}

/** One schedule and its state, as every surface reports it. */
export function summarizeSchedule(entry: ScheduleEntry, state: ScheduleState | undefined) {
  const payload = entry.schedule.payload;
  return {
    id: entry.id,
    trigger: describeTrigger(entry.schedule.trigger),
    action: payload.kind === "job" ? `job ${payload.ref}` : payload.kind === "ref" ? payload.ref : `inline (${payload.manifest.job !== undefined ? "job" : payload.manifest.run !== undefined ? "run" : "prompt"})`,
    ...(payload.kind === "job" ? { job: payload.ref } : {}),
    ...(entry.schedule.description ? { description: entry.schedule.description } : {}),
    enabled: entry.schedule.enabled,
    paused: state?.paused ?? false,
    next_fire_at: state?.next_fire_at?.toISOString() ?? null,
    last_fired_at: state?.last_fired_at?.toISOString() ?? null,
    last_status: state?.last_status ?? null,
    last_summary: state?.last_summary ?? null,
    last_run_id: state?.last_run_id ?? null,
    consecutive_failures: state?.consecutive_failures ?? 0,
    skipped_fires: state?.skipped_fires ?? 0,
    missed_fires: state?.missed_fires ?? 0,
  };
}

/** An at-schedule as every surface reports it. */
export function summarizeAtSchedule(o: AtSchedule) {
  return {
    id: o.id,
    action: o.job ? `job ${o.job}` : o.action ?? "inline",
    ...(o.job ? { job: o.job } : {}),
    due_at: o.dueAt.toISOString(),
    status: o.status,
    ...(o.reason ? { reason: o.reason } : {}),
    ...(Object.keys(o.inputs).length ? { inputs: o.inputs } : {}),
    failures: o.failures,
    recoveries: o.recoveries,
  };
}

export const listSchedulesTool = Barry.Tool({
  namespace: "schedules",
  access: "read",
  name: "list_schedules",
  description: "List every schedule — bag-declared and runtime-created recurring ones with their trigger, next and last fire and failure streak, and one-offs that are pending, running or recently finished. Also reports whether the scheduler itself is alive.",
  schema: {},
  handler: async () => {
    const { schedules, errors } = await listSchedules();
    const states = listStates();
    const health = schedulerHealth();
    return {
      scheduler: health.status === "ok" ? "ok" : `${health.status}: ${health.reason}`,
      ...(errors.length ? { load_errors: errors } : {}),
      schedules: schedules.map((s) => summarizeSchedule(s, states.get(s.id))),
      one_offs: listAtSchedules({ limit: 30 }).map(summarizeAtSchedule),
    };
  },
});

const ScheduleIdParam = z.string().min(1).describe("Schedule id, `<bag>/<name>` (runtime schedules are `runtime/<name>`).");

export const pauseScheduleTool = Barry.Tool({
  namespace: "schedules",
  access: "write",
  name: "pause_schedule",
  description: "Pause a schedule: it stops firing until resumed. Fires missed while paused are not caught up.",
  schema: { id: ScheduleIdParam },
  handler: async ({ id }) => {
    if (!(await findSchedule(id))) throw new Error(`No schedule "${id}". Call list_schedules.`);
    updateState(id, { paused: true });
    return { id, paused: true };
  },
});

export const resumeScheduleTool = Barry.Tool({
  namespace: "schedules",
  access: "write",
  name: "resume_schedule",
  description: "Resume a paused schedule. Its next fire is computed from now, so time spent paused is not caught up.",
  schema: { id: ScheduleIdParam },
  handler: async ({ id }) => {
    const entry = await findSchedule(id);
    if (!entry) throw new Error(`No schedule "${id}". Call list_schedules.`);
    // Clearing the trigger key makes the scheduler compute a fresh due time,
    // so a schedule paused for a week does not "catch up" on resume.
    updateState(id, { paused: false, trigger_key: null });
    return { id, paused: false };
  },
});

export const createScheduleTool = Barry.Tool({
  namespace: "schedules",
  access: "write",
  name: "create_schedule",
  description: `Create a schedule at runtime. The spec is exactly what bag.yaml takes under schedules.<name>. A recurring one (\`every\`/\`cron\`) is stored as runtime/<name>; an \`at\` one is a one-off (id sch_…), which also takes \`retry: {attempts: 1..5}\`, and repeating a create with the same name returns it rather than making a second:
- a trigger: \`every\` ("5m", "1h"), \`cron\` ("0 9 * * 1", optional \`timezone\`), or \`at\` (ISO time with offset, runs once)
- \`action\`: an action name ("bag:name") or an inline action ({description, run: ...} or {description, prompt: ...})
- optional \`inputs\`, \`overlap\` (skip|queue), \`catch_up\` (none|once), \`enabled\`.
Example reminder: {"at":"2030-01-01T09:00:00Z","bags":["bash"],"action":{"description":"Remind","run":{"command":"barry","args":["notify","Standup"]}}}
The selected bag must provide bash:Bash; choose an installed identity or explicitly select bags.`,
  schema: {
    name: z
      .string()
      .min(1)
      .max(200)
      .describe("Schedule name. Kebab-case for a recurring one (it becomes runtime/<name>); any string for an `at` one-off, where it is the idempotency key."),
    spec: z.record(z.string(), z.unknown()).describe("The schedule, as bag.yaml would declare it."),
  },
  handler: async ({ name, spec }, context) => {
    // A one-off: `retry` is its own option, not part of the bag grammar.
    const { retry, ...grammar } = spec as { retry?: { attempts?: number } } & Record<string, unknown>;
    // Parsed with the bag grammar before it is stored: a runtime schedule
    // that could never fire must be refused now, not discovered at its time.
    const schedule = parseRuntimeSpec(name, grammar);
    if (schedule.trigger.kind !== "at" && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      throw new Error(`A recurring schedule's name becomes its id (runtime/${name}), so it must be kebab-case.`);
    }
    assertScheduleSelection(schedule, `${RUNTIME_BAG}/${name}`);
    if (schedule.trigger.kind === "at") {
      const ref = schedule.payload.kind === "ref" ? schedule.payload.ref : null;
      const job = schedule.payload.kind === "job" ? schedule.payload.ref : null;
      if (job && !parseJobRef(job).bag) throw new Error(`A runtime schedule names its job as bag:name, got "${job}".`);
      const { schedule: created } = createAtSchedule({
        bag: job ? parseJobRef(job).bag! : ref ? (parseActionRef(ref).bag ?? RUNTIME_BAG) : RUNTIME_BAG,
        action: ref,
        ...(job ? { job } : { inlineAction: scheduleScriptAction(ScheduleSchema.parse(grammar)) }),
        inputs: schedule.inputs ?? {},
        permissions: { identity: schedule.identity, bags: schedule.bags, bounds: schedule.bounds },
        dueAt: new Date(schedule.trigger.time),
        idempotencyKey: `runtime:${name}`,
        ...(retry?.attempts ? { retryAttempts: Math.min(Math.max(retry.attempts, 1), 5) } : {}),
        createdBy: context?.sessionId ?? null,
      });
      return { id: created.id, trigger: describeTrigger(schedule.trigger), status: created.status };
    }
    try {
      insertRuntimeSchedule(name, spec, context?.sessionId ?? null);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error(`runtime/${name} already exists; delete it first to replace it.`);
      throw error;
    }
    return { id: `${RUNTIME_BAG}/${name}`, trigger: describeTrigger(schedule.trigger) };
  },
});

export const deleteScheduleTool = Barry.Tool({
  namespace: "schedules",
  access: "write",
  name: "delete_schedule",
  description: "Delete a runtime-created schedule (runtime/<name>). Bag schedules are removed by editing the bag's bag.yaml.",
  schema: { name: z.string().min(1).describe("The runtime schedule's name, without the runtime/ prefix.") },
  handler: async ({ name }) => {
    if (!deleteRuntimeSchedule(name)) throw new Error(`No runtime schedule "${name}".`);
    return { deleted: `${RUNTIME_BAG}/${name}` };
  },
});

export const cancelScheduleTool = Barry.Tool({
  namespace: "schedules",
  access: "write",
  name: "cancel_schedule",
  description: "Cancel a one-off schedule (sch_…). One that has not started is cancelled; a running one is asked to stop (its script is killed) and ends cancelled. The answer says which.",
  schema: { id: z.string().min(1).describe("The one-off's id, sch_…") },
  handler: async ({ id }) => {
    const result = cancelAtSchedule(id);
    if (!result) throw new Error(`No one-off schedule "${id}".`);
    return { id, ...result };
  },
});

/**
 * The API URL that runs a schedule now. Built from `getServiceUrl("api")` so a
 * host or scheme change moves this and the scheduler's runners together, rather
 * than leaving one on a hard-coded `http://127.0.0.1:<port>`.
 */
export function runScheduleUrl(id: string): string {
  const slash = id.lastIndexOf("/");
  if (slash <= 0) throw new Error(`Schedule ids are <bag>/<name>, got "${id}".`);
  const base = getServiceUrl("api").replace(/\/+$/, "");
  return `${base}/api/v1/schedules/${encodeURIComponent(id.slice(0, slash))}/${encodeURIComponent(id.slice(slash + 1))}/run`;
}

export const runScheduleTool = Barry.Tool({
  namespace: "schedules",
  access: "write",
  name: "run_schedule",
  description: "Run a schedule's action now, outside its trigger, and return the run. Does not change when it next fires.",
  schema: { id: ScheduleIdParam },
  handler: async ({ id }) => {
    const url = runScheduleUrl(id);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.BARRY_SECRET) headers.Authorization = `Bearer ${process.env.BARRY_SECRET}`;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({}) });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Run refused (${response.status}): ${String(body.message ?? body.error ?? "")}`);
    return body;
  },
});
