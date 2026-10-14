/**
 * Every schedule Barry knows about, and the action each one runs.
 *
 * Two sources, one grammar: `schedules:` in registered bags, and schedules
 * created at runtime (stored as the same YAML-shaped spec and parsed by the
 * same schema, under the pseudo-bag `runtime`).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadAllBags, getInvalidManifests, loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { barryCacheDir } from "@barry-rocks/sdk/services";

import { ScheduleSchema, normalizeSchedule, scheduleId, type BagSchedule } from "@barry-rocks/sdk/internal/schedules";
import { validateAction, type ActionManifest, contractFields, findAction, type ActionMeta } from "@barry-rocks/sdk/internal/actions";


import { findJob, jobActionRef } from "@barry-rocks/sdk/internal/jobs";
import { listRuntimeSchedules } from "./store.js";
import type { OneOff } from "./one-offs.js";

/** The pseudo-bag runtime-created schedules live under. */
export const RUNTIME_BAG = "runtime";

export interface ScheduleEntry {
  /** `<bag>/<name>` — the one spelling used everywhere. */
  id: string;
  bag: string;
  name: string;
  /** Directory an inline action runs in: the bag's, or the runtime scratch dir. */
  dir: string;
  schedule: BagSchedule;
}

export interface ScheduleListing {
  schedules: ScheduleEntry[];
  /** Bags and runtime schedules that failed to load — each one is a schedule not running. */
  errors: string[];
}

/**
 * Where a runtime schedule's inline action runs. It has no bag, so relative
 * paths have nothing to mean; a scratch directory keeps them from resolving
 * against wherever the scheduler happened to start.
 */
export function runtimeDir(): string {
  // Scratch, rebuilt as needed, so it lives with the cache rather than the data.
  const dir = join(barryCacheDir(), "schedules", "runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse one runtime spec with the bag grammar. Throws with the schema's message. */
export function parseRuntimeSpec(name: string, spec: unknown): BagSchedule {
  const parsed = ScheduleSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.map((i) => `${i.path.join(".") || "schedule"}: ${i.message}`).join("; "),
    );
  }
  // An inline action takes the schedule's name as its own, which must be
  // kebab-case; a one-off's name is only an idempotency key and may be any
  // string (watch:<id>:<time>), so it lends the action a stand-in.
  const actionName = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? name : "one-off";
  const schedule = normalizeSchedule(actionName, parsed.data, runtimeDir(), `runtime schedule ${name}`);
  // A runtime schedule has no bag of its own for a bare job name to mean.
  if (schedule.payload.kind === "job" && !schedule.payload.ref.includes(":")) {
    throw new Error(`job: a runtime schedule names its job as bag:name, got "${schedule.payload.ref}"`);
  }
  return schedule;
}

/**
 * List every schedule. Loads bags fresh each call — a bag.yaml edit must reach
 * the scheduler without a restart, which is the setup rerun jobs needed.
 */
export async function listSchedules(): Promise<ScheduleListing> {
  const errors: string[] = [];
  const schedules: ScheduleEntry[] = [];

  const bags = await loadAllBags();
  for (const bag of bags) {
    for (const s of bag.schedules ?? []) {
      schedules.push({ id: scheduleId(bag.name, s.name), bag: bag.name, name: s.name, dir: s.dir, schedule: s });
    }
  }
  // A bag whose manifest failed to parse contributes no schedules — which
  // would look exactly like a bag that declares none. Said out loud instead.
  for (const [bag, reason] of getInvalidManifests()) {
    errors.push(`bag ${bag}: invalid manifest, its schedules are not running: ${reason}`);
  }

  for (const row of listRuntimeSchedules()) {
    try {
      schedules.push({
        id: scheduleId(RUNTIME_BAG, row.name),
        bag: RUNTIME_BAG,
        name: row.name,
        dir: runtimeDir(),
        schedule: parseRuntimeSpec(row.name, row.spec),
      });
    } catch (error) {
      errors.push(`runtime/${row.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { schedules, errors };
}

export async function findSchedule(id: string): Promise<ScheduleEntry | null> {
  const { schedules } = await listSchedules();
  return schedules.find((s) => s.id === id) ?? null;
}

/**
 * The action a schedule runs, as the catalog would serve it.
 *
 * An inline action is not in the catalog — it belongs to its schedule, and
 * listing it would offer agents a maintenance script as a procedure. It is
 * built here with the qualified name `<bag>:schedule/<name>`, which is what
 * its runs record, so they cannot collide with a real action's.
 */
export async function resolveScheduleAction(entry: ScheduleEntry): Promise<ActionMeta> {
  const source = entry.schedule.payload;
  if (source.kind === "job") throw new Error(`schedule ${entry.id} runs job "${source.ref}", not an action; it fires as a job run`);
  if (source.kind === "ref") {
    const { bags } = await loadBagRegistrySnapshot();
    const found = await findAction(bags, source.ref);
    if (!found) throw new Error(`schedule ${entry.id} runs action "${source.ref}", which does not exist`);
    return found;
  }
  return inlineActionMeta(source.manifest, entry.bag, `schedule/${entry.name}`, entry.dir);
}

/**
 * The action a one-off runs, or why it cannot run. Resolved when the attempt
 * starts, not when it was scheduled, so an upgraded bag runs its upgraded
 * action. An action that is gone, or an inline body that no longer
 * validates, is `unavailable` — trying again cannot change the answer.
 */
export async function resolveOneOffAction(oneOff: OneOff): Promise<{ action: ActionMeta } | { unavailable: string }> {
  if (oneOff.job) {
    // Only an action job reaches here: its action does the work, under the
    // job's timeout. A code job is run by job-runner.ts.
    const { bags } = await loadBagRegistrySnapshot();
    const job = findJob(bags, oneOff.job, { fromBag: oneOff.bag });
    if (!job) return { unavailable: `job "${oneOff.job}" does not exist` };
    if (job.runs.using !== "action") return { unavailable: `job "${oneOff.job}" runs code, not an action` };
    const ref = jobActionRef(job, job.runs.action);
    const found = await findAction(bags, ref);
    if (!found) return { unavailable: `job "${oneOff.job}" runs action "${ref}", which does not exist` };
    if (found.run !== undefined || found.context !== "none") return { unavailable: `job "${oneOff.job}" runs action "${ref}", which a job cannot run detached` };
    return { action: found };
  }
  if (oneOff.action) {
    const { bags } = await loadBagRegistrySnapshot();
    const found = await findAction(bags, oneOff.action);
    return found ? { action: found } : { unavailable: `action "${oneOff.action}" does not exist` };
  }
  if (!oneOff.inlineAction) return { unavailable: "names no action" };
  try {
    const manifest = validateAction(
      { context: "none", ...oneOff.inlineAction, name: "one-off" },
      runtimeDir(),
      `one-off ${oneOff.id}`,
    );
    return { action: inlineActionMeta(manifest, oneOff.bag, `once/${oneOff.id}`, runtimeDir()) };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether a job one-off's job is an action job (and so runs in the API). False when the job is gone: job-runner reports that. */
export async function isActionJob(oneOff: OneOff): Promise<boolean> {
  if (!oneOff.job) return false;
  const { bags } = await loadBagRegistrySnapshot();
  return findJob(bags, oneOff.job, { fromBag: oneOff.bag })?.runs.using === "action";
}

/** An inline action as the catalog would serve it, under a name that cannot collide with a real one. */
function inlineActionMeta(manifest: ActionManifest, bag: string, name: string, dir: string): ActionMeta {
  const shared = {
    // A schedule's inline action runs under the bag it names, with that
    // bag's access, so it is a bag action for every purpose downstream.
    source: "bag" as const,
    name,
    bag,
    qualifiedName: `${bag}:${name}`,
    dir,
    description: manifest.description,
    ...contractFields(manifest),
    requires: manifest.requires,
    instructions: manifest.instructions,
    steps: manifest.steps,
    slashCommand: false,
    scripts: [],
    ...(manifest.agent ? { agent: manifest.agent } : {}),
    context: manifest.context,
    legacySkill: false,
    bagAccess: "enabled" as const,
    shadowed: false,
  };
  if (manifest.job !== undefined) return { ...shared, job: manifest.job };
  if (manifest.run !== undefined) {
    return {
      ...shared,
      run: manifest.run,
      ...(manifest.secrets ? { secrets: manifest.secrets } : {}),
      ...(manifest.env ? { env: manifest.env } : {}),
    };
  }
  return { ...shared, prompt: manifest.prompt };
}
