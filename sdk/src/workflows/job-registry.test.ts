import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installedJobs, unmetRequirement, workerLabels, type RemotableJobSource } from "./job-registry.js";
import { jobActivity } from "./job-activity.js";
import type { ActivityContext } from "./types.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function bag(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "barry-remote-jobs-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}
const SUMMARIZE = `let raw = ""; process.stdin.on("data", d => { raw += d; }); process.stdin.on("end", () => { const input = JSON.parse(raw); process.stdout.write(JSON.stringify({ summary: input.text.slice(0, 5), key: process.env.BARRY_JOB_KEY })); });`;
const SNOOP = `const fs = process.getBuiltinModule("node:fs"); fs.readFileSync("/etc/hosts"); process.stdout.write("{}");`;
const noFiles = async (name: string) => name === "no-files" ? { files: { allowOnly: [] } } : name === "home" ? { files: { allowOnly: ["~/notes"] } } : undefined;
const job = (dir: string, overrides: Partial<RemotableJobSource> = {}): RemotableJobSource => ({ name: "summarize", dir, version: "1", bounds: ["no-files"], runs: { using: "node", main: "summarize.mjs" }, requires: { bins: [], labels: { model: "local" } }, inputSchema: { type: "object" }, outputSchema: { type: "object" }, timeout: 30, ...overrides });
const task = (signal = new AbortController().signal): ActivityContext => ({ owner: "o", runId: "r", activityId: "a", idempotencyKey: "run/step-1", type: "notes:summarize@1", input: null, attempt: 2, token: "t", deadline: Date.now() + 60_000, timeoutMs: 60_000, heartbeatMs: 1000, signal });

it("lists only versioned node jobs bounded to no files, with their contract and the digest of their one file", async () => {
  const dir = bag({ "summarize.mjs": SUMMARIZE, "reads.ts": "import { readFileSync } from 'node:fs';" });
  const { jobs, skipped } = await installedJobs([{ name: "notes", jobs: [
    job(dir),
    job(dir, { name: "unversioned", version: undefined }),
    job(dir, { name: "unbounded", bounds: undefined }),
    job(dir, { name: "homebound", bounds: ["home"] }),
    job(dir, { name: "secretive", runs: { using: "node", main: "summarize.mjs", secrets: ["TOKEN"] } }),
    job(dir, { name: "shell", runs: { using: "process" } }),
    job(dir, { name: "imports", runs: { using: "node", main: "reads.ts" } }),
  ] }], noFiles);
  expect(jobs.map(entry => entry.type)).toEqual(["notes:summarize@1"]);
  expect(jobs[0].contract).toMatchObject({ type: "notes:summarize@1", timeoutMs: 30_000, outputSchema: { type: "object" } });
  expect(jobs[0].contract.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(skipped.map(entry => entry.type)).toEqual(["notes:unbounded@1", "notes:homebound@1", "notes:secretive@1", "notes:shell@1", "notes:imports@1"]);
});

it("runs a job under its bound: input on stdin, output on stdout, the step key in BARRY_JOB_KEY, and no file access", async () => {
  const dir = bag({ "summarize.mjs": SUMMARIZE, "snoop.mjs": SNOOP });
  const { jobs } = await installedJobs([{ name: "notes", jobs: [job(dir), job(dir, { name: "snoop", runs: { using: "node", main: "snoop.mjs" } })] }], noFiles);
  const [summarize, snoop] = jobs;
  expect(await jobActivity(summarize)({ text: "a long note" }, task())).toEqual({ summary: "a lon", key: "run/step-1" });
  await expect(jobActivity(snoop)({}, task())).rejects.toThrow(/exited 1: .*(Access to this API has been restricted|ERR_ACCESS_DENIED)/);
});

it("advertises a job only where its bins and labels are, with labels from BARRY_WORKFLOW_LABELS", async () => {
  const dir = bag({ "summarize.mjs": SUMMARIZE });
  const { jobs: [summarize] } = await installedJobs([{ name: "notes", jobs: [job(dir)] }], noFiles);
  const labels = workerLabels("model=local, gpu=metal", { os: "darwin" });
  expect(labels).toEqual({ os: "darwin", model: "local", gpu: "metal" });
  expect(unmetRequirement(summarize, labels)).toBeUndefined();
  expect(unmetRequirement(summarize, { os: "darwin" })).toMatch(/model=local/);
  expect(unmetRequirement({ ...summarize, requires: { bins: ["definitely-not-a-binary"], labels: {} } }, labels)).toMatch(/definitely-not-a-binary/);
  expect(() => workerLabels("model", {})).toThrow(/key=value/);
});
