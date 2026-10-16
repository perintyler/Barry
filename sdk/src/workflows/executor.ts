import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { encode, limits, outcomeSchema, type Activity, type ActivityTask, type Outcome } from "./types.js";
import { verifyArtifact, type WorkflowArtifact } from "./artifacts.js";
import type { Proposal, ReplaySnapshot } from "./evaluator.js";

import { CgroupContainment } from "./containment/cgroups.js";
import { z } from "zod";
import type { Json } from "./types.js";
import type { Writable } from "node:stream";
import type { WorkArtifactStore } from "./work-artifacts.js";
import { hostEnvironment } from "../services/host-env.js";
import { assertProcessProgramScope, assertProcessProgramDirectory, assertProcessProgramRuntime, assertProcessProgramBundle } from "./work-process-program.js";
import { materializeProcessBundle } from "./work-process-bundle.js";
import type { WorkLog, WorkProcessProgram, WorkProcessCommand, WorkCommandReport } from "./work-contracts.js";
import { WorkflowError } from "./errors.js";
import { boundToNodeFlags } from "./job-launcher.js";
import { guardianDescendantsAbsent, type EscapedDescendantIdentity } from "./process-group-guardian.js";

export interface ProcessExecutionEvidence {
  command?: { code: number | null; signal: string | null; spawn_failed: boolean };
  pid: number | null;
  application_started: boolean;
  ceased: boolean;
  output: Buffer;
  logs?: WorkLog;
  fault?: string;
}
export interface ProcessExecutionObserver {
  beforeInput(pid: number): Promise<void>;
  closed(evidence: ProcessExecutionEvidence): void;
}

export class ExecutionFault extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface ReplayExecutor { evaluate(artifact: WorkflowArtifact, snapshot: ReplaySnapshot): Promise<Proposal>; close(): Promise<void> }
export class ProcessExecutor implements ReplayExecutor {
  private readonly running = new Set<{ kill: () => void; closed: Promise<void> }>();
  private stopped = false;
  private readonly retainedProgramDirectories = new Set<string>();
  private readonly directory: string;
  private readonly bootstrap: string;
  private readonly programBootstrap: string;
  private readonly containment?: CgroupContainment;
  constructor(private readonly options: { wallMs?: number; heapMiB?: number; maxChildren?: number; profile?: "portable" | "hardened"; diagnostic?: (message: string) => void; tempRoot?: string; artifacts?: WorkArtifactStore; installation?: string; resolveProcessSecrets?: (start: NonNullable<ActivityTask["work"]>) => Promise<Record<string, string>> } = {}) {
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
    const { buildSync } = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");
    const bundle = buildSync({ entryPoints: [fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./executor-child.ts" : "./executor-child.js", import.meta.url))], bundle: true, platform: "node", format: "esm", target: "node26", write: false });
    this.directory = mkdtempSync(join(options.tempRoot ?? tmpdir(), "workflow-bootstrap-"));
    this.bootstrap = join(this.directory, "executor.mjs");
    writeFileSync(this.bootstrap, bundle.outputFiles[0].contents, { mode: 0o600 });
    this.programBootstrap = join(this.directory, "program.mjs");
    if (options.artifacts && options.installation) {
      const program = buildSync({ entryPoints: [fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./work-program-child.ts" : "./work-program-child.js", import.meta.url))], bundle: true, platform: "node", format: "esm", target: "node26", write: false });
      writeFileSync(this.programBootstrap, program.outputFiles[0].contents, { mode: 0o600 });
    }
  }
  private execute(artifact: WorkflowArtifact, body: object, timeoutMs: number, signal?: AbortSignal, observer?: ProcessExecutionObserver,
    nodeJob?: { flags: string[]; output: "json" | "none" }, processProgram?: { declaration: WorkProcessProgram; runtime: Buffer; bundle?: Buffer; environment: Record<string, string>; command?: string; commandTimeoutMs?: number }): Promise<Record<string, unknown>> {
    if (this.stopped || signal?.aborted) return Promise.reject(new ExecutionFault("ExecutionCancelled", "executor stopped"));
    if ((nodeJob || processProgram) && !observer) return Promise.reject(new ExecutionFault("SupervisionUnsupported", "Node jobs require a live process observer."));
    if (this.running.size >= (this.options.maxChildren ?? 4)) return Promise.reject(new ExecutionFault("ExecutorCapacity", "executor capacity exhausted"));
    artifact = { ...artifact, path: realpathSync(artifact.path) };
    const task = "task" in body ? body.task as ActivityTask : undefined;
    const source = processProgram ? processProgram.declaration.argv.some(value => typeof value !== "string") ? this.options.artifacts!.verify(task!.work!.source) : Buffer.alloc(0) : "validation" in body ? Buffer.alloc(0) : verifyArtifact(artifact);
    const rawOutput = processProgram?.declaration.output ?? nodeJob?.output;
    const raw = Boolean(nodeJob || processProgram);
    const request = raw ? encode(task!.input) : encode({ artifact, ...body }, limits.replay + limits.record);
    const programDirectory = processProgram ? mkdtempSync(join(this.directory, "program-")) : undefined;
    if (programDirectory && processProgram) {
      try {
        if (!processProgram.declaration.runtime_path) writeFileSync(join(programDirectory, "runtime"), processProgram.runtime, { mode: 0o500, flag: "wx" });
        if (processProgram.bundle) materializeProcessBundle(processProgram.bundle, join(programDirectory, "source"));
      }
      catch (error) { rmSync(programDirectory, { recursive: true, force: true }); throw error; }
    }
    return new Promise((resolve, reject) => {
      const nodeArgs = processProgram ? [this.programBootstrap] : nodeJob ? [...nodeJob.flags, ...(this.options.heapMiB ? [`--max-old-space-size=${this.options.heapMiB}`] : []), "--input-type=module", "--eval",
        'const source=process.getBuiltinModule("node:fs").readFileSync(3);await import(`data:text/javascript;base64,${source.toString("base64")}`);'] :
        ["--permission", `--allow-fs-read=${realpathSync(this.bootstrap)}`, `--allow-fs-read=${realpathSync(artifact.path)}`, ...("task" in body && !observer ? ["--allow-net"] : []), `--max-old-space-size=${this.options.heapMiB ?? 128}`, realpathSync(this.bootstrap)];
      const invocation = this.containment ? this.containment.wrapSpawn(process.execPath, nodeArgs) : { command: process.execPath, args: nodeArgs };
      const child = spawn(invocation.command, invocation.args, {
        stdio: raw ? processProgram ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, ...(nodeJob ? { HOME: process.env.HOME } : {}), NODE_NO_WARNINGS: "1", ...(this.containment ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...(task ? { BARRY_JOB_KEY: task.idempotencyKey, BARRY_JOB_ATTEMPT: String(task.attempt) } : {}) }, detached: process.platform !== "win32",
      });
      const sourcePipe = raw ? child.stdio[3] as Writable : undefined;
      let control = "";
      let commandTimer: ReturnType<typeof setTimeout> | undefined, commandStarted = false;
      sourcePipe?.on("error", () => {});
      let output = Buffer.alloc(0), logs = 0, diagnostic = "", textOutput = "", fault: Error | undefined;
      let stdoutLog = Buffer.alloc(0), stderrLog = Buffer.alloc(0), stdoutBytes = 0;
      let applicationStarted = false, childClosed = false;
      let escalation: ReturnType<typeof setTimeout> | undefined, termSent = false;
      const signalGroup = (sig: NodeJS.Signals) => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig); else child.kill(sig); } catch { /* Already exited. */ } };
      const kill = () => {
        if (processProgram && applicationStarted) {
          if (!escalation) {
            // The guardian must enter shutdown mode before group TERM can make
            // its immediate child close. Its private stdin is never application
            // input. A silent guardian still gets bounded KILL escalation.
            escalation = setTimeout(() => signalGroup("SIGKILL"), 5000);
            child.stdin.write("stop\n");
          }
        } else signalGroup("SIGKILL");
      };
      const abort = () => { fault ??= new ExecutionFault("ExecutionCancelled", "execution cancelled"); kill(); };
      let close!: () => void;
      const tracked = { kill, closed: new Promise<void>(resolveClosed => { close = resolveClosed; }) };
      this.running.add(tracked);
      if (processProgram) child.stdio[4]?.on("data", (bytes: Buffer) => {
        if (control.length > 4096) return;
        control += bytes.toString("utf8");
        const messages = control.split("\n");
        if (messages.includes('{"timed_out":true}')) fault ??= new ExecutionFault("EvaluationBudgetExceeded", "guardian wall-time budget exceeded");
        if (!childClosed && escalation && !termSent && messages.includes('{"stopping":true}')) {
          termSent = true; clearTimeout(escalation);
          signalGroup("SIGTERM");
          escalation = setTimeout(() => signalGroup("SIGKILL"), 5000);
        }
        if (processProgram.command !== undefined && !commandStarted && messages.includes('{"started":true}')) {
          commandStarted = true;
          commandTimer = setTimeout(() => { fault ??= new ExecutionFault("EvaluationBudgetExceeded", "command wall-time budget exceeded"); kill(); }, processProgram.commandTimeoutMs!);
        }
      });
      // Materializing retained resources can consume time too. The stored
      // invocation deadline remains fixed across credentials, staging and checks.
      const remainingMs = task?.work ? Math.min(timeoutMs, task.work.deadline - Date.now()) : timeoutMs;
      const timer = setTimeout(() => { fault ??= new ExecutionFault("EvaluationBudgetExceeded", "execution wall-time budget exceeded"); kill(); }, Math.max(0, Math.min(remainingMs, 2_147_483_647)));
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", error => { fault = error; });
      child.stdin.on("error", () => { /* An early child exit is reported by close. */ });
      child.stdout.on("data", (chunk: Buffer) => {
        if (rawOutput === "none" || rawOutput === "text-tail") {
          stdoutBytes += chunk.length;
          stdoutLog = Buffer.concat([stdoutLog, chunk.subarray(0, Math.max(0, 16384 - stdoutLog.length))]);
        }
        if (processProgram && rawOutput === "text-tail") {
          if (processProgram.command !== undefined && stdoutBytes > 1048576) { fault = new ExecutionFault("CommandOutputBudgetExceeded", "command stdout exceeds 1 MiB"); kill(); }
          textOutput = (textOutput + chunk.toString("utf8")).slice(-65537);
          output = Buffer.from(textOutput); return;
        }
        if (output.length + chunk.length > (raw ? limits.payload : limits.record + 4)) { fault = raw ? new ExecutionFault("ResultTooLarge", `${task!.type} wrote more than ${limits.payload} bytes to stdout`) : new ExecutionFault("OutputBudgetExceeded", "executor output exceeds budget"); kill(); return; }
        output = Buffer.concat([output, chunk]);
        if (!raw && output.length >= 4 && output.readUInt32BE(0) > limits.record) { fault = new ExecutionFault("OutputBudgetExceeded", "executor frame exceeds budget"); kill(); }
      });
      child.stderr.on("data", (chunk: Buffer) => { logs += chunk.length; stderrLog = Buffer.concat([stderrLog, chunk]).subarray(-4096); if (processProgram?.command !== undefined && logs > 1048576) { fault = new ExecutionFault("CommandOutputBudgetExceeded", "command stderr exceeds 1 MiB"); kill(); } diagnostic = raw ? (diagnostic + chunk.toString()).slice(-4096) : (diagnostic + chunk.toString()).slice(0, 4096); if (!raw && logs > 65_536) { fault = new ExecutionFault("OutputBudgetExceeded", "executor logs exceed budget"); kill(); } });
      child.once("close", async code => {
        try {
          childClosed = true;
          clearTimeout(timer); clearTimeout(commandTimer); clearTimeout(escalation); signal?.removeEventListener("abort", abort);
          if (observer) {
            let escapedDescendants: EscapedDescendantIdentity[] = [];
            if (processProgram && control.length <= 4096) {
              const escapedSchema = z.strictObject({ escaped: z.array(z.strictObject({ pid: z.number().int().positive(), start: z.string().min(1) })) });
              for (const line of control.trim().split("\n")) {
                if (!line) continue;
                try {
                  const parsed = escapedSchema.safeParse(JSON.parse(line));
                  if (parsed.success) escapedDescendants = parsed.data.escaped;
                } catch { /* Ignore non-JSON or unrelated control lines. */ }
              }
            }
            const checkCeased = () => {
              if (!child.pid) return true;
              if (process.platform === "win32") return false;
              if (processProgram) return guardianDescendantsAbsent(child.pid, undefined, escapedDescendants);
              try { process.kill(-child.pid, 0); return false; }
              catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
            };
            let ceased = checkCeased();
            // Signals belong only to the live child/guardian. After close, observe
            // cessation briefly without ever signalling a potentially recycled PID.
            const maxAttempts = processProgram ? 5 : 100;
            const delayMs = processProgram ? 50 : 10;
            for (let attempt = 0; !ceased && (escalation || processProgram) && attempt < maxAttempts; attempt++) {
              await new Promise(done => setTimeout(done, delayMs));
              ceased = checkCeased();
            }
            if (programDirectory) {
              if (ceased) {
                try { rmSync(programDirectory, { recursive: true, force: true }); }
                catch { this.retainedProgramDirectories.add(programDirectory); this.options.diagnostic?.("Process program temporary cleanup is deferred."); }
              } else this.retainedProgramDirectories.add(programDirectory);
            }
            let command: ProcessExecutionEvidence["command"];
            if (processProgram?.command !== undefined && control.length <= 4096) {
              const commandSchema = z.strictObject({ code: z.number().int().nullable(), signal: z.string().nullable(), spawn_failed: z.boolean() });
              for (const line of control.trim().split("\n").reverse()) {
                if (!line) continue;
                try {
                  const parsed = commandSchema.safeParse(JSON.parse(line));
                  if (parsed.success) { command = parsed.data; break; }
                } catch { /* Ignore non-command control lines. */ }
              }
            }
            try { observer.closed({ pid: child.pid ?? null, application_started: applicationStarted, ceased, ...(command ? { command } : {}),
              output: !raw && output.length >= 4 && output.readUInt32BE(0) === output.length - 4 ? output.subarray(4) : output,
              logs: { version: 1, stdout: stdoutLog.toString("utf8"), stderr: stderrLog.toString("utf8"),
                stdout_bytes: stdoutBytes, stderr_bytes: logs, stdout_truncated: stdoutBytes > stdoutLog.length, stderr_truncated: logs > stderrLog.length },
              fault: fault instanceof ExecutionFault ? fault.code : fault ? "ProcessFailure" : undefined }); }
            catch (error) { reject(error); return; }
          }
          if (fault) { reject(fault); return; }
          if (raw) {
            if (code !== 0) {
              const lines = diagnostic.split("\n").map(line => line.trim()).filter(Boolean);
              reject(new ExecutionFault("JobProcessFailed", `${task!.type} exited ${code}: ${lines.find(line => /\b(?:Error|ERR_[A-Z_]+)\b/.test(line)) ?? lines.at(-1) ?? "no output"}`)); return;
            }
            try {
              const text = rawOutput === "none" ? "" : new TextDecoder("utf-8", { fatal: rawOutput === "json" }).decode(output).trim();
              if (processProgram && rawOutput === "json" && text.length > 65536) throw new Error("output character limit");
              const value = rawOutput === "none" ? null : rawOutput === "text-tail" ? text ? text.slice(-4096) : null : JSON.parse(text);
              encode(value); resolve({ outcome: { ok: true, value } });
            } catch { reject(new ExecutionFault("InvalidOutput", "Job stdout is not bounded finite JSON.")); }
            return;
          }
          if (code !== 0 || output.length < 4 || output.readUInt32BE(0) !== output.length - 4) { this.options.diagnostic?.(diagnostic); reject(new ExecutionFault("EvaluationUnavailable", "executor exited without a valid result")); return; }
          try {
            const result = JSON.parse(output.subarray(4).toString("utf8")) as Record<string, unknown>;
            if (result.error) throw new ExecutionFault("EvaluationUnavailable", String(result.error));
            resolve(result);
          } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        } finally { this.running.delete(tracked); close(); }
      });
      if (observer) {
        void (async () => {
          try {
            if (!child.pid) throw new ExecutionFault("ProcessFailure", "process did not obtain a handle");
            await observer.beforeInput(child.pid);
            if (childClosed || fault || signal?.aborted) return;
            applicationStarted = true;
            sourcePipe?.end(processProgram ? JSON.stringify({ deadline: task!.work!.deadline, directory: programDirectory, program: processProgram.declaration, source: source.toString("base64"), environment: processProgram.environment, input: request, ...(processProgram.command === undefined ? {} : { command: processProgram.command, commandTimeoutMs: processProgram.commandTimeoutMs }) }) : source);
            if (!processProgram) child.stdin.end(request);
          } catch (error) { if (!childClosed) { fault = error instanceof Error ? error : new Error(String(error)); kill(); } }
        })();
      } else child.stdin.end(request);
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
  /** Trusted portable Node supervision; hardened scopes need their own scope stop proof. */
  async supervisedActivity(artifact: WorkflowArtifact, task: ActivityTask, signal: AbortSignal, observer: ProcessExecutionObserver, command?: WorkProcessCommand): Promise<Outcome> {
    if (this.options.profile === "hardened" || process.platform === "win32")
      throw new ExecutionFault("SupervisionUnsupported", "this adapter requires portable Unix process-group supervision");
    const original = task.work?.process_program;
    const program = original && command ? { ...original, runtime: command.runtime, runtime_path: command.runtime_path, cwd: command.cwd, argv: [], output: "text-tail" as const } : original;
    if (program) {
      if (!this.options.artifacts || this.options.installation !== program.installation || program.activity_type !== task.type || program.source_digest !== artifact.digest)
        throw new ExecutionFault("UnsupportedProcessProgram", "Process program requires its retained source, runtime and local workspace.");
      try { assertProcessProgramScope(program); assertProcessProgramDirectory(program); assertProcessProgramRuntime(program); }
      catch (error) { throw error instanceof WorkflowError ? new ExecutionFault(error.code, error.message) : error; }
      let secrets: Record<string, string> = {};
      if (program.secret_names.length) {
        try {
          if (!this.options.resolveProcessSecrets) throw new Error("no resolver");
          secrets = await this.options.resolveProcessSecrets(task.work!);
          if (Object.keys(secrets).some(name => !program.secret_names.includes(name)) || program.secret_names.some(name => !secrets[name] || secrets[name].includes("\0")) || JSON.stringify(secrets).length > 65536) throw new Error("unavailable secrets");
        } catch { throw new ExecutionFault("ProcessCredentialsUnavailable", "Declared process credentials are unavailable from the retained owner."); }
      }
      const environment = { ...hostEnvironment(), ...program.env, ...secrets, BARRY_ACTION_INPUTS: encode(task.input),
        BARRY_JOB_KEY: task.idempotencyKey, BARRY_JOB_ATTEMPT: String(task.attempt),
        ...(task.work!.compatibility_action_id ? { BARRY_ACTION_RUN_ID: task.work!.compatibility_action_id } : {}) };
      const bundle = program.bundle ? this.options.artifacts.verify(program.bundle.source) : undefined;
      if (bundle) assertProcessProgramBundle(program, bundle);
      const result = await this.execute(artifact, { task }, Math.min(task.timeoutMs, Math.max(0, task.work!.deadline - Date.now())), signal, observer, undefined,
        { declaration: program, runtime: this.options.artifacts.verify(program.runtime), ...(bundle ? { bundle } : {}), environment, ...(command ? { command: command.command ?? ":", commandTimeoutMs: command.timeout_ms } : {}) });
      return outcomeSchema.parse(result.outcome);
    }
    const job = task.work?.node_job;
    let nodeJob: { flags: string[]; output: "json" | "none" } | undefined;
    if (job) {
      const permissions = boundToNodeFlags(job.scope.bound);
      if (job.activity_type !== task.type || job.source_digest !== artifact.digest || !job.scope.bound?.files?.allow || job.scope.bound.files.allow.length !== 0 || "refused" in permissions || permissions.flags.some(flag => !process.allowedNodeEnvironmentFlags.has(flag)))
        throw new ExecutionFault("UnsupportedNodeJob", "Node job requires its exact installed source and enforceable no-files scope.");
      nodeJob = { flags: permissions.flags, output: job.output };
    }
    const result = await this.execute(artifact, { task }, task.timeoutMs, signal, observer, nodeJob);
    return outcomeSchema.parse(result.outcome);
  }
  async supervisedCommand(artifact: WorkflowArtifact, task: ActivityTask, command: WorkProcessCommand, signal: AbortSignal, observer: ProcessExecutionObserver): Promise<WorkCommandReport> {
    const failures = command.files_exist.filter(path => !existsSync(isAbsolute(path) ? path : resolve(command.cwd.path, path))).map(path => Buffer.from(`expected file not found: ${path}`).subarray(0, 500).toString("utf8"));
    let evidence: ProcessExecutionEvidence | undefined, error: unknown;
    try { await this.supervisedActivity(artifact, task, signal,
      { beforeInput: observer.beforeInput, closed: value => { evidence = value; observer.closed(value); } }, command); }
    catch (caught) { error = caught; }
    if (evidence && !evidence.ceased) throw new WorkflowError("PhysicalSettlementUnknown", "Command process group cessation is not proven.", 409);
    if (error && evidence?.command && !(error instanceof ExecutionFault && ["JobProcessFailed", "EvaluationBudgetExceeded", "CommandOutputBudgetExceeded", "ExecutionCancelled"].includes(error.code))) throw error;
    const timedOut = evidence?.fault === "EvaluationBudgetExceeded", outputLimit = evidence?.fault === "CommandOutputBudgetExceeded";
    if (evidence?.application_started && !evidence.command && !timedOut && !outputLimit && !signal.aborted)
      throw new WorkflowError("CommandVerdictUnknown", "The command guardian did not retain an exit verdict.", 409);
    const unknown = timedOut || outputLimit || !evidence?.application_started || !evidence?.command || evidence.command.spawn_failed;
    const commandPassed = !unknown && evidence?.command?.code === 0 && !evidence.command.signal;
    const passed = commandPassed && failures.length === 0;
    const detail = (timedOut ? "command timed out" : outputLimit ? "command output exceeded 1 MiB" : unknown ? error instanceof Error ? error.message : "command could not run to a verdict" : passed ? "" : commandPassed ? failures.join("; ") :
      evidence?.logs?.stderr.trim() || evidence?.output.toString("utf8").trim() || (`command exited ${evidence?.command?.code ?? evidence?.command?.signal ?? "without a verdict"}`)).slice(-2000);
    const commandFailure = command.command && !commandPassed ? Buffer.from(`check command failed: ${detail}`).subarray(0, 500).toString("utf8") : null;
    const limit = commandFailure ? 99 : 100;
    const retained = failures.length > limit ? [...failures.slice(0, limit - 1), `${failures.length - limit + 1} additional file checks failed.`] : failures;
    return { passed, unknown, detail, failures: [...retained, ...(commandFailure ? [commandFailure] : [])] };
  }
  async supervisedValidation(artifact: WorkflowArtifact, value: Json, schema: Record<string, Json>, timeoutMs: number, signal: AbortSignal, observer: ProcessExecutionObserver) {
    if (this.options.profile === "hardened" || process.platform === "win32")
      throw new ExecutionFault("SupervisionUnsupported", "this adapter requires portable Unix process-group supervision");
    const result = await this.execute(artifact, { validation: { schema, value } }, timeoutMs, signal, observer);
    return z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), errors: z.array(z.string().max(2000)).min(1).max(100) })]).parse(result.validation);
  }
  async close(): Promise<void> {
    this.stopped = true;
    const pending = [...this.running]; pending.forEach(child => child.kill()); await Promise.all(pending.map(child => child.closed));
    if (this.retainedProgramDirectories.size === 0) rmSync(this.directory, { recursive: true, force: true });
    // Unknown descendants may still use their private source/runtime paths.
    // Retirement must follow actual cessation or audited host recovery.
  }
}
