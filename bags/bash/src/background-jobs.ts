/**
 * Background Bash jobs, keyed per session (same keying as the Bash tool's
 * cwd). Output accumulates in a tail-capped buffer; BashOutput returns only
 * what arrived since the caller's previous read, Claude Code-style.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const MAX_JOB_BUFFER_CHARS = 1024 * 1024; // 1MB tail per job
const MAX_RUNNING_PER_SESSION = 20;
const COMPLETED_RETENTION_MS = 30 * 60 * 1000;

export type JobStatus = "running" | "exited" | "killed";

interface Job {
  id: string;
  sessionKey: string;
  command: string;
  proc: ChildProcessWithoutNullStreams;
  /** Interleaved stdout+stderr, tail-capped. */
  output: string;
  /** How much of `output` the owner has already read. */
  readOffset: number;
  /** Chars dropped from the head by the tail cap (adjusts readOffset). */
  dropped: number;
  status: JobStatus;
  exitCode: number | null;
  endedAtMs: number | null;
}

let jobSequence = 0;
const jobs = new Map<string, Job>();

function sweepCompleted(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.endedAtMs !== null && now - job.endedAtMs > COMPLETED_RETENTION_MS) {
      jobs.delete(id);
    }
  }
}

function appendOutput(job: Job, chunk: string): void {
  job.output += chunk;
  if (job.output.length > MAX_JOB_BUFFER_CHARS) {
    const droppedChars = job.output.length - MAX_JOB_BUFFER_CHARS;
    job.output = job.output.slice(droppedChars);
    job.dropped += droppedChars;
  }
}

export function startBackgroundJob(sessionKey: string, command: string, cwd?: string): string {
  sweepCompleted();
  const running = [...jobs.values()].filter(
    (j) => j.sessionKey === sessionKey && j.status === "running",
  );
  if (running.length >= MAX_RUNNING_PER_SESSION) {
    throw new Error(
      `Session already has ${running.length} running background jobs. ` +
        `Use KillShell to stop one, or wait for one to finish.`,
    );
  }

  jobSequence += 1;
  const id = `bash_${jobSequence}`;
  const proc = spawn("bash", ["-c", command], { cwd: cwd || process.cwd(), env: process.env });
  const job: Job = {
    id,
    sessionKey,
    command,
    proc,
    output: "",
    readOffset: 0,
    dropped: 0,
    status: "running",
    exitCode: null,
    endedAtMs: null,
  };
  jobs.set(id, job);

  proc.stdout.on("data", (d: Buffer) => appendOutput(job, d.toString()));
  proc.stderr.on("data", (d: Buffer) => appendOutput(job, d.toString()));
  proc.on("close", (code) => {
    if (job.status === "running") job.status = "exited";
    job.exitCode = code ?? null;
    job.endedAtMs = Date.now();
  });
  proc.on("error", (err) => {
    appendOutput(job, `\n[spawn error: ${err.message}]`);
    job.status = "exited";
    job.exitCode = 1;
    job.endedAtMs = Date.now();
  });

  return id;
}

function getOwnedJob(sessionKey: string, id: string): Job {
  const job = jobs.get(id);
  if (!job) {
    throw new Error(`No background job "${id}" — it may have finished over 30 minutes ago.`);
  }
  if (job.sessionKey !== sessionKey) {
    throw new Error(`Background job "${id}" belongs to a different session.`);
  }
  return job;
}

export function readJobOutput(
  sessionKey: string,
  id: string,
): { chunk: string; status: JobStatus; exitCode: number | null; command: string } {
  const job = getOwnedJob(sessionKey, id);
  // Positions are absolute (dropped + buffer index) so the tail cap cannot
  // replay output the caller already saw.
  const absoluteEnd = job.dropped + job.output.length;
  const start = Math.max(job.readOffset - job.dropped, 0);
  const chunk = job.output.slice(start);
  job.readOffset = absoluteEnd;
  sweepCompleted();
  return { chunk, status: job.status, exitCode: job.exitCode, command: job.command };
}

export function killBackgroundJob(sessionKey: string, id: string): JobStatus {
  const job = getOwnedJob(sessionKey, id);
  if (job.status === "running") {
    job.status = "killed";
    job.proc.kill("SIGTERM");
    setTimeout(() => {
      if (job.exitCode === null && !job.proc.killed) job.proc.kill("SIGKILL");
    }, 1000).unref?.();
  }
  return job.status;
}

/** Test seam. */
export function resetBackgroundJobsForTests(): void {
  for (const job of jobs.values()) {
    if (job.status === "running") {
      try {
        job.proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  jobs.clear();
}
