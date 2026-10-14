import { expect, it } from "vitest";
import { completeOnWorkers, SUMMARY_JOB, SummaryStillRunning, workerOffersSummaries } from "./summary-on-workers.js";

/** A workflows owner that finishes a run after `polls` status reads. */
function owner(final: { status: string; outcome: unknown }, polls = 1) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let reads = 0;
  const fetch: typeof globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init?.method === "POST") return new Response(JSON.stringify({ id: "x" }), { status: 201 });
    if (url.endsWith("/payloads")) return new Response(JSON.stringify({ outcome: final.outcome }));
    reads++;
    return new Response(JSON.stringify({ run: { status: reads >= polls ? final.status : "running" } }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

it("starts job@1 for the summary job under a stable run id and returns the worker's text", async () => {
  const { fetch, calls } = owner({ status: "completed", outcome: { ok: true, value: { text: "### Done\n- x" } } }, 2);
  expect(await completeOnWorkers("prompt", "qwen3:8b", "summary-s1-9", { base: "http://owner", secret: "s", fetch, pollMs: 1 })).toBe("### Done\n- x");
  expect(calls[0]).toEqual({ method: "POST", url: "http://owner/api/runs", body: { id: "summary-s1-9", type: "job", version: "1", input: { job: SUMMARY_JOB, input: { prompt: "prompt", model: "qwen3:8b" } } } });
});

it("reports a failed run, and leaves a run still waiting for a worker to the next sweep", async () => {
  const failed = owner({ status: "failed", outcome: { ok: false, error: { message: "ollama answered 404" } } });
  await expect(completeOnWorkers("p", "m", "r", { base: "http://owner", fetch: failed.fetch, pollMs: 1 })).rejects.toThrow(/ended failed: ollama answered 404/);
  const waiting = owner({ status: "completed", outcome: null }, 1_000_000);
  await expect(completeOnWorkers("p", "m", "r", { base: "http://owner", fetch: waiting.fetch, pollMs: 1, timeoutMs: 20 })).rejects.toBeInstanceOf(SummaryStillRunning);
});

it("finds a live worker offering the summary job, and says no when the owner cannot be reached", async () => {
  const overview = (workers: unknown[]): typeof globalThis.fetch => async () => new Response(JSON.stringify({ workers }));
  expect(await workerOffersSummaries({ base: "http://owner", fetch: overview([{ types: ["echo@1", SUMMARY_JOB] }]) })).toBe(true);
  expect(await workerOffersSummaries({ base: "http://owner", fetch: overview([{ types: ["echo@1"] }]) })).toBe(false);
  expect(await workerOffersSummaries({ base: "http://owner", fetch: async () => { throw new Error("ECONNREFUSED"); } })).toBe(false);
});
