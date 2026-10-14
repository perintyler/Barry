/**
 * `jobs:` in bag.yaml — a unit of work Barry runs: a contract plus what does
 * the work.
 *
 *   jobs:
 *     reaper:
 *       description: Close sessions whose OS process is gone
 *       runs:
 *         using: node                 # Barry's pinned Node; TypeScript runs as-is
 *         main: jobs/reaper.ts
 *         secrets: [BARRY_SECRET]
 *         env:
 *           - BARRY_REAPER_DRY_RUN=0
 *       timeout: 10m
 *     name-session:
 *       runs:
 *         using: process              # exec form, no shell
 *         command: [uv, run, jobs/name_session.py]
 *     triage-failure:
 *       runs:
 *         using: action               # an agent does it: this bag's action, or bag:name
 *         action: triage-failure
 *
 * The contract (`requires`, `preflight`, `validate`, `input_schema`,
 * `output_schema`, `timeout`) is the one actions declare (work-contract.ts),
 * so a job and an action describe their work in one vocabulary. `runs:`
 * follows GitHub Actions' `runs.using`: the field that says what executes the
 * work decides which other fields apply.
 *
 * A job is not an action. An action is what an agent is offered (find_actions
 * lists it); a job is what Barry runs — on a schedule, from the SDK, for a
 * subagent. A job that needs an agent names an action rather than growing a
 * prompt of its own, so there is one place a prompt lives.
 */

import { z } from "zod";
import { SecretNamesSchema } from "../env/secret-names.js";
import { LiteralEnvSchema, normalizeLiteralEnv, type LiteralEnvValue } from "../services/literal-env.js";
import { EntrySchema } from "../services/launch.js";
import { ContractShape, JobRequiresSchema, checkContract, normalizeContract, type WorkContract } from "../actions/work-contract.js";

/** Process fields shared by the two kinds that run code. */
const ProcessFields = {
  /** Credential names resolved for the process from the job's caller. */
  secrets: SecretNamesSchema.optional(),
  /** Non-secret KEY=VALUE literals. */
  env: LiteralEnvSchema.optional(),
  /** Relative to the bag directory. Defaults to it. */
  "working-directory": z.string().min(1).optional(),
};

const RunsSchema = z.discriminatedUnion("using", [
  z.strictObject({
    using: z.literal("node"),
    /** A JavaScript or TypeScript file inside the bag, run with Barry's pinned Node. */
    main: EntrySchema,
    ...ProcessFields,
  }),
  z.strictObject({
    using: z.literal("process"),
    /**
     * argv, exec form: run directly, never through a shell, so an argument
     * is one argument however it is spelled.
     */
    command: z.array(z.string().min(1)).min(1),
    ...ProcessFields,
  }),
  z.strictObject({
    using: z.literal("action"),
    /** `name` (this bag's) or `bag:name`. Resolved when the catalog is assembled. */
    action: z.string().min(1),
  }),
]);

export const JobSchema = z
  .strictObject({
    description: z.string().min(1).optional(),
    /**
     * Declared to make the job runnable on other machines: a versioned job is
     * addressed as `bag:name@version`, and a change in behavior is a new
     * version rather than a silent edit under a name workers already run.
     */
    version: z.union([z.string().min(1), z.number()]).optional(),
    ...ContractShape,
    requires: JobRequiresSchema.optional(),
    /** Named bounds the job's process runs under. See the bounds-per-kind rules. */
    bounds: z.array(z.string().min(1)).optional(),
    runs: RunsSchema,
  })
  .superRefine((job, ctx) => {
    if (job.runs.using === "action") {
      // The action owns its I/O contract; a second copy here could disagree.
      for (const field of ["input_schema", "output_schema"] as const) {
        if (job[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `an action job takes \`${field}\` from its action` });
        }
      }
    }
    if (job.bounds !== undefined) {
      // A bound is enforced on the job's own process. preflight and validate
      // are shell commands Barry runs outside it, so under a bound they would
      // be the one part of the job the bound does not reach.
      for (const field of ["preflight", "validate"] as const) {
        if (job[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `a bounded job cannot declare \`${field}\`: it runs as a shell command outside the bound` });
        }
      }
      if (job.runs.using === "process") {
        ctx.addIssue({ code: "custom", path: ["bounds"], message: "a `process` job cannot be bounded: Barry cannot confine an arbitrary program; use `node`" });
      }
      // A bounded job runs under Node's permission model, which denies the
      // child processes tsx needs to compile TypeScript; and it may read
      // only its own entry file, so that file must be the whole program.
      if (job.runs.using === "node" && !/\.m?js$/.test(job.runs.main)) {
        ctx.addIssue({ code: "custom", path: ["runs", "main"], message: "a bounded node job's main must be one self-contained .mjs or .js file: under its bound it cannot compile TypeScript or read other files" });
      }
    }
  });

export type JobRuns =
  | { using: "node"; main: string; secrets?: string[]; env?: LiteralEnvValue[]; workingDirectory?: string }
  | { using: "process"; command: string[]; secrets?: string[]; env?: LiteralEnvValue[]; workingDirectory?: string }
  | { using: "action"; action: string };

/** A job, normalized: its contract in the camelCase every reader uses. */
export type BagJob = WorkContract & {
  description?: string;
  version?: string;
  bounds?: string[];
  runs: JobRuns;
};

/** Job names become `bag:name` references, so they follow the action-name grammar. */
const JOB_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The shape `jobs:` had before `schedules:` replaced it: a trigger and a
 * shell command on the job itself. Recognized so the old manifest gets the
 * migration message instead of a list of unrecognized keys.
 */
function isRetiredJob(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const job = raw as Record<string, unknown>;
  return !("runs" in job) && ["interval", "schedule", "at", "command"].some((key) => key in job);
}

export const RETIRED_JOBS_MESSAGE =
  "`jobs:` was replaced by `schedules:`. Each job becomes a schedule — `interval: 300` → `every: 5m` " +
  "(calendar cron), `schedule: {hour: 4, minute: 30}` → `cron: \"30 4 * * *\"`, `at: login` stays — " +
  "with its command as an inline action: " +
  "action: {description, run: {command, args}, env, timeout}. See bags/schedules/README.md.";

/**
 * The manifest's `jobs:` field. Each entry is checked against JobSchema with
 * its issues reported under `jobs.<name>`; an entry in the retired shape is
 * reported with the message that says how to move it.
 */
export const JobsSchema = z.record(z.string(), z.unknown()).superRefine((jobs, ctx) => {
  for (const [name, raw] of Object.entries(jobs)) {
    if (isRetiredJob(raw)) {
      ctx.addIssue({ code: "custom", path: [name], message: RETIRED_JOBS_MESSAGE });
      continue;
    }
    if (!JOB_NAME.test(name)) {
      ctx.addIssue({ code: "custom", path: [name], message: "job names must be kebab-case" });
    }
    const parsed = JobSchema.safeParse(raw);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: [name, ...issue.path.map(String)], message: issue.message });
    }
  }
});

/** Normalize one job already accepted by JobsSchema. */
export function normalizeJob(name: string, raw: unknown, label: string): BagJob {
  const job = JobSchema.parse(raw);
  checkContract(job, `${label} jobs.${name}`);
  const runs: JobRuns = job.runs.using === "action"
    ? { using: "action", action: job.runs.action }
    : {
        ...(job.runs.using === "node" ? { using: "node" as const, main: job.runs.main } : { using: "process" as const, command: job.runs.command }),
        ...(job.runs.secrets ? { secrets: [...new Set(job.runs.secrets)] } : {}),
        ...(job.runs.env ? { env: normalizeLiteralEnv(job.runs.env) } : {}),
        ...(job.runs["working-directory"] ? { workingDirectory: job.runs["working-directory"] } : {}),
      };
  return {
    ...(job.description ? { description: job.description } : {}),
    ...(job.version !== undefined ? { version: String(job.version) } : {}),
    ...normalizeContract(job),
    ...(job.bounds ? { bounds: job.bounds } : {}),
    runs,
  };
}
