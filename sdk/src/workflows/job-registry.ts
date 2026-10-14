/**
 * The bag jobs this installation can run for a workflows owner.
 *
 * A job is remotable in v1 when it is versioned (addressed as
 * `<bag>:<job>@<version>`), runs on Node, declares no secrets, and is bounded
 * to no files at all: its main is then one self-contained file that runs
 * under Node's permission model with nothing but the network. Owners pin each
 * job's contract and the digest of that file; workers advertise the ones they
 * meet the requirements of.
 */
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { getRegistrySnapshotPath } from "../bags/paths.js";
import { loadBuiltinRegistry, loadRegistry } from "../bags/registry.js";
import { parseManifest } from "../bags/manifest.js";
import type { Bound } from "../bounds/types.js";
import { mergeBounds } from "../bounds/merge-bounds.js";
import { inspectArtifact } from "./artifacts.js";
import type { JobContract } from "./types.js";
import { boundToNodeFlags } from "./job-launcher.js";

/** The job fields this module reads, as a loaded bag carries them. */
export interface RemotableJobSource {
  name: string;
  dir: string;
  version?: string;
  bounds?: string[];
  runs: { using: string; main?: string; secrets?: string[] };
  requires: { bins: string[]; labels?: Record<string, string> };
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Seconds. */
  timeout?: number;
}

export interface InstalledJob {
  type: string;
  bag: string;
  contract: JobContract;
  /** The self-contained file a worker runs, by its real path. */
  main: string;
  bound: Bound;
  /** Node permission flags the bound translates to. */
  flags: string[];
  requires: { bins: string[]; labels: Record<string, string> };
}

export interface JobInventory { jobs: InstalledJob[]; skipped: { type: string; reason: string }[] }

/** Why a job cannot run on another machine, or undefined when it can. */
function notRemotable(job: RemotableJobSource, bound: Bound | null): string | undefined {
  if (job.runs.using !== "node") return `it runs with \`using: ${job.runs.using}\`; only node jobs run on other machines`;
  if (job.runs.secrets?.length) return "it declares secrets, which never leave this installation";
  if (!job.bounds?.length || !bound) return "it is unbounded; a job runs elsewhere only bounded to `files: { allowOnly: [] }`";
  if (!bound.files?.allowOnly || bound.files.allowOnly.length > 0) return "its bound lets it touch files; a job runs elsewhere only with `files: { allowOnly: [] }`";
  return undefined;
}

export async function installedJobs(bags: readonly { name: string; jobs?: readonly RemotableJobSource[] }[], boundByName: (name: string) => Promise<Bound | null | undefined>): Promise<JobInventory> {
  const inventory: JobInventory = { jobs: [], skipped: [] };
  for (const bag of bags) {
    for (const job of bag.jobs ?? []) {
      if (job.version === undefined) continue;
      const type = `${bag.name}:${job.name}@${job.version}`;
      const skip = (reason: string) => { inventory.skipped.push({ type, reason }); };
      let bound: Bound | null = null;
      try {
        for (const name of job.bounds ?? []) {
          const resolved = await boundByName(name);
          if (!resolved) throw new Error(`unknown bound ${name}; run \`barry bag sync-traits ${bag.name}\``);
          bound = mergeBounds(bound, resolved);
        }
      } catch (error) { skip(error instanceof Error ? error.message : String(error)); continue; }
      const reason = notRemotable(job, bound);
      if (reason) { skip(reason); continue; }
      const flags = boundToNodeFlags(bound);
      if ("refused" in flags) { skip(flags.refused); continue; }
      let main: string, digest: string;
      try {
        main = realpathSync(resolve(job.dir, job.runs.main!));
        digest = inspectArtifact(main, type, String(job.version), false).digest;
      } catch (error) { skip(`its main is not one self-contained file: ${error instanceof Error ? error.message : String(error)}`); continue; }
      inventory.jobs.push({
        type, bag: bag.name, main, bound: bound!, flags: flags.flags,
        requires: { bins: job.requires.bins, labels: job.requires.labels ?? {} },
        contract: { type, digest, ...(job.inputSchema ? { inputSchema: job.inputSchema } : {}), ...(job.outputSchema ? { outputSchema: job.outputSchema } : {}), ...(job.timeout ? { timeoutMs: job.timeout * 1000 } : {}) },
      });
    }
  }
  return inventory;
}

/** `BARRY_WORKFLOW_LABELS=model=local,gpu=metal` → labels a worker advertises beside os and arch. */
export function workerLabels(value: string | undefined, base: Record<string, string>): Record<string, string> {
  const labels = { ...base };
  for (const entry of (value ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const [key, ...rest] = entry.split("=");
    if (!key || !rest.length || !/^[a-z0-9][a-z0-9._-]*$/i.test(key)) throw new Error(`BARRY_WORKFLOW_LABELS entry "${entry}" is not key=value`);
    labels[key] = rest.join("=");
  }
  return labels;
}

/** Why this worker should not advertise a job, or undefined when it meets the job's requirements. */
export function unmetRequirement(job: InstalledJob, labels: Record<string, string>, path = process.env.PATH ?? ""): string | undefined {
  for (const bin of job.requires.bins) {
    if (!path.split(delimiter).some((dir) => dir && existsSync(join(dir, bin)))) return `needs \`${bin}\` on PATH`;
  }
  for (const [key, value] of Object.entries(job.requires.labels)) {
    if (labels[key] !== value) return `needs the label ${key}=${value} (set BARRY_WORKFLOW_LABELS)`;
  }
  return undefined;
}

/**
 * The installed bags' remotable jobs, read from their manifests (no bag tools
 * are loaded). An inventory problem yields no jobs and says why, so a caller
 * such as the workflows service keeps running without them.
 */
export async function installationJobs(boundByName: (name: string) => Promise<Bound | null | undefined>): Promise<JobInventory> {
  try {
    const registry = existsSync(getRegistrySnapshotPath()) ? loadRegistry() : loadBuiltinRegistry();
    const bags: { name: string; jobs: RemotableJobSource[] }[] = [];
    for (const [name, source] of Object.entries(registry)) {
      if (source.type !== "local" || !existsSync(source.path)) continue;
      const manifest = parseManifest(source.path);
      bags.push({ name, jobs: Object.entries(manifest?.jobs ?? {}).map(([jobName, job]) => ({ name: jobName, dir: source.path, ...job })) });
    }
    return await installedJobs(bags, boundByName);
  } catch (error) {
    return { jobs: [], skipped: [{ type: "*", reason: `the installed bags could not be read: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}
