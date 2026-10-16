import { randomUUID } from "node:crypto";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { artifactAbi, verifyArtifact, type WorkflowArtifact } from "./artifacts.js";
import { ExecutorJournal, workReceiptDigest } from "./executor-journal.js";
import { ProcessExecutor, ExecutionFault, type ProcessExecutionEvidence, type ProcessExecutionObserver } from "./executor.js";
import { WorkArtifactStore, type WorkArtifactRef } from "./work-artifacts.js";
import { executionBindingSchema, executorStartSchema, logicalStageEffectKey, workLogSchema, workCommandReportSchema, type WorkCommandReport, type WorkProcessCommand, type workReceiptSchema, type executorObservationSchema } from "./work-contracts.js";
import { encode, encodeEnvelope, limits, outcomeSchema, type Json, type ActivityTask, type Outcome } from "./types.js";
import { assertProcessProgramDirectory } from "./work-process-program.js";
import { WorkflowError } from "./errors.js";
import type { z } from "zod";
import { processBootIdentity } from "./process-boot-identity.js";
export { processBootIdentity } from "./process-boot-identity.js";

type Start = z.infer<typeof executorStartSchema>;
type Binding = z.infer<typeof executionBindingSchema>;
type Receipt = z.infer<typeof workReceiptSchema>;
type Observation = z.infer<typeof executorObservationSchema>;
type Stage = "preflight" | "execution" | "validation" | "postcondition";
interface Live { binding: Binding; start: Start; abort: AbortController; done: Promise<void> }

/** Service-owned execution, independent of request lifetimes. Only a trusted worker
 * may supply launch permits and output identity; owner admission is a separate boundary.
 * Persisted PIDs are diagnostic evidence, never authority to signal or relaunch. */
export class WorkProcessSupervisor {
  readonly bootIdentity = processBootIdentity();
  private readonly live = new Map<string, Live>();
  private readonly pendingStarts = new Set<Promise<Observation | null>>();
  private stopped = false;
  constructor(private readonly options: {
    installation: string;
    journal: ExecutorJournal;
    artifacts: WorkArtifactStore;
    executor: ProcessExecutor;
    authorize: (start: Start) => Promise<Start | null>;
    outputIdentity: (start: Start) => string | null;
    onError?: (error: unknown) => void;
  }) {}
  start(task: ActivityTask): Promise<Observation> {
    const pending = this.startTask(task);
    this.pendingStarts.add(pending);
    return pending.finally(() => this.pendingStarts.delete(pending));
  }
  private async startTask(task: ActivityTask): Promise<Observation> {
    if (this.stopped) throw new WorkflowError("SupervisorStopped", "Supervisor is draining.", 503);
    const start = executorStartSchema.parse(JSON.parse(encodeEnvelope(task.work))), binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof Start]])));
    if (start.resources.executor !== "process" || start.resources.endpoint !== null || !start.validation)
      throw new WorkflowError("WorkExecutorUnsupported", "Process work requires an explicit retained validation declaration.", 409);
    if (task.type !== start.activity_type || task.owner !== start.owner || task.token !== start.attempt_id || task.runId !== start.workflow_id ||
      task.activityId !== start.activity_id || task.artifact !== start.source.digest || task.attempt !== start.execution_fence ||
      task.grantRevision !== start.grant_revision || boundFingerprint(task.input) !== boundFingerprint(start.inputs))
      throw new WorkflowError("WorkBindingConflict", "Task differs from its immutable launch permit.", 409);
    task = { ...task, work: start, input: start.inputs, idempotencyKey: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution") };
    const key = boundFingerprint(binding), existing = this.options.journal.inspect(binding);
    if (existing) {
      // Revalidate immutable redelivery, but do not consume a second launch permit.
      this.options.journal.start(start);
      if (existing.stage !== "intent" || existing.physical_state !== "not-started" || existing.cancel_requested || this.live.has(key)) return existing;
    }
    let authorized: boolean;
    try { authorized = await this.authorized(start); }
    catch (error) { if (this.stopped) return this.cancel(binding); throw error; }
    if (this.stopped) return this.cancel(binding);
    if (!authorized) throw new WorkflowError("WorkEffectForbidden", "Online launch authority is unavailable.", 403);
    // Another delivery may have committed while this authorization RPC waited.
    const latest = this.options.journal.inspect(binding);
    if (latest && (latest.stage !== "intent" || latest.physical_state !== "not-started" || latest.cancel_requested || this.live.has(key)))
      return this.options.journal.start(start);
    const artifact: WorkflowArtifact = { path: this.options.artifacts.path(start.source), digest: start.source.digest,
      abi: artifactAbi, type: task.type, version: "activity" };
    if (start.process_program) this.options.artifacts.verify(start.source); else verifyArtifact(artifact);
    this.options.journal.start(start);
    const abort = new AbortController(), live: Live = { binding, start, abort, done: Promise.resolve() };
    this.live.set(key, live);
    live.done = this.execute(task, start, binding, artifact, abort.signal).catch(error => this.options.onError?.(error))
      .finally(() => this.live.delete(key));
    return this.options.journal.inspect(binding)!;
  }
  /** Resume only an unclaimed declared validator after proven main cessation.
   * The original full permit, resource authority and deadline still apply. */
  resumeValidation(binding: Binding): Promise<Observation | null> {
    const pending = this.resumeValidationTask(executionBindingSchema.parse(binding));
    this.pendingStarts.add(pending);
    return pending.finally(() => this.pendingStarts.delete(pending));
  }
  private async resumeValidationTask(binding: Binding): Promise<Observation | null> {
    const journal = this.options.journal, observed = journal.inspect(binding), start = journal.retainedStart(binding);
    if (this.stopped || !observed || !start || this.owns(binding) || observed.receipt_ref || observed.cancel_requested ||
      observed.physical_state !== "ceased" || observed.effect_certainty !== "known" || start.resources.executor !== "process" || start.resources.endpoint !== null ||
      !start.activity_type || Date.now() >= binding.deadline) return null;
    const main = journal.stageReceipts(binding).find(stage => stage.stage === "execution");
    if (main && main.state !== "passed") return null;
    if (!main && !journal.stageReceipts(binding).some(stage => stage.stage === "preflight" && stage.state === "passed")) return null;
    if (main && !start.process_program?.commands?.postcondition && (start.validation?.mode !== "json-schema" || journal.stageReceipts(binding).some(stage => stage.stage === "validation"))) return null;
    const identity = start.output_identity === undefined ? this.options.outputIdentity(start) : start.output_identity;
    if (main?.result && main.result.owner_identity !== identity) throw new WorkflowError("WorkArtifactForbidden", "Retained output belongs to another identity.", 403);
    const value = main ? this.mainValue(main.result) : undefined;
    let authorized: boolean;
    try { authorized = await this.authorized(start); }
    catch (error) {
      if (this.stopped) { this.cancel(binding); this.recoverReceipt(binding); return journal.inspect(binding); }
      throw error;
    }
    if (this.stopped) { this.cancel(binding); this.recoverReceipt(binding); return journal.inspect(binding); }
    const current = journal.inspect(binding)!;
    if (current.cancel_requested || Date.now() >= binding.deadline) { this.recoverReceipt(binding); return journal.inspect(binding); }
    if (!authorized) return null;
    if (this.owns(binding) || current.receipt_ref || current.physical_state !== "ceased" || current.effect_certainty !== "known") return current;
    const artifact: WorkflowArtifact = { path: this.options.artifacts.path(start.source), digest: start.source.digest, abi: artifactAbi,
      type: start.activity_type, version: "activity" };
    if (start.process_program) this.options.artifacts.verify(start.source); else verifyArtifact(artifact);
    const key = boundFingerprint(binding), abort = new AbortController(), live: Live = { binding, start, abort, done: Promise.resolve() };
    this.live.set(key, live);
    const task: ActivityTask = { owner: start.owner, runId: start.workflow_id, activityId: start.activity_id, token: start.attempt_id, type: start.activity_type,
      input: start.inputs, work: start, artifact: start.source.digest, attempt: start.execution_fence, grantRevision: start.grant_revision, deadline: start.deadline,
      timeoutMs: Math.max(1, start.deadline - Date.now()), heartbeatMs: 1000, idempotencyKey: logicalStageEffectKey(start.owner, start.workflow_id, start.activity_id, "execution") };
    live.done = (main ? this.finishValidation(start, binding, artifact, abort.signal, main.result, { ok: true, value: value! }, undefined, false) : this.execute(task, start, binding, artifact, abort.signal))
      .catch(error => this.options.onError?.(error)).finally(() => this.live.delete(key));
    return journal.inspect(binding);
  }
  private mainValue(reference: WorkArtifactRef | null): Json {
    if (!reference || reference.purpose !== "output" || reference.media_type !== "application/json" || reference.bytes > limits.payload)
      throw new WorkflowError("InvalidOutput", "Retained output is not bounded application JSON.", 409);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.options.artifacts.verify(reference))) as Json;
    encode(value);
    return value;
  }
  inspect(binding: Binding): { observation: Observation | null; receipt: Receipt | null } {
    return { observation: this.options.journal.inspect(binding), receipt: this.options.journal.receipt(binding) };
  }
  owns(binding: Binding): boolean { return this.live.has(boundFingerprint(binding)); }
  /** An owned pipeline keeps its worker slot while a stopped stage waits for
   * fresh authority for the next stage. Physical broker settlement is separate. */
  occupiedCount(owner?: string): number {
    let count = this.options.journal.occupiedCount(owner);
    for (const live of this.live.values()) if ((!owner || live.binding.owner === owner) && ["ceased", "not-started"].includes(this.options.journal.inspect(live.binding)!.physical_state)) count++;
    return count;
  }
  leaseLost(owner: string): void {
    for (const run of this.live.values()) if (run.binding.owner === owner && run.start.effect_policy.class !== "pure") this.cancel(run.binding);
  }
  /** Metadata recovery never starts application or validation. Missing required
   * validation can fail after stop/deadline while retaining known output. */
  recoverReceipt(binding: Binding): Receipt | null {
    const old = this.options.journal.receipt(binding); if (old) return old;
    const observed = this.options.journal.inspect(binding), start = this.options.journal.retainedStart(binding);
    if (!observed || this.owns(binding) || observed.physical_state !== "ceased") return null;
    const stages = this.options.journal.stageReceipts(binding), main = stages.find(stage => stage.stage === "execution"),
      checked = stages.find(stage => stage.stage === "validation");
    if (!main) {
      if (start && stages.some(stage => stage.stage === "preflight") && (observed.effect_certainty === "uncertain" || observed.cancel_requested || Date.now() >= binding.deadline)) {
        this.beforeMainReceipt(binding); return this.options.journal.receipt(binding);
      }
      return null;
    }
    const missingValidation = main.state === "passed" && start?.validation?.mode === "json-schema" && !checked;
    const missingPostcondition = main.state === "passed" && Boolean(start?.process_program?.commands?.postcondition) &&
      (start?.validation?.mode !== "json-schema" || checked?.state === "passed") && !stages.some(stage => stage.stage === "postcondition");
    const skippedRequired = main.state === "passed" && start?.validation?.mode === "json-schema" && checked?.state === "skipped";
    let invalidOutput = false;
    if (missingValidation) {
      try { this.mainValue(main.result); } catch { invalidOutput = true; }
      if (!observed.cancel_requested && Date.now() < binding.deadline && !invalidOutput) return null;
    }
    if (missingPostcondition && !observed.cancel_requested && Date.now() < binding.deadline) return null;
    const validation: Receipt["validation"] = missingValidation || skippedRequired ? "failed" : !checked || checked.state === "skipped" ? "skipped" : checked.state === "passed" ? "passed" : checked.state === "failed" ? "failed" : "unknown";
    let failures: string[] | null = validation === "skipped" ? null : validation === "passed" ? [] :
      [invalidOutput ? "Retained output is not valid bounded finite JSON." : skippedRequired ? "Required validation was skipped without a passing verdict." : missingValidation ? "Required validation did not complete before stop or deadline." : "Recovered unsuccessful validation stage."];
    if (checked?.state === "failed" && checked.result) {
      try {
        const raw = this.mainValue(checked.result) as { validation?: { ok?: boolean; errors?: Json } };
        if (raw.validation?.ok === false && Array.isArray(raw.validation.errors) && raw.validation.errors.length > 0 && raw.validation.errors.length <= 100 &&
          raw.validation.errors.every(value => typeof value === "string" && value.length <= 2000)) failures = raw.validation.errors as string[];
      } catch { /* A retained stage verdict can prove failure without interpretable detail. */ }
    }
    const inBudget = stages.every(stage => stage.stage === "publication" || stage.state === "skipped" || stage.completed_at !== null && stage.completed_at <= binding.deadline);
    const uncertain = observed.effect_certainty === "uncertain" || validation === "unknown";
    let failure: Receipt["failure"];
    if (main.state === "failed" && main.result) {
      try {
        const retained = JSON.parse(this.options.artifacts.verify(main.result).toString("utf8")) as { outcome?: unknown };
        const reported = outcomeSchema.safeParse(retained.outcome);
        if (reported.success && !reported.data.ok) failure = { code: reported.data.error.code, retryable: reported.data.error.retryable };
      } catch { /* Missing or uninterpretable failure detail cannot authorize retry. */ }
    }
    const unsigned: Omit<Receipt, "receipt_digest"> = { ...binding, receipt_ref: this.options.journal.newReceiptRef(), revision: observed.revision + 1,
      committed_at: Date.now(), physical_state: observed.physical_state, effect_certainty: observed.effect_certainty,
      outcome: uncertain ? "uncertain" : observed.cancel_requested ? "cancelled" : (!inBudget || (missingValidation && Date.now() >= binding.deadline)) ? "timed-out" : main.state === "passed" && validation !== "failed" ? "complete" : "failed",
      stages, output: main.result, validation, validation_failures: failures, ...(start?.process_program?.commands ? { action_checks: this.actionChecks(binding) } : {}),
      summary: validation === "failed" ? failures?.[0] ?? "Recovered output failed validation." : "Recovered retained stage evidence without another execution.", ...(failure ? { failure } : {}) };
    return this.options.journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  }
  cancel(binding: Binding): Observation {
    const observation = this.options.journal.cancel(binding);
    const live = this.live.get(boundFingerprint(binding));
    live?.abort.abort();
    if (!live && observation.physical_state === "not-started" && !this.options.journal.receipt(binding)) {
      const unsigned: Omit<Receipt, "receipt_digest"> = { ...binding, receipt_ref: this.options.journal.newReceiptRef(),
        revision: observation.revision + 1, committed_at: Date.now(), physical_state: "not-started", effect_certainty: "not-started",
        outcome: "cancelled", stages: [], output: null, validation: "skipped", validation_failures: null, summary: "Cancelled before any stage launch." };
      this.options.journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
    }
    return observation;
  }
  async wait(binding: Binding): Promise<Receipt | null> {
    await this.live.get(boundFingerprint(binding))?.done;
    return this.options.journal.receipt(binding);
  }
  async close(): Promise<void> {
    this.stopped = true;
    const live = [...this.live.values()];
    for (const run of live) this.cancel(run.binding);
    await Promise.allSettled([...this.pendingStarts]);
    await Promise.all(live.map(run => run.done));
    await this.options.executor.close();
  }
  private async authorized(start: Start): Promise<boolean> {
    const permit = await this.options.authorize(executorStartSchema.parse(JSON.parse(encodeEnvelope(start))));
    return permit !== null && boundFingerprint(executorStartSchema.parse(permit)) === boundFingerprint(start);
  }
  private observer(start: Start, binding: Binding, stage: Stage, collect: (evidence: ProcessExecutionEvidence) => void): ProcessExecutionObserver {
    return {
      beforeInput: async pid => {
        const handle = { kind: "process" as const, installation: this.options.installation,
          boot_identity: this.bootIdentity, pid, start_identity: randomUUID() };
        this.options.journal.recordHandle(binding, stage, handle);
        if (!await this.authorized(start))
          throw new ExecutionFault("WorkEffectForbidden", "Online effect authority no longer permits application input");
        if (start.process_program) {
          try { assertProcessProgramDirectory(start.process_program); }
          catch { throw new ExecutionFault("WorkWorkspaceChanged", "The retained local working directory changed before input."); }
        }
        this.options.journal.assertStageInput(binding, stage, handle);
      },
      closed: evidence => {
        collect(evidence);
        if (start.capture_logs && evidence.logs && (evidence.logs.stdout_bytes || evidence.logs.stderr_bytes)) {
          const reference = this.options.artifacts.stage(Buffer.from(JSON.stringify(workLogSchema.parse(evidence.logs))), {
            purpose: "log", media_type: "application/json", owner_identity: start.output_identity === undefined ? this.options.outputIdentity(start) : start.output_identity });
          this.options.journal.retainStageOutput(binding, stage, reference, "log");
        }
      },
    };
  }
  private output(start: Start, binding: Binding, stage: Stage, bytes: Buffer): WorkArtifactRef {
    const reference = this.options.artifacts.stage(bytes, { purpose: "output", media_type: "application/json",
      owner_identity: start.output_identity === undefined ? this.options.outputIdentity(start) : start.output_identity });
    this.options.journal.retainStageOutput(binding, stage, reference);
    return reference;
  }
  private completeStage(binding: Binding, stage: Stage, started: number, state: "passed" | "failed" | "unknown", result: WorkArtifactRef | null): void {
    const logs = this.options.journal.retainedStageOutput(binding, stage, "log");
    this.options.journal.completeStage(binding, { stage, attempt_id: binding.attempt_id,
      effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, stage),
      state, started_at: started, completed_at: Date.now(), result,
      ...(logs ? { logs } : {}) }, "ceased");
  }
  private commandReport(reference: WorkArtifactRef | null): WorkCommandReport {
    try { return workCommandReportSchema.parse(this.mainValue(reference)); }
    catch { return { passed: false, unknown: true, detail: "Retained command verdict is unavailable or invalid.", failures: ["Command check did not retain a valid verdict."] }; }
  }
  private actionChecks(binding: Binding): Receipt["action_checks"] {
    const stages = this.options.journal.stageReceipts(binding), preflight = stages.find(stage => stage.stage === "preflight"), post = stages.find(stage => stage.stage === "postcondition");
    return preflight || post ? { ...(preflight ? { preflight: this.commandReport(preflight.result) } : {}), ...(post ? { postcondition: this.commandReport(post.result) } : {}) } : undefined;
  }
  private async command(task: ActivityTask, start: Start, binding: Binding, artifact: WorkflowArtifact, signal: AbortSignal, stage: "preflight" | "postcondition", declaration: WorkProcessCommand): Promise<void> {
    const journal = this.options.journal;
    if (journal.stageReceipts(binding).some(value => value.stage === stage)) return;
    if (!await this.authorized(start)) throw new WorkflowError("WorkEffectForbidden", "Current authority does not permit the command stage.", 403);
    const claim = journal.claimStage(binding, stage);
    if (!claim.launch) return;
    let report: WorkCommandReport;
    try { report = await this.options.executor.supervisedCommand(artifact, { ...task, work: start, deadline: start.deadline,
      timeoutMs: Math.max(1, start.deadline - Date.now()), idempotencyKey: logicalStageEffectKey(start.owner, start.workflow_id, start.activity_id, stage) }, declaration, signal, this.observer(start, binding, stage, () => {})); }
    catch (error) {
      if (error instanceof WorkflowError && error.code === "PhysicalSettlementUnknown") throw error;
      const result = this.output(start, binding, stage, Buffer.from(encode({ passed: false, unknown: true, detail: "Command completion evidence was lost.", failures: [] })));
      this.completeStage(binding, stage, claim.observation.observed_at, "unknown", result); return;
    }
    if (!report.passed && declaration.hint) report.detail = `${report.detail} ${declaration.hint}`.trim().slice(0, 2000);
    const result = this.output(start, binding, stage, Buffer.from(encode(report)));
    this.completeStage(binding, stage, claim.observation.observed_at, "passed", result);
  }
  private beforeMainReceipt(binding: Binding): void {
    const observed = this.options.journal.inspect(binding)!;
    const unsigned: Omit<Receipt, "receipt_digest"> = { ...binding, receipt_ref: this.options.journal.newReceiptRef(), revision: observed.revision + 1, committed_at: Date.now(),
      physical_state: observed.physical_state, effect_certainty: observed.effect_certainty, outcome: observed.effect_certainty === "uncertain" ? "uncertain" : observed.cancel_requested ? "cancelled" : "timed-out",
      stages: this.options.journal.stageReceipts(binding), output: null, validation: "skipped", validation_failures: null,
      action_checks: this.actionChecks(binding), summary: "Main execution did not launch after the retained preflight stage." };
    this.options.journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  }
  private async execute(task: ActivityTask, start: Start, binding: Binding, artifact: WorkflowArtifact, signal: AbortSignal): Promise<void> {
    if (start.process_program?.commands?.preflight) {
      await this.command(task, start, binding, artifact, signal, "preflight", start.process_program.commands.preflight);
      if (signal.aborted || Date.now() >= start.deadline || this.options.journal.inspect(binding)!.effect_certainty === "uncertain") { this.beforeMainReceipt(binding); return; }
    }
    {
      const claim = this.options.journal.claimStage(binding, "execution");
      if (!claim.launch) return;
      let evidence: ProcessExecutionEvidence | undefined, outcome: Outcome | undefined, error: unknown;
      try { outcome = await this.options.executor.supervisedActivity(artifact, { ...task, work: start, deadline: start.deadline,
        timeoutMs: Math.max(1, start.deadline - Date.now()) }, signal, this.observer(start, binding, "execution", value => { evidence = value; })); }
      catch (caught) { error = caught; }
      const result = outcome?.ok ? this.output(start, binding, "execution", Buffer.from(encode(outcome.value))) :
        evidence?.output.length ? this.output(start, binding, "execution", evidence.output) : null;
      if (evidence && !evidence.ceased) throw new WorkflowError("PhysicalSettlementUnknown", "Process group cessation is not proven; retain occupancy.", 409);
      const uncertain = !outcome && Boolean(evidence?.application_started) && !["pure", "repeatable"].includes(start.effect_policy.class);
      this.completeStage(binding, "execution", claim.observation.observed_at, uncertain ? "unknown" : outcome?.ok ? "passed" : "failed", result);
      await this.finishValidation(start, binding, artifact, signal, result, outcome, error, uncertain);
    }
  }
  private async finishValidation(start: Start, binding: Binding, artifact: WorkflowArtifact, signal: AbortSignal,
    result: WorkArtifactRef | null, outcome: Outcome | undefined, error: unknown, uncertain: boolean): Promise<void> {
    let validation: Receipt["validation"] = "skipped", failures: string[] | null = null;
    const prior = this.options.journal.stageReceipts(binding).find(stage => stage.stage === "validation");
    if (prior) {
      validation = prior.state === "passed" ? "passed" : "failed";
      failures = validation === "passed" ? [] : ["Retained output failed validation."];
      if (prior.result && validation === "failed") {
        try { const report = this.mainValue(prior.result) as { validation?: { errors?: Json } }; if (Array.isArray(report.validation?.errors)) failures = report.validation.errors.filter((value): value is string => typeof value === "string").slice(0, 100).map(value => value.slice(0, 2000)); } catch { /* Preserve the durable failed verdict. */ }
      }
    } else if (outcome?.ok && start.validation?.mode === "json-schema" && !signal.aborted && Date.now() < start.deadline) {
      const validating = this.options.journal.claimStage(binding, "validation");
      if (!validating.launch) return;
      let checked: { ok: true } | { ok: false; errors: string[] } | undefined;
      const validationEvidence: { value?: ProcessExecutionEvidence } = {};
      try { checked = await this.options.executor.supervisedValidation(artifact, outcome.value, start.validation.schema,
        Math.max(1, start.deadline - Date.now()), signal, this.observer(start, binding, "validation", value => { validationEvidence.value = value; })); }
      catch (caught) { error = caught; }
      if (validationEvidence.value?.output.length) this.output(start, binding, "validation", validationEvidence.value.output);
      if (validationEvidence.value && !validationEvidence.value.ceased) throw new WorkflowError("PhysicalSettlementUnknown", "Validation process group cessation is not proven.", 409);
      validation = checked?.ok && Date.now() <= start.deadline ? "passed" : "failed";
      failures = checked?.ok ? validation === "passed" ? [] : ["Validation exceeded the original deadline."] : checked?.errors ?? ["Validation did not return a valid verdict."];
      this.completeStage(binding, "validation", validating.observation.observed_at, validation === "passed" ? "passed" : "failed", this.options.journal.retainedStageOutput(binding, "validation"));
    } else if (outcome?.ok && start.validation?.mode === "json-schema") {
      validation = "failed"; failures = ["Required validation did not complete before stop or deadline."];
    }
    if (outcome?.ok && validation !== "failed" && start.process_program?.commands?.postcondition && !signal.aborted && Date.now() < start.deadline) {
      const task: ActivityTask = { owner: start.owner, runId: start.workflow_id, activityId: start.activity_id, token: start.attempt_id, type: start.activity_type!, input: start.inputs, work: start,
        artifact: start.source.digest, attempt: start.execution_fence, grantRevision: start.grant_revision, deadline: start.deadline, timeoutMs: Math.max(1, start.deadline - Date.now()), heartbeatMs: 1000, idempotencyKey: start.activity_id };
      await this.command(task, start, binding, artifact, signal, "postcondition", start.process_program.commands.postcondition);
    }
    const observed = this.options.journal.inspect(binding)!;
    const unsigned: Omit<Receipt, "receipt_digest"> = { ...binding, receipt_ref: this.options.journal.newReceiptRef(), revision: observed.revision + 1,
      committed_at: Date.now(), physical_state: observed.physical_state, effect_certainty: observed.effect_certainty,
      outcome: uncertain || observed.effect_certainty === "uncertain" ? "uncertain" : observed.cancel_requested ? "cancelled" : Date.now() > start.deadline ? "timed-out" :
        outcome?.ok && validation !== "failed" ? "complete" : "failed",
      stages: this.options.journal.stageReceipts(binding), output: result, validation, validation_failures: failures, ...(start.process_program?.commands ? { action_checks: this.actionChecks(binding) } : {}),
      summary: (outcome?.ok ? validation === "failed" ? "Retained output failed validation." : "Process result retained." :
        error instanceof ExecutionFault ? start.node_job || start.process_program ? error.message : error.code : outcome && !outcome.ok ? outcome.error.message : "Process did not return a valid result.").slice(0, 4000),
      ...(!outcome?.ok ? {failure: {code: outcome && !outcome.ok ? outcome.error.code : error instanceof ExecutionFault ? error.code : "ProcessFailure",
        retryable: Boolean(outcome && !outcome.ok && outcome.error.retryable)}} : {}) };
    this.options.journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  }
}
