import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { WorkflowOwner, ProcessExecutor, inspectArtifact, WorkflowError, type JobContract } from "@barry-rocks/sdk/internal/workflows";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const jobArtifact = fileURLToPath(new URL("./job-artifact.mjs", import.meta.url));
const digest = createHash("sha256").update("notes summarize bundle").digest("hex");
const summarize: JobContract = {
  type: "notes:summarize@1", digest, timeoutMs: 5000,
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  outputSchema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
};
function owner(path: string, jobs: JobContract[] = [summarize]) {
  const executor = new ProcessExecutor();
  const workflows = new WorkflowOwner({ id: "owner", path, artifacts: [inspectArtifact(jobArtifact, "job", "1")], executor, jobs });
  cleanup.push(async () => { await workflows.drain(); workflows.close(); await executor.close(); });
  return workflows;
}
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "workflow-job-runs-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "workflows.db");
}
async function claimed(workflows: WorkflowOwner, run: string) {
  workflows.advertise("worker", { types: [summarize.type], artifacts: { [summarize.type]: digest }, capacity: 2 });
  for (let attempt = 0; attempt < 100; attempt++) {
    await workflows.pump();
    const task = workflows.claim("worker");
    if (task) { expect(task.runId).toBe(run); return task; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${run} was never offered`);
}
async function settled(workflows: WorkflowOwner, run: string) {
  for (let attempt = 0; attempt < 100 && workflows.get(run).status === "running"; attempt++) { await workflows.pump(); await new Promise(resolve => setTimeout(resolve, 20)); }
  return workflows.get(run);
}

it("refuses a job@1 start whose input breaks the job's contract, or names no registered job, before a run exists", () => {
  const workflows = owner(scratch());
  expect(() => workflows.start({ id: "bad", type: "job", version: "1", input: { job: summarize.type, input: { text: 3 } } })).toThrow(WorkflowError);
  expect(() => workflows.start({ id: "bad", type: "job", version: "1", input: { job: summarize.type, input: { text: 3 } } })).toThrow(/InvalidInput|does not match/);
  expect(() => workflows.start({ id: "unknown", type: "job", version: "1", input: { job: "notes:missing@1", input: {} } })).toThrow(/no worker of this owner has registered job/);
  expect(() => workflows.get("bad")).toThrow();
  expect(() => workflows.get("unknown")).toThrow();
});

it("runs the job as one step, with the contract's attempt timeout, and fails it on output that breaks the contract", async () => {
  const workflows = owner(scratch());
  workflows.start({ id: "wrong", type: "job", version: "1", input: { job: summarize.type, input: { text: "a long note" } } });
  const task = await claimed(workflows, "wrong");
  expect(task.type).toBe(summarize.type);
  expect(task.input).toEqual({ text: "a long note" });
  expect(task.timeoutMs).toBeLessThanOrEqual(5000);
  expect(workflows.completeStatus("worker", task.token, { ok: true, value: { title: "not a summary" } })).toBe("accepted");
  const failed = await settled(workflows, "wrong");
  expect(failed.status).toBe("failed");
  expect(JSON.stringify(failed.outcome)).toContain("output does not match notes:summarize@1");
  expect(workflows.history("wrong").some(event => event.type === "JobOutputRejected")).toBe(true);

  workflows.start({ id: "right", type: "job", version: "1", input: { job: summarize.type, input: { text: "a long note" } } });
  const next = await claimed(workflows, "right");
  workflows.completeStatus("worker", next.token, { ok: true, value: { summary: "short" } });
  const done = await settled(workflows, "right");
  expect(done.status).toBe("completed");
  expect(done.outcome).toEqual({ ok: true, value: { summary: "short" } });
});

it("keeps a job's contract pinned across restarts and refuses changing it in place", async () => {
  const path = scratch();
  const first = owner(path);
  await first.drain(); first.close();
  cleanup.pop();
  expect(() => owner(path, [{ ...summarize, outputSchema: { type: "object" } }])).toThrow(/changed its contract in place/);
  const later = owner(path, []);
  expect(later.jobContract(summarize.type)?.inputSchema).toEqual(summarize.inputSchema);
  expect(() => later.start({ id: "still-checked", type: "job", version: "1", input: { job: summarize.type, input: {} } })).toThrow(/does not match/);
});
