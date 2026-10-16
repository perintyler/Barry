/**
 * Job catalog — find the jobs bags declare, and check the links between them
 * and the actions they name.
 *
 * Jobs are deliberately NOT in the action catalog. `listAllActions` is what
 * find_actions and the session prompt's actions index read, and a job is work
 * Barry runs, not a procedure an agent is offered; keeping them in a separate
 * listing makes that true by construction rather than by a filter someone
 * could forget.
 *
 * A reference is `bag:name`, optionally pinned to a version with `@version`.
 * A bare name resolves only inside the bag that wrote it: a schedule or action
 * naming `reaper` means its own bag's reaper, and resolving a bare name across
 * bags would let whichever bag loaded first decide what runs.
 */

import type { ActionMeta } from "../actions/action-registry.js";
import type { BagJob } from "../bags/job-manifest.js";

/** What the registry needs of a loaded bag. */
export interface JobRegistryBag {
  readonly name: string;
  readonly jobs?: ReadonlyArray<BagJob & { name: string; dir: string }>;
}

/** A job as the registry serves it. */
export type JobMeta = BagJob & {
  bag: string;
  name: string;
  /** `bag:name` — the spelling run records and schedules use. */
  qualifiedName: string;
  /** The bag directory the job's paths resolve in. */
  dir: string;
};

export interface JobRef {
  bag?: string;
  name: string;
  version?: string;
}

/** Split `name`, `bag:name` or either with `@version`. */
export function parseJobRef(ref: string): JobRef {
  const at = ref.lastIndexOf("@");
  const base = at > 0 ? ref.slice(0, at) : ref;
  const version = at > 0 ? ref.slice(at + 1) : undefined;
  const sep = base.indexOf(":");
  return {
    ...(sep > 0 ? { bag: base.slice(0, sep), name: base.slice(sep + 1) } : { name: base }),
    ...(version ? { version } : {}),
  };
}

/** Every job of every bag, in bag order. */
export function listAllJobs(bags: readonly JobRegistryBag[]): JobMeta[] {
  return bags.flatMap((bag) => (bag.jobs ?? []).map((job) => ({ ...job, bag: bag.name, qualifiedName: `${bag.name}:${job.name}` })));
}
export const buildJobRegistry = listAllJobs;

/**
 * Look up one job. A bare name needs `fromBag`, the bag doing the asking; a
 * pinned version must match the job's declared one exactly.
 */
export function findJob(bags: readonly JobRegistryBag[], ref: string, options: { fromBag?: string } = {}): JobMeta | null {
  const parsed = parseJobRef(ref);
  const bag = parsed.bag ?? options.fromBag;
  if (!bag) return null;
  const job = listAllJobs(bags).find((j) => j.bag === bag && j.name === parsed.name);
  if (!job) return null;
  if (parsed.version !== undefined && job.version !== parsed.version) return null;
  return job;
}

/** The `bag:name` an action job's `action:` names, given the job's own bag. */
export function jobActionRef(job: Pick<JobMeta, "bag">, action: string): string {
  return action.includes(":") ? action : `${job.bag}:${action}`;
}

export interface JobLinkProblem {
  job: string;
  problem: string;
}

/**
 * Action jobs whose action cannot do the job.
 *
 * An action job runs its action detached, in a fresh agent, so the action
 * must exist, be `context: none` (there is no calling conversation for it to
 * read), and be a prompt — an action that runs code is a `node` or `process`
 * job under another name, and pointing a job at it would make one piece of
 * work reachable by two routes that record it differently.
 *
 * A REPORT, like findUnresolvedSteps: one broken link must not hide every
 * other job, so callers decide whether a problem is fatal.
 */
export function checkJobLinks(jobs: readonly JobMeta[], actions: readonly ActionMeta[]): JobLinkProblem[] {
  const byName = new Map(actions.map((a) => [a.qualifiedName, a]));
  const problems: JobLinkProblem[] = [];
  for (const job of jobs) {
    if (job.runs.using !== "action") continue;
    const ref = jobActionRef(job, job.runs.action);
    const action = byName.get(ref);
    if (!action) {
      problems.push({ job: job.qualifiedName, problem: `runs action "${ref}", which does not exist` });
    } else if (action.run !== undefined || action.job !== undefined) {
      problems.push({ job: job.qualifiedName, problem: `runs action "${ref}", which runs code rather than an agent; declare the code as a node or process job instead` });
    } else if (action.context !== "none") {
      problems.push({ job: job.qualifiedName, problem: `runs action "${ref}", which needs a calling conversation (context: session); a job runs it detached` });
    }
  }
  return problems;
}

export interface ActionJobLinkProblem {
  action: string;
  problem: string;
}

/**
 * `job:` actions whose job cannot be what the action offers.
 *
 * The job must exist, and must run code (`node` or `process`): a `job:`
 * action naming an action job would run an action that runs an action — a
 * loop with two names for one piece of work. Together with checkJobLinks this
 * keeps the graph one step deep either way. A REPORT, for the same reason.
 */
export function checkActionJobLinks(actions: readonly ActionMeta[], bags: readonly JobRegistryBag[]): ActionJobLinkProblem[] {
  const problems: ActionJobLinkProblem[] = [];
  for (const action of actions) {
    if (action.job === undefined) continue;
    const job = findJob(bags, action.job, { fromBag: action.bag });
    if (!job) problems.push({ action: action.qualifiedName, problem: `runs job "${action.job}", which does not exist` });
    else if (job.runs.using === "action") problems.push({ action: action.qualifiedName, problem: `runs job "${job.qualifiedName}", which runs an action itself; a job: action must name a node or process job` });
  }
  return problems;
}
