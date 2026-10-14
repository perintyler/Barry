import { SecretNamesSchema } from "../env/secret-names.js";
/**
 * `schedules:` in bag.yaml — work, run on a trigger.
 *
 *   schedules:
 *     reaper:
 *       every: 5m                      # or cron: "30 4 * * *" (+ timezone:), or at: <ISO time>
 *       job: reaper                    # one of this bag's jobs (`jobs:`), or bag:name
 *     digest:
 *       cron: "0 9 * * 1"
 *       action: slack:weekly-digest    # or an action, by reference
 *       inputs: { channel: eng }
 *     sweep:
 *       every: 1h
 *       action:                        # or an inline action: an action.yaml body minus `name`
 *         description: Sweep
 *         run: { command: tsx, args: [src/sweep.ts] }
 *
 * A `job:` fire is a job run like any other — a one-off in the scheduler, keyed
 * by the schedule and fire time — so it gets the job's contract, its bounds,
 * and its own concurrency budget.
 *
 * Replaces the old launchd-shaped `jobs:`, whose trigger could express neither
 * cron, timezones nor a one-off time, and whose command could only be a shell
 * line.
 *
 * Every check a trigger can fail is made HERE, at parse time: an invalid cron
 * expression, an unknown timezone, two triggers or none. `jobs:` accepted
 * `schedule: {}` and let setup skip it with a warning — a manifest that
 * validated and then never ran.
 */

import { Cron } from "croner";
import { z } from "zod";
import { LaunchShape } from "../services/launch.js";
import { LiteralEnvSchema } from "../services/literal-env.js";
import { DurationSchema } from "./duration.js";
import { validateAction, type ActionManifest } from "../actions/action-manifest.js";

const CALENDAR_CRON = {
  "1m": "* * * * *", "5m": "*/5 * * * *", "15m": "*/15 * * * *",
  "30m": "*/30 * * * *", "1h": "0 * * * *", "1d": "0 0 * * *",
} as const;

export const ScheduleSchema = z
  .object({
    description: z.string().min(1).optional(),
    every: z.enum(["1m", "5m", "15m", "30m", "1h", "1d"]).optional(),
    cron: z.string().min(1).optional(),
    /** IANA zone the cron expression is read in. Defaults to UTC. */
    timezone: z.string().min(1).optional(),
    /**
     * Run once at an offset-bearing ISO timestamp or once per verified operating-system login session; login work is a job rather than a persistent service.
     * See docs/decisions/0011-sdk-runtime-invariants.md for the retained rationale.
     */
    at: z.string().min(1).optional(),
    /** `bag:name` / `name` of an existing action, or an inline action body. */
    action: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    /** A job, `name` (this bag's) or `bag:name[@version]`. */
    job: z.string().min(1).optional(),
    entry: LaunchShape.entry,
    args: LaunchShape.args,
    env: LiteralEnvSchema.optional(),
    secrets: SecretNamesSchema.optional(),
    timeout: DurationSchema.optional(),
    /**
     * The barry an agent action runs as: whose credentials it gets and whose
     * default agent and model it uses. Absent resolves as any detached run
     * does. Ignored by a `run:` action, which runs with its declared env.
     */
    identity: z.string().min(1).optional(),
    /** Inputs handed to the action, checked against its input_schema when it runs. */
    inputs: z.record(z.string(), z.unknown()).optional(),
    traits: z.array(z.string().min(1)).optional(),
    bounds: z.array(z.string().min(1)).optional(),
    /** A fire that lands while the last run is still going: skip it (default) or run it after. */
    overlap: z.enum(["skip", "queue"]).optional(),
    /** A fire missed while nothing was running (asleep, off): run it once on return (default), or not at all. */
    catch_up: z.enum(["none", "once"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const payloads = (["entry", "action", "job"] as const).filter((p) => s[p] !== undefined);
    if (payloads.length !== 1) {
      ctx.addIssue({ code: "custom", message: "a schedule needs exactly one payload: `entry`, `action` or `job`" });
    }
    if (s.entry === undefined) {
      for (const key of ["args", "env", "secrets", "timeout"] as const) {
        if (s[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `belongs to script \`entry\`; ${s.job !== undefined ? "a job" : "an action"} owns its execution requirements` });
      }
    }
    const triggers = (["every", "cron", "at"] as const).filter((t) => s[t] !== undefined);
    if (triggers.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: triggers.length === 0
          ? "needs a trigger: one of `every`, `cron` or `at`"
          : `declares ${triggers.join(" and ")}; a schedule has exactly one trigger`,
      });
      return;
    }
    if (s.timezone !== undefined && s.cron === undefined && s.every === undefined) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "only applies to recurring cron schedules" });
    }
    if (s.timezone !== undefined) {
      try {
        if (/^[+-]/.test(s.timezone)) throw new Error("offsets are not IANA timezone names");
        new Intl.DateTimeFormat("en", { timeZone: s.timezone }).format();
      } catch {
        ctx.addIssue({ code: "custom", path: ["timezone"], message: "must name an IANA timezone" });
      }
    }
    if (s.cron !== undefined) {
      try {
        // Constructed paused and asked for a run: croner validates the zone
        // lazily, so building it alone would accept `Mars/Base`.
        if (s.cron.trim().split(/\s+/).length !== 5) throw new Error("cron must have exactly five fields");
        new Cron(s.cron, { paused: true, timezone: s.timezone ?? "UTC" }).nextRun();
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["cron"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (s.at !== undefined && s.at !== "login" && !z.iso.datetime({ offset: true }).safeParse(s.at).success) {
      ctx.addIssue({ code: "custom", path: ["at"], message: `"${s.at}" is not an ISO-8601 time with an explicit offset or "login"` });
    }
  });

/** Keep a shorthand payload in authored action form for durable one-off storage. */
export function scheduleScriptAction(raw: z.infer<typeof ScheduleSchema>): Record<string, unknown> | null {
  if (raw.entry === undefined) return typeof raw.action === "object" ? raw.action : null;
  return {
    description: raw.description ?? raw.entry,
    run: { entry: raw.entry, ...(raw.args ? { args: raw.args } : {}) },
    ...(raw.env ? { env: raw.env } : {}),
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    ...(raw.timeout !== undefined ? { timeout: raw.timeout } : {}),
  };
}

export type ScheduleTrigger =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "at"; time: string }
  /** Once per verified operating-system login event. */
  | { kind: "login" };

/** What a schedule runs: an action by reference, an inline action, or a job by reference. */
export type SchedulePayload =
  | { kind: "ref"; ref: string }
  | { kind: "inline"; manifest: ActionManifest }
  | { kind: "job"; ref: string };

/** The payloads that are actions. */
export type ScheduleActionSource = Exclude<SchedulePayload, { kind: "job" }>;

/** A schedule, normalized. */
export interface BagSchedule {
  description?: string;
  trigger: ScheduleTrigger;
  payload: SchedulePayload;
  inputs?: Record<string, unknown>;
  identity?: string;
  traits?: string[];
  bounds?: string[];
  overlap: "skip" | "queue";
  catchUp: "none" | "once";
  enabled: boolean;
}

/**
 * Normalize one parsed schedule. An inline action is validated here, as a
 * full action, so a broken one fails the manifest rather than its first fire.
 *
 * `bagDir` is where an inline action's relative paths resolve (its `run:`
 * script, a `format: file` prompt) — the bag directory, so a job moving onto a
 * schedule keeps every path it had.
 */
export function normalizeSchedule(
  name: string,
  raw: z.infer<typeof ScheduleSchema>,
  bagDir: string,
  label: string,
): BagSchedule {
  const trigger: ScheduleTrigger =
    raw.every !== undefined
      ? { kind: "cron", expression: CALENDAR_CRON[raw.every], timezone: raw.timezone ?? "UTC" }
      : raw.cron !== undefined
        ? { kind: "cron", expression: raw.cron, timezone: raw.timezone ?? "UTC" }
        : raw.at === "login"
          ? { kind: "login" }
          : { kind: "at", time: raw.at as string };

  let payload: SchedulePayload;
  if (raw.entry !== undefined) {
    const body = { context: "none", ...scheduleScriptAction(raw), name };
    payload = { kind: "inline", manifest: validateAction(body, bagDir, `${label} schedules.${name}.entry`) };
  } else if (raw.job !== undefined) {
    payload = { kind: "job", ref: raw.job };
  } else if (typeof raw.action === "string") {
    payload = { kind: "ref", ref: raw.action };
  } else {
    // An inline action is part of an unattended schedule; there is no calling
    // conversation for it to need, so it is detached unless it says otherwise
    // (and a prompt action saying `session` will be refused when it fires).
    const body = { context: "none", ...raw.action, name };
    payload = { kind: "inline", manifest: validateAction(body, bagDir, `${label} schedules.${name}.action`) };
  }

  return {
    ...(raw.description ? { description: raw.description } : {}),
    trigger,
    payload,
    ...(raw.inputs ? { inputs: raw.inputs } : {}),
    ...(raw.identity ? { identity: raw.identity } : {}),
    ...(raw.traits ? { traits: raw.traits } : {}),
    ...(raw.bounds ? { bounds: raw.bounds } : {}),
    overlap: raw.overlap ?? "skip",
    catchUp: raw.catch_up ?? "once",
    enabled: raw.enabled ?? true,
  };
}

/** The one spelling of a schedule's identity: CLI argument, run column, log dir. */
export function scheduleId(bag: string, name: string): string {
  return `${bag}/${name}`;
}
