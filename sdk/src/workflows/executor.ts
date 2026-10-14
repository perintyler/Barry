import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";
import { encode, limits, outcomeSchema, type Activity, type ActivityTask, type Outcome } from "./types.js";
import { verifyArtifact, type WorkflowArtifact } from "./artifacts.js";
import type { Proposal, ReplaySnapshot } from "./evaluator.js";

import { CgroupContainment } from "./containment/cgroups.js";

export class ExecutionFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface ReplayExecutor { evaluate(artifact: WorkflowArtifact, snapshot: ReplaySnapshot): Promise<Proposal>; close(): Promise<void> }
export class ProcessExecutor implements ReplayExecutor {
  private readonly running = new Set<{ kill: () => void; closed: Promise<void> }>();
  private stopped = false;
  private readonly directory: string;
  private readonly bootstrap: string;
  private readonly containment?: CgroupContainment;
  constructor(private readonly options: { wallMs?: number; heapMiB?: number; maxChildren?: number; profile?: "portable" | "hardened"; diagnostic?: (message: string) => void; tempRoot?: string } = {}) {
    if (options.profile === "hardened") {
      if (process.platform !== "linux") {
        throw new Error("hardened OS containment adapter requires Linux cgroups v2; portable profile must be explicit on non-Linux");
      }
      this.containment = new CgroupContainment({
        memoryMaxBytes: (options.heapMiB ?? 128) * 1024 * 1024 * 1.5,
        pidsMax: 32,
        cpuQuotaPercent: 100,
      });
    }
    if (this.containment && !this.containment.isAvailable) throw new Error("hardened profile requires cgroups v2 containment");
    if (options.tempRoot && !isAbsolute(options.tempRoot)) throw new Error("executor temporary root must be absolute");
    // Bundle only the trusted bootstrap, never application code, before accepting work.
    // Children need no loader, package tree, owner store, credentials or write access.
    const bundle = buildSync({ entryPoints: [fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./executor-child.ts" : "./executor-child.js", import.meta.url))], bundle: true, platform: "node", format: "esm", target: "node26", write: false });
    this.directory = mkdtempSync(join(options.tempRoot ?? tmpdir(), "workflow-bootstrap-"));
    this.bootstrap = join(this.directory, "executor.mjs");
    writeFileSync(this.bootstrap, bundle.outputFiles[0].contents, { mode: 0o600 });
  }
  private execute(artifact: WorkflowArtifact, body: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.stopped || signal?.aborted) return Promise.reject(new ExecutionFault("ExecutionCancelled", "executor stopped"));
    if (this.running.size >= (this.options.maxChildren ?? 4)) return Promise.reject(new ExecutionFault("ExecutorCapacity", "executor capacity exhausted"));
    artifact = { ...artifact, path: realpathSync(artifact.path) };
    verifyArtifact(artifact);
    const request = encode({ artifact, ...body }, limits.replay + limits.record);
    return new Promise((resolve, reject) => {
      const nodeArgs = ["--permission", `--allow-fs-read=${realpathSync(this.bootstrap)}`, `--allow-fs-read=${realpathSync(artifact.path)}`, ...("task" in body ? ["--allow-net"] : []), `--max-old-space-size=${this.options.heapMiB ?? 128}`, realpathSync(this.bootstrap)];
      const invocation = this.containment ? this.containment.wrapSpawn(process.execPath, nodeArgs) : { command: process.execPath, args: nodeArgs };
      const task = "task" in body ? body.task as ActivityTask : undefined;
      const child = spawn(invocation.command, invocation.args, {
        stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1", ...(this.containment ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(task ? { BARRY_JOB_KEY: task.idempotencyKey, BARRY_JOB_ATTEMPT: String(task.attempt) } : {}) }, detached: process.platform !== "win32",
      });
      let output = Buffer.alloc(0), logs = 0, diagnostic = "", fault: Error | undefined;
      const kill = () => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ } };
      const abort = () => { fault = new ExecutionFault("ExecutionCancelled", "execution cancelled"); kill(); };
      let close!: () => void;
      const tracked = { kill, closed: new Promise<void>(resolveClosed => { close = resolveClosed; }) };
      this.running.add(tracked);
      const timer = setTimeout(() => { fault = new ExecutionFault("EvaluationBudgetExceeded", "execution wall-time budget exceeded"); kill(); }, Math.min(timeoutMs, 2_147_483_647));
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", error => { fault = error; });
      child.stdin.on("error", () => { /* An early child exit is reported by close. */ });
      child.stdout.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > limits.record + 4) { fault = new ExecutionFault("OutputBudgetExceeded", "executor output exceeds budget"); kill(); return; }
        output = Buffer.concat([output, chunk]);
        if (output.length >= 4 && output.readUInt32BE(0) > limits.record) { fault = new ExecutionFault("OutputBudgetExceeded", "executor frame exceeds budget"); kill(); }
      });
      child.stderr.on("data", (chunk: Buffer) => { logs += chunk.length; diagnostic = (diagnostic + chunk.toString()).slice(0, 4096); if (logs > 65_536) { fault = new ExecutionFault("OutputBudgetExceeded", "executor logs exceed budget"); kill(); } });
      child.once("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.running.delete(tracked); close();
        if (fault) { reject(fault); return; }
        if (code !== 0 || output.length < 4 || output.readUInt32BE(0) !== output.length - 4) { this.options.diagnostic?.(diagnostic); reject(new ExecutionFault("EvaluationUnavailable", "executor exited without a valid result")); return; }
        try {
          const result = JSON.parse(output.subarray(4).toString("utf8")) as Record<string, unknown>;
          if (result.error) throw new ExecutionFault("EvaluationUnavailable", String(result.error));
          resolve(result);
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stdin.end(request);
    });
  }
  async evaluate(artifact: WorkflowArtifact, snapshot: ReplaySnapshot): Promise<Proposal> {
    return (await this.execute(artifact, { snapshot }, this.options.wallMs ?? 2000)).proposal as Proposal;
  }
  activity(artifact: WorkflowArtifact): Activity {
    return async (_input, context) => {
      const { signal, ...task } = context;
      const result = await this.execute(artifact, { task: task satisfies ActivityTask }, context.timeoutMs, signal);
      const outcome: Outcome = outcomeSchema.parse(result.outcome);
      if (outcome.ok) return outcome.value;
      throw Object.assign(new Error(outcome.error.message), { activityOutcome: outcome });
    };
  }
  async close(): Promise<void> {
    this.stopped = true;
    const pending = [...this.running]; pending.forEach(child => child.kill()); await Promise.all(pending.map(child => child.closed));
    rmSync(this.directory, { recursive: true, force: true });
  }
}
