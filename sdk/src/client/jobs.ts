import { jobsRoutes } from "../routes/jobs.js";
import { type JobRunRecord } from "../jobs/types.js";
import { BarryApiError } from "./errors.js";
import type { ApiTransport, RequestOptions } from "./http.js";

export type JobRunState = JobRunRecord;

export interface RunJobOptions {
  /**
   * Unique per bag. Repeating the request returns the run it created, so a
   * call whose response was lost is safe to repeat; the job sees it as
   * BARRY_JOB_KEY, stable across its retries.
   */
  key?: string;
  /** The run's bound. Default: the job's own `timeout`, else 600; at most 3600. */
  timeoutS?: number;
  /** The session asking: the run acts for it and gets none of the job's declared secrets. */
  callerSessionId?: string;
  /** Hold the first response until the run ends or this many seconds pass. */
  waitS?: number;
}

const TERMINAL = new Set<JobRunState["status"]>(["succeeded", "failed", "cancelled", "uncertain"]);

/** A started job run: its latest state, and how to read, wait for or stop it. */
export class JobRun {
  readonly id: string;
  /** The state as of the last call that returned one. */
  state: JobRunState;
  private readonly jobs: Jobs;

  constructor(jobs: Jobs, state: JobRunState) {
    this.jobs = jobs;
    this.id = state.id;
    this.state = state;
  }

  /** Refresh the state, waiting up to `waitS` for the run to end. */
  async get(options: { waitS?: number } = {}, request: RequestOptions = {}): Promise<JobRunState> {
    const state = await this.jobs.get(this.id, options, request);
    if (!state) throw new BarryApiError(`Job run ${this.id} is gone`, { status: 404, code: "unknown_job_run" });
    this.state = state;
    return state;
  }

  /**
   * Wait for the run to end and return what it produced: the parsed JSON for
   * a job with an output_schema, stdout's tail otherwise (null when it printed
   * nothing). A run that did not succeed throws, naming why.
   */
  async output<T = unknown>(request: RequestOptions = {}): Promise<T | string | null> {
    let state = this.state;
    while (!TERMINAL.has(state.status)) state = await this.get({ waitS: 60 }, request);
    if (state.status !== "succeeded") {
      throw new BarryApiError(`Job ${state.job} ${state.status}${state.reason ? `: ${state.reason}` : ""}`, { status: null, code: `job_${state.status}`, detail: state });
    }
    if (state.output === null) return null;
    return state.outputType === "json" ? JSON.parse(state.output) as T : state.output;
  }

  /** Stop the run: cancelled before it starts, asked to stop while it runs. */
  cancel(request: RequestOptions = {}): Promise<{ cancelled: boolean; status: JobRunState["status"]; cancelRequested?: boolean }> {
    return this.jobs.cancel(this.id, request);
  }
}

/**
 * Run a bag's jobs (`jobs:` in bag.yaml). At least once: a job may run twice
 * after a crash, so it dedupes side effects on BARRY_JOB_KEY. See
 * sdk/src/bags/job-manifest.ts for what a job declares.
 */
export class Jobs {
  private readonly http: ApiTransport;

  // A field, not a parameter property: strip-only type stripping cannot
  // transform those, and bundled bag code must load under plain Node.
  constructor(http: ApiTransport) {
    this.http = http;
  }

  /** Start `bag:name[@version]` with `inputs`, checked against its input_schema now and when it runs. */
  async run(ref: string, inputs: Record<string, unknown> = {}, options: RunJobOptions = {}, request: RequestOptions = {}): Promise<JobRun> {
    const created = await this.http.call(jobsRoutes.startJobRun, { params: { ref: ref }, body: {
        inputs,
        ...(options.key ? { key: options.key } : {}),
        ...(options.timeoutS ? { timeoutS: options.timeoutS } : {}),
        ...(options.callerSessionId ? { callerSessionId: options.callerSessionId } : {}),
        ...(options.waitS ? { waitS: options.waitS } : {}),
      } }, { ...request });
    return new JobRun(this, created!.run);
  }

  /** A run's state, waiting up to `waitS` for it to end; null when no run has this id. */
  async get(id: string, options: { waitS?: number } = {}, request: RequestOptions = {}): Promise<JobRunState | null> {
    const found = await this.http.call(jobsRoutes.getJobRun, { params: { id: id }, ...(options.waitS ? { query: { waitS: options.waitS } } : {}) }, { ...request, notFound: "null" });
    return found?.run ?? null;
  }

  async cancel(id: string, request: RequestOptions = {}): Promise<{ cancelled: boolean; status: JobRunState["status"]; cancelRequested?: boolean }> {
    const result = await this.http.call(jobsRoutes.cancelJobRun, { params: { id: id } }, request);
    return {
      cancelled: result!.cancelled,
      status: result!.status,
      ...(result!.cancelRequested !== undefined ? { cancelRequested: result!.cancelRequested } : {}),
    };
  }
}
