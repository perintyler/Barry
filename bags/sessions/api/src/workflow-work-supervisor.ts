/** Sessions executor custody with the existing Work journal/delivery contract. */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { parseStructuredOutput } from "@barry-rocks/sdk/sessions";
import { validateAgainstSchema } from "@barry-rocks/sdk/internal/tools";
import { getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { executionBindingSchema, executorStartSchema, logicalStageEffectKey, limits, processBootIdentity, workReceiptDigest,
  type ActivityTask, type WorkActivitySupervisor, type WorkOwnerConnection, type ExecutorJournal, type WorkArtifactStore,
  type WorkExecutionStart, type WorkExecutionObservation, type WorkExecutionReceipt, type WorkArtifactRef } from "@barry-rocks/sdk/internal/workflows";
import type { WorkflowWorkSession, WorkflowWorkSessions } from "./workflow-work-sessions.js";
import { inspectWorkflowWorkPhysical, type WorkflowWorkPhysical } from "./workflow-work-physical.js";

type Binding = z.infer<typeof executionBindingSchema>;
const bindingOf = (start: Binding): Binding => executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof Binding]])));
interface Live { binding: Binding; start: WorkExecutionStart; session?: WorkflowWorkSession; done: Promise<void>; cancelled: boolean }
export class WorkflowWorkSupervisor implements WorkActivitySupervisor {
  readonly bootIdentity = `${processBootIdentity()}:${randomUUID()}`;
  private readonly live = new Map<string, Live>();
  private stopped = false;
  constructor(private readonly options: { installation: string; journal: ExecutorJournal; artifacts: WorkArtifactStore;
    sessions: Pick<WorkflowWorkSessions, "open" | "recover" | "close">; clients: ReadonlyMap<string, WorkOwnerConnection>; onError?: (error: unknown) => void }) {}
  async start(task: ActivityTask): Promise<WorkExecutionObservation> {
    const start = executorStartSchema.parse(task.work), binding = bindingOf(start);
    if (!start.agent_program || start.resources.executor !== "agent" || !start.launch_authorized || task.owner !== start.owner || task.runId !== start.workflow_id
      || task.token !== start.attempt_id || task.activityId !== start.activity_id || task.type !== start.activity_type || task.artifact !== start.source.digest
      || boundFingerprint(task.input) !== boundFingerprint(start.inputs)) throw new Error("WorkAgentTaskBindingConflict");
    const journal = this.options.journal, old = journal.inspect(binding);
    journal.start(start); // Redelivery rechecks the complete retained request.
    if (old || this.live.has(boundFingerprint(binding))) { this.recoverReceipt(binding); return journal.inspect(binding)!; }
    if (this.stopped) return this.cancel(binding);
    const live: Live = { binding, start, cancelled: false, done: Promise.resolve() };
    this.live.set(boundFingerprint(binding), live);
    live.done = this.execute(live, false).catch(error => this.options.onError?.(error)).finally(() => this.live.delete(boundFingerprint(binding)));
    return journal.inspect(binding)!;
  }
  inspect(binding: Binding) { return { observation: this.options.journal.inspect(binding), receipt: this.options.journal.receipt(binding) }; }
  owns(binding: Binding) { return this.live.has(boundFingerprint(binding)); }
  occupiedCount(owner?: string) {
    let count = this.options.journal.occupiedCount(owner);
    for (const live of this.live.values()) if ((!owner || live.binding.owner === owner) && ["not-started", "ceased"].includes(this.options.journal.inspect(live.binding)!.physical_state)) count++;
    return count;
  }
  leaseLost(owner: string): void { for (const live of this.live.values()) if (live.binding.owner === owner) this.cancel(live.binding); }
  cancel(binding: Binding): WorkExecutionObservation {
    const journal = this.options.journal, observation = journal.cancel(binding), live = this.live.get(boundFingerprint(binding));
    if (live) {
      live.cancelled = true;
      if (live.session) void live.session.interrupt().catch(error => this.options.onError?.(error));
    } else if (observation.physical_state === "not-started") this.commit(binding, "cancelled", null, "skipped", null, "Cancelled before Sessions input.");
    else this.recoverReceipt(binding);
    return journal.inspect(binding)!;
  }
  recoverReceipt(binding: Binding): WorkExecutionReceipt | null {
    const journal = this.options.journal, receipt = journal.receipt(binding);
    if (receipt || this.owns(binding)) return receipt;
    const start = journal.retainedStart(binding), observation = journal.inspect(binding);
    if (!start?.agent_program || !observation || observation.physical_state === "not-started") return null;
    const live: Live = { binding, start, cancelled: observation.cancel_requested, done: Promise.resolve() };
    this.live.set(boundFingerprint(binding), live);
    // Metadata/native recovery never submits model input or a fresh destination.
    live.done = this.execute(live, true).catch(error => this.options.onError?.(error)).finally(() => this.live.delete(boundFingerprint(binding)));
    return null;
  }
  async resumeValidation(binding: Binding): Promise<WorkExecutionObservation | null> { this.recoverReceipt(binding); return this.options.journal.inspect(binding); }
  private physical(session: WorkflowWorkSession): WorkflowWorkPhysical {
    return withStoreContext({ identity: session.declaration.identity }, () => inspectWorkflowWorkPhysical(getSessionsSqlite(), session.backend, session.declaration, session.key));
  }
  private async execute(live: Live, recovering: boolean): Promise<void> {
    const { journal } = this.options, { binding, start } = live;
    let submitted = recovering, stageClaimed = recovering, executionFailure = false;
    try {
      if (recovering) {
        live.session = await this.options.sessions.recover(binding);
        if (!live.session) return; // Missing custody remains unknown; no replacement launch.
      } else {
        const client = this.options.clients.get(start.owner);
        const delegation = client && await client.delegation(start.attempt_id);
        if (!delegation || boundFingerprint(delegation.start) !== boundFingerprint(start)) throw new Error("WorkAgentDelegationUnavailable");
        live.session = await this.options.sessions.open(delegation);
        if (live.cancelled || this.stopped || journal.inspect(binding)!.cancel_requested) { this.cancel(binding); return; }
        if (!journal.claimStage(binding, "execution").launch) return;
        stageClaimed = true;
        const handle = { kind: "session" as const, installation: this.options.installation, session_id: live.session.declaration.sessionId, turn_id: live.session.key };
        journal.recordHandle(binding, "execution", handle);
        journal.assertStageInput(binding, "execution", handle);
        submitted = true; // A failed call can already have committed destination input.
        const deadline = setTimeout(() => this.cancel(binding), Math.max(1, binding.deadline - Date.now())); deadline.unref();
        try { await live.session.start(); }
        catch { executionFailure = true; }
        finally { clearTimeout(deadline); }
        if (executionFailure && (await live.session.fenceInput()).neverStarted) { this.neverStarted(live, true); return; }
      }
      if (live.cancelled || journal.inspect(binding)!.cancel_requested) await live.session.interrupt().catch(error => this.options.onError?.(error));
      let physical: WorkflowWorkPhysical = { state: "unknown", terminal: false, allNotStarted: false, turnId: null, segments: 0 };
      let logical: Awaited<ReturnType<WorkflowWorkSession["lookup"]>>;
      // Driver closure and logical completion are independent. This bounded
      // observation window never converts absence of proof into free capacity.
      const until = Date.now() + 30000;
      do {
        try { logical = await live.session.lookup(); } catch { /* Preserve independent physical proof even with malformed result JSON. */ }
        try { physical = this.physical(live.session); } catch { /* Unreadable proof stays unknown. */ }
        if (physical.state === "ceased") {
          // A corrupt/missing logical outcome cannot retain physical capacity.
          // Fence every future input before accepting cessation while logical
          // coordination remains unresolved (including an approved successor).
          if (!physical.terminal) {
            await live.session.fenceInput();
            logical = undefined;
            // A successor could have been claimed between the first aggregate
            // observation and exclusion. Only the post-fence snapshot counts.
            physical = this.physical(live.session);
            if (physical.state !== "ceased") { await live.session.interrupt().catch(error => this.options.onError?.(error)); continue; }
          }
          break;
        }
        if (this.stopped) break;
        await delay(25);
      } while (Date.now() < until);
      if (physical.state !== "ceased") {
        const excluded = await live.session.fenceInput();
        if (excluded.neverStarted) { this.neverStarted(live, executionFailure); return; }
        logical = undefined;
        // The cancellation transaction may have positively excluded queued,
        // never-claimed successor segments. Re-read their bound evidence.
        physical = this.physical(live.session);
        if (physical.state !== "ceased") return;
      }
      const main = journal.stageReceipts(binding).find(stage => stage.stage === "execution");
      if (!main) {
        // Physical settlement precedes any interpretation of the retained reply.
        let output: WorkArtifactRef | null = journal.retainedStageOutput(binding, "execution"), known = logical?.state === "complete", value: unknown;
        if (known) {
          try {
            value = JSON.parse(logical!.result!);
            const encoded = JSON.stringify(value);
            if (Buffer.byteLength(encoded) > limits.payload) throw new Error("WorkAgentOutputTooLarge");
            const candidate = this.options.artifacts.stage(Buffer.from(encoded), { purpose: "output", owner_identity: start.output_identity!, media_type: "application/json" });
            if (output && boundFingerprint(output) !== boundFingerprint(candidate)) throw new Error("WorkAgentRetainedResultConflict");
            output = candidate; journal.retainStageOutput(binding, "execution", output);
          } catch { known = false; }
        }
        const now = Date.now();
        journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"), attempt_id: binding.attempt_id,
          state: known ? "passed" : executionFailure && physical.allNotStarted ? "failed" : "unknown", started_at: journal.stageIntent(binding, "execution")!.started_at, completed_at: now, result: output }, "ceased");
      }
      this.finish(binding);
    } catch (error) {
      if (submitted && live.session) {
        // Positive exclusion proof is bound to this actual destination and a
        // committed cancellation tombstone, never inferred from missing rows.
        try { if ((await live.session.fenceInput()).neverStarted) { this.neverStarted(live, true); return; } } catch { /* Unknown custody remains retained. */ }
      }
      if (!submitted) {
        if (stageClaimed && !journal.stageReceipts(binding).some(stage => stage.stage === "execution")) {
          const now = Date.now(); journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"), attempt_id: binding.attempt_id,
            state: "skipped", started_at: now, completed_at: now, result: null }, "not-started");
        }
        const observation = journal.inspect(binding)!;
        this.commit(binding, observation.cancel_requested ? "cancelled" : Date.now() >= binding.deadline ? "timed-out" : "failed", null, "skipped", null, "Sessions refused before destination input.");
      }
      this.options.onError?.(error);
    }
  }
  private neverStarted(live: Live, failed: boolean): void {
    const { journal } = this.options, { binding } = live;
    if (!journal.stageReceipts(binding).some(stage => stage.stage === "execution")) {
      const intent = journal.stageIntent(binding, "execution");
      if (intent) { const now = Date.now(); journal.completeStage(binding, { stage: "execution", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution"),
        attempt_id: binding.attempt_id, state: "skipped", started_at: intent.started_at, completed_at: now, result: null }, "not-started"); }
    }
    this.commit(binding, journal.inspect(binding)!.cancel_requested ? "cancelled" : Date.now() >= binding.deadline ? "timed-out" : failed ? "failed" : "cancelled", null, "skipped", null, "Durable destination fencing proves no Sessions input.");
  }
  private finish(binding: Binding): void {
    const { journal, artifacts } = this.options, observation = journal.inspect(binding)!, start = journal.retainedStart(binding)!, stages = journal.stageReceipts(binding);
    const main = stages.find(stage => stage.stage === "execution");
    if (!main) return;
    const validationIntent = journal.stageIntent(binding, "validation");
    const pureValidationRecovery = main.state === "passed" && validationIntent && !validationIntent.receipt && validationIntent.handle === null;
    if (observation.physical_state !== "ceased" && !pureValidationRecovery) return;
    if (main.state !== "passed" || observation.effect_certainty === "uncertain" && !pureValidationRecovery) {
      this.commit(binding, "uncertain", main.result, "unknown", ["Sessions ceased; a successful result is not established."], "Retained physical cessation with unresolved outcome."); return;
    }
    let validation: WorkExecutionReceipt["validation"] = "skipped", failures: string[] | null = null, output = main.result;
    if (start.validation?.mode === "json-schema" && (observation.cancel_requested || Date.now() >= binding.deadline) && !stages.some(stage => stage.stage === "validation") && !pureValidationRecovery) {
      this.commit(binding, observation.cancel_requested ? "cancelled" : "timed-out", output, "failed", ["Required validation did not finish before stop or deadline."], "Sessions ceased before required validation."); return;
    }
    if (start.validation?.mode === "json-schema") {
      const existing = stages.find(stage => stage.stage === "validation");
      if (existing) { validation = existing.state === "passed" ? "passed" : "failed"; if (validation === "passed") output = existing.result ?? main.result; failures = validation === "passed" ? [] : ["Retained Sessions output failed validation."]; }
      else if (pureValidationRecovery || journal.claimStage(binding, "validation").launch) {
        failures = [];
        let validationOutput = journal.retainedStageOutput(binding, "validation");
        try {
          if (observation.cancel_requested || Date.now() >= binding.deadline) throw new Error("WorkValidationDeadlineExpired");
          const raw = JSON.parse(artifacts.verify(main.result!).toString("utf8"));
          const parsed: { value?: unknown; parseError?: string } = typeof raw === "string" && start.validation.schema.type !== "string" ? parseStructuredOutput(raw) : { value: raw };
          if (parsed.parseError) failures.push(parsed.parseError);
          else {
            const verdict = validateAgainstSchema(start.validation.schema, parsed.value);
            if (!verdict.ok) failures.push(...verdict.errors.slice(0, 100).map(message => message.slice(0, 2000)));
            else {
              const checked = artifacts.stage(Buffer.from(JSON.stringify(parsed.value)), { purpose: "output", owner_identity: start.output_identity!, media_type: "application/json" });
              if (validationOutput && boundFingerprint(validationOutput) !== boundFingerprint(checked)) throw new Error("WorkAgentRetainedValidationConflict");
              validationOutput = checked; output = checked; journal.retainStageOutput(binding, "validation", checked);
            }
          }
        } catch { failures.push("Retained Sessions output is not valid bounded JSON."); }
        validation = failures.length ? "failed" : "passed";
        const now = Date.now(); journal.completeStage(binding, { stage: "validation", effect_key: logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "validation"), attempt_id: binding.attempt_id,
          state: validation, started_at: journal.stageIntent(binding, "validation")!.started_at, completed_at: now, result: validationOutput }, "ceased");
      } else { validation = "failed"; failures = ["Required output validation did not run before stop or deadline."]; }
    }
    const inBudget = stages.every(stage => stage.completed_at !== null && stage.completed_at <= binding.deadline);
    this.commit(binding, observation.cancel_requested ? "cancelled" : !inBudget || Date.now() >= binding.deadline ? "timed-out" : validation === "failed" ? "failed" : "complete", output, validation, failures, "Sessions result retained after aggregate physical cessation.");
  }
  private commit(binding: Binding, outcome: WorkExecutionReceipt["outcome"], output: WorkArtifactRef | null, validation: WorkExecutionReceipt["validation"], failures: string[] | null, summary: string): WorkExecutionReceipt {
    const journal = this.options.journal, old = journal.receipt(binding); if (old) return old;
    const observation = journal.inspect(binding)!;
    const unsigned: Omit<WorkExecutionReceipt, "receipt_digest"> = { ...binding, receipt_ref: journal.newReceiptRef(), revision: observation.revision + 1, committed_at: Date.now(),
      physical_state: observation.physical_state, effect_certainty: observation.effect_certainty, outcome, stages: journal.stageReceipts(binding), output, validation, validation_failures: failures, summary };
    return journal.commitReceipt(binding, { ...unsigned, receipt_digest: workReceiptDigest(unsigned) });
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const live of this.live.values()) this.cancel(live.binding);
    const results = await Promise.allSettled([this.options.sessions.close(), ...[...this.live.values()].map(live => live.done)]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "WorkSessionsSupervisorCloseFailed");
  }
}
