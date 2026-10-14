/**
 * A session summary's model call, made by a worker instead of this machine.
 *
 * The prompt goes to the `sessions:summarize-session@1` job through this
 * installation's workflows owner (`job@1`), which places it on a worker that
 * advertises the job (one with a local model). The run id is the session and
 * its message watermark, so a sweep that stops waiting, or restarts, comes
 * back to the same run instead of starting another: a start with an id the
 * owner already holds returns that run.
 */
import { serviceAddress } from "@barry-rocks/sdk/services";

export const SUMMARY_JOB = "sessions:summarize-session@1";

export interface WorkersCompletion {
  base?: string;
  secret?: string;
  /** How long one sweep waits before leaving the run to the next one. */
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

/**
 * Whether a live worker of this installation's owner offers the summary job
 * right now. False when the workflows service cannot be reached: the sweep
 * then summarizes locally, as it always has.
 */
export async function workerOffersSummaries(options: WorkersCompletion = {}): Promise<boolean> {
  try {
    const base = options.base ?? serviceAddress("workflows.runtime");
    const secret = options.secret ?? process.env.BARRY_SECRET;
    const answer = await (options.fetch ?? fetch)(`${base}/api/overview`, { headers: secret ? { authorization: `Bearer ${secret}` } : {}, signal: AbortSignal.timeout(5000) });
    if (!answer.ok) return false;
    const overview = (await answer.json()) as { workers?: { types?: string[] }[] };
    return (overview.workers ?? []).some(worker => worker.types?.includes(SUMMARY_JOB));
  } catch {
    return false;
  }
}

/** A run that has not finished yet; the next sweep reconnects to it. */
export class SummaryStillRunning extends Error {}

export async function completeOnWorkers(prompt: string, model: string, runId: string, options: WorkersCompletion = {}): Promise<string> {
  const base = options.base ?? serviceAddress("workflows.runtime");
  const secret = options.secret ?? process.env.BARRY_SECRET;
  const send = options.fetch ?? fetch;
  const headers = { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
  const started = await send(`${base}/api/runs`, { method: "POST", headers, body: JSON.stringify({ id: runId, type: "job", version: "1", input: { job: SUMMARY_JOB, input: { prompt, model } } }), signal: AbortSignal.timeout(10_000) });
  if (!started.ok) throw new Error(`the workflows owner refused the summary run (${started.status}): ${(await started.text()).slice(0, 300)}`);
  const deadline = Date.now() + (options.timeoutMs ?? 6 * 60_000);
  for (;;) {
    const answer = await send(`${base}/api/runs/${encodeURIComponent(runId)}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!answer.ok) throw new Error(`could not read summary run ${runId} (${answer.status})`);
    const status = ((await answer.json()) as { run?: { status?: string } }).run?.status;
    if (status && status !== "running") {
      const payloads = await send(`${base}/api/runs/${encodeURIComponent(runId)}/payloads`, { headers, signal: AbortSignal.timeout(10_000) });
      const outcome = ((await payloads.json()) as { outcome?: { ok: boolean; value?: { text?: unknown }; error?: { message?: string } } }).outcome;
      if (status === "completed" && outcome?.ok && typeof outcome.value?.text === "string") return outcome.value.text;
      throw new Error(`summary run ${runId} ended ${status}: ${outcome?.error?.message ?? "no result"}`);
    }
    if (Date.now() >= deadline) throw new SummaryStillRunning(`summary run ${runId} is still ${status ?? "pending"} (waiting for a worker?); the next sweep picks it up`);
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 2000));
  }
}
