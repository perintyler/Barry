/** Sessions-owned destination execution, separate from interactive API delivery. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { WorkflowSessionTurns, SessionReconciliationRequired, type WorkflowSessionBackend, type TurnState } from "@barry-rocks/sdk/internal/sessions";
import { TurnExecution, type ContinuationHarness, type PermissionDecision, type PermissionRequest, type TurnSnapshot } from "@barry-rocks/sdk/sessions";
import { WorkflowDestinations, type WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { inspectWorkflowHarnessOutcome, workflowHarnessPreparationRefusal } from "./workflow-process-harness.js";
import { workflowHarnessOutcomeHash } from "./workflow-harness-protocol.js";
import { observeWorkflowOutcomeRecovery, observeWorkflowPhysicalRecovery, workflowProcessOwnerIdentity } from "./workflow-process-recovery.js";

const physicalHandle = z.strictObject({
  kind: z.literal("process"), pid: z.number().int().positive(),
  pgid: z.number().int().positive(), bootIdentity: z.string().min(1).max(200),
  pidStartedAt: z.number().finite().positive(), hostname: z.string().min(1).max(200),
});
export type WorkflowHarnessHandle = z.infer<typeof physicalHandle>;
export interface WorkflowHarnessLaunch {
  sessionId: string; turnId: string; segmentId: string; owner: string;
  declaration: WorkflowDestinationBinding;
}
/** Preparing may create only an inert process. Credentials and input follow the committed handle. */
export interface PreparedWorkflowHarness {
  handle: WorkflowHarnessHandle;
  activate(): Promise<ContinuationHarness>;
  /** Independent proof for this exact owned process group, never close() fulfillment alone. */
  proveCessation(handle: WorkflowHarnessHandle): Promise<boolean>;
  /** Clean up the inert process if activation/authority checking fails. */
  dispose(): Promise<void>;
}
export interface WorkflowBackendOptions {
  db: Database.Database;
  declaration: WorkflowDestinationBinding;
  enforceable(scope: ApprovedBounds): boolean;
  /** Original ceiling/current policy, contract and deadline checks before credentials/input/effects. */
  authorize(scope: ApprovedBounds): Promise<void>;
  authorizeTool(scope: ApprovedBounds, call: PermissionRequest): Promise<PermissionDecision>;
  prepare(launch: WorkflowHarnessLaunch): Promise<PreparedWorkflowHarness>;
  acquire?(): Promise<{ release(): void }>;
  /** Trusted private spool location; recovery only repairs proven ceased metadata. */
  recovery?: { spoolRoot: string };
}

/** No route advertises this backend until a concrete supervised harness is installed. */
export class SessionsWorkflowBackend implements WorkflowSessionBackend {
  readonly destination: WorkflowDestinations;
  readonly execution: TurnExecution;
  private readonly declaration: WorkflowDestinationBinding;
  private readonly launches = new Map<string, WorkflowHarnessLaunch>();
  private readonly handles = new Map<string, { launch: WorkflowHarnessLaunch; handle: WorkflowHarnessHandle; prepared: PreparedWorkflowHarness; harness?: ContinuationHarness }>();
  private readonly leases = new Map<string, { release(): void }>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: WorkflowBackendOptions) {
    this.declaration = structuredClone(options.declaration);
    this.destination = new WorkflowDestinations(options.db, workflowProcessOwnerIdentity());
    const turns = this.destination.turns(this.declaration.bindingKey);
    // Keep the actual Sessions turn/effect machinery; only physical claim/release
    // accounting is additional. No fresh runStructured attempt or API-local queue.
    const store = new Proxy(turns, { get: (target, property) => {
      if (property === "claim") return (sessionId: string, turnId: string, owner: string) => {
        this.retainedDeclaration();
        const turn = target.snapshot(sessionId, turnId);
        if (!this.destination.claim(sessionId, turnId, turn.runId, owner)) return false;
        this.launches.set(sessionId, { sessionId, turnId, segmentId: turn.runId, owner, declaration: this.declaration });
        return true;
      };
      if (property === "execute") return async (...args: Parameters<typeof target.execute>) => {
        await this.check();
        const [sessionId, turnId, owner, call, effect] = args;
        return target.execute(sessionId, turnId, owner, call, async () => { await this.check(); return effect(); });
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    this.execution = new TurnExecution({ store,
      acquire: async () => {
        const launch = this.launches.get(this.declaration.sessionId);
        const lease = await options.acquire?.();
        if (launch && lease) this.leases.set(launch.segmentId, lease);
        return { release: () => {
          // TurnExecution also releases when openHarness rejects. An unknown
          // preparation outcome must keep its physical reservation in that case.
          if (launch) this.releaseLease(launch);
        } };
      },
      openHarness: sessionId => this.openHarness(sessionId),
      authorize: async (_sessionId, call) => {
        await this.check();
        const decision = await options.authorizeTool(structuredClone(this.declaration.scope), call);
        await this.check();
        return decision;
      },
    });
  }

  enforceable(scope: ApprovedBounds): boolean {
    return boundFingerprint(scope) === boundFingerprint(this.declaration.scope) && this.options.enforceable(structuredClone(scope));
  }
  private retainedDeclaration(): void {
    const retained = this.destination.lookupSession(this.declaration.sessionId);
    if (retained && boundFingerprint({ ...retained, boundFingerprint: undefined }) !== boundFingerprint(this.declaration)) throw new Error("Workflow session declaration conflict");
  }
  private async check(): Promise<void> {
    this.retainedDeclaration();
    if (!this.enforceable(this.declaration.scope) || Date.now() >= this.declaration.selection.deadline) throw new Error("Workflow session authority or deadline is unavailable");
    await this.options.authorize(structuredClone(this.declaration.scope));
    this.retainedDeclaration();
    if (!this.enforceable(this.declaration.scope) || Date.now() >= this.declaration.selection.deadline) throw new Error("Workflow session authority or deadline is unavailable");
  }
  async lookupSession(id: string) {
    if (id !== this.declaration.sessionId) return undefined;
    this.retainedDeclaration();
    const found = this.destination.lookupSession(id);
    return found && { identity: found.identity, boundFingerprint: found.boundFingerprint };
  }
  async createSession(request: { id: string; identity: string; scope: ApprovedBounds }): Promise<void> {
    await this.check();
    if (request.id !== this.declaration.sessionId || request.identity !== this.declaration.identity || !this.enforceable(request.scope)) throw new Error("Workflow session declaration conflict");
    this.destination.bind(this.declaration);
  }
  async lookupTurn(sessionId: string, turnId: string): Promise<TurnState | undefined> {
    if (sessionId !== this.declaration.sessionId) throw new Error("Workflow session declaration conflict");
    this.retainedDeclaration();
    const found = this.destination.inspect(turnId);
    if (!found) return this.destination.cancelled(turnId) ? { state: "interrupted" } : undefined;
    if (found.sessionId !== sessionId) throw new Error("Workflow turn belongs to another session");
    this.destination.lookupSession(sessionId);
    let fences = this.destination.settlements(found.turnId);
    if (this.options.recovery && fences.some(row => row.ceasedAt === null && row.handle !== null)) {
      try {
        const intent = this.options.db.prepare("SELECT request_hash FROM session_workflow_turns WHERE key=? AND session_id=?").get(turnId, sessionId) as { request_hash: string } | undefined;
        // Read only revision here. Even a corrupt result/checkpoint must not
        // prevent recording independently proven physical cessation.
        const logical = this.options.db.prepare("SELECT revision FROM session_turns WHERE id=? AND session_id=?").get(found.turnId, sessionId) as { revision: number } | undefined;
        if (intent && logical) {
          // An older interrupted segment may still fence its approved successor.
          // Settle its own physical facts without importing output or dispatching.
          for (const retained of fences) {
            if (retained.ceasedAt !== null || retained.handle === null) continue;
            const proof = observeWorkflowPhysicalRecovery({ declaration: this.declaration, key: turnId, fence: retained,
              originalIntentHash: intent.request_hash, revision: logical.revision });
            if (proof) this.destination.settlePhysical({ bindingKey: this.declaration.bindingKey, key: turnId,
              sessionId, turnId: found.turnId, segmentId: retained.segmentId, owner: retained.owner,
              expectedRevision: logical.revision, proof });
          }
          fences = this.destination.settlements(found.turnId);
        }
      } catch { throw new SessionReconciliationRequired(); }
    }
    let turn: TurnSnapshot;
    try { turn = this.destination.turns(this.declaration.bindingKey).snapshot(sessionId, found.turnId); }
    catch { throw new SessionReconciliationRequired(); }
    const alreadyCeased = fences.length > 0 && fences.every(row => row.phase === "ceased" || row.phase === "not_started");
    if (turn.state === "completed" && alreadyCeased) return { state: "complete", result: turn.result ?? null };
    if (turn.state === "cancelled" && (alreadyCeased || fences.length === 0)) return { state: "interrupted" };
    const fence = fences.find(row => row.segmentId === turn.runId);
    // A committed checkpoint/failure and settled fence no longer depend on
    // staging retention. Recovery only fills a missing metadata/physical commit.
    const retainedMetadata = alreadyCeased && (turn.state === "waiting_for_input" || turn.state === "failed");
    if (this.options.recovery && fence && fence.inputAt !== null && !retainedMetadata) {
      try {
        const binding = { sessionId, turnId: found.turnId, segmentId: fence.segmentId, owner: fence.owner };
        const outcome = inspectWorkflowHarnessOutcome(this.options.recovery.spoolRoot, binding);
        if (outcome) {
          const outcomeHash = workflowHarnessOutcomeHash(outcome);
          const proof = observeWorkflowOutcomeRecovery({ declaration: this.declaration, key: turnId, fence, outcomeHash });
          if (proof) {
            turn = this.destination.recoverOutcome({ bindingKey: this.declaration.bindingKey, key: turnId, ...binding,
              expectedRevision: turn.revision, outcome, outcomeHash, proof });
            fences = this.destination.settlements(found.turnId);
          }
        }
      } catch { throw new SessionReconciliationRequired(); }
    }
    const ceased = fences.length > 0 && fences.every(fence => fence.phase === "ceased" || fence.phase === "not_started");
    if (turn.state === "completed" && ceased) return { state: "complete", result: turn.result ?? null };
    if (turn.state === "cancelled" && (ceased || fences.length === 0)) return { state: "interrupted" };
    // Logical completion, owner=NULL, process loss and close() alone prove none
    // of these fences. A later read may use the retained raw turn result.
    const lostRunning = turn.state === "running" && fences.some(row => row.segmentId === turn.runId && row.phase === "ceased");
    return { state: !lostRunning && (turn.state === "running" || turn.state === "waiting_for_input") ? "active" : "uncertain" };
  }
  async runTurn(request: { sessionId: string; turnId: string; input: unknown; scope: ApprovedBounds }): Promise<unknown> {
    await this.check();
    if (request.sessionId !== this.declaration.sessionId || !this.enforceable(request.scope)) throw new Error("Workflow turn declaration conflict");
    if (typeof request.input !== "string" && !(request.input && typeof request.input === "object" && "text" in request.input && typeof request.input.text === "string")) throw new Error("Workflow harness requires text input");
    const admitted = this.destination.admit({ key: request.turnId, sessionId: request.sessionId, input: request.input, scope: request.scope });
    if (admitted.created) this.execution.recover(admitted.turn, request.input, false);
    this.deadline(request.sessionId, request.turnId);
    while (true) {
      const before = this.destination.turns(this.declaration.bindingKey).snapshot(request.sessionId, admitted.turn.id);
      await this.execution.settled(admitted.turn.id);
      await new Promise(resolve => setTimeout(resolve, 0));
      const current = this.destination.turns(this.declaration.bindingKey).snapshot(request.sessionId, admitted.turn.id);
      if (current.state !== "running" && current.state !== "waiting_for_input") break;
      // Automatic approval continuation installs a successor task after the
      // previous promise settles. Own the whole turn, including that handoff.
      if (current.runId === before.runId) throw new SessionReconciliationRequired();
    }
    this.clearSettledDeadline(request.turnId, admitted.turn.id);
    const observed = await this.lookupTurn(request.sessionId, request.turnId);
    if (observed?.state === "complete") return observed.result;
    throw new SessionReconciliationRequired();
  }
  async interruptTurn(sessionId: string, key: string): Promise<boolean> {
    if (sessionId !== this.declaration.sessionId) throw new Error("Workflow session declaration conflict");
    const found = this.destination.inspect(key);
    if (found && found.sessionId !== sessionId) throw new Error("Workflow turn belongs to another session");
    this.destination.cancel(key);
    if (found) await this.execution.cancel(sessionId, found.turnId);
    const observed = await this.lookupTurn(sessionId, key);
    return observed?.state === "interrupted" || observed?.state === "complete";
  }

  private async openHarness(sessionId: string): Promise<ContinuationHarness> {
    const launch = this.launches.get(sessionId);
    if (!launch) throw new SessionReconciliationRequired();
    await this.check();
    // Claim already recorded this segment. Count every retained attempt, even
    // prior refusals, before invoking preparation or creating a native process.
    if (this.destination.settlements(launch.turnId).length > this.declaration.selection.maxTurns) {
      this.destination.notStarted(launch.segmentId, launch.owner);
      this.releaseLease(launch);
      throw new Error("Workflow session turn budget exhausted");
    }
    this.destination.preparing(launch.segmentId, launch.owner);
    let prepared: PreparedWorkflowHarness;
    try { prepared = await this.options.prepare(structuredClone(launch)); }
    catch (error) {
      if (workflowHarnessPreparationRefusal(error, launch)) {
        try {
          this.destination.refusePreparation({ bindingKey: this.declaration.bindingKey, sessionId: launch.sessionId, turnId: launch.turnId,
            segmentId: launch.segmentId, owner: launch.owner, declarationHash: boundFingerprint(this.declaration) });
          this.releaseLease(launch);
        } catch (commit) { throw new AggregateError([error, commit], "Workflow preparation refusal remains uncommitted"); }
      }
      throw error;
    }
    let handle: WorkflowHarnessHandle;
    try {
      handle = physicalHandle.parse(prepared.handle);
      if (handle.pgid !== handle.pid) throw new Error("Workflow harness must own its isolated process group");
    } catch (error) {
      // Cleanup can reduce damage, but an invalid handle cannot prove cessation.
      try { await prepared.dispose(); } catch { /* Keep the original failure and launch fence. */ }
      throw error;
    }
    this.handles.set(launch.segmentId, { launch, handle, prepared });
    let harness: ContinuationHarness;
    try {
      this.destination.handle(launch.segmentId, launch.owner, { ...handle, sessionId, turnId: launch.turnId, segmentId: launch.segmentId });
      await this.check();
      if (this.destination.cancelled(this.destinationKey(launch.turnId))) throw new Error("Workflow turn cancelled before activation");
      harness = await prepared.activate();
      this.handles.set(launch.segmentId, { launch, handle, prepared, harness });
      if (harness.approvalContinuation !== "durable") throw new Error("Workflow destinations require durable approval continuation");
    } catch (error) {
      await this.closePrepared(launch, prepared, this.handles.get(launch.segmentId)?.harness, handle);
      throw error;
    }
    const input = async () => {
      await this.check();
      if (this.destination.settlements(launch.turnId).length > this.declaration.selection.maxTurns) throw new Error("Workflow session turn budget exhausted");
      this.destination.input(launch.segmentId, launch.owner);
    };
    return {
      approvalContinuation: harness.approvalContinuation,
      validate: descriptor => harness.validate(descriptor),
      begin: async (...args) => { await input(); return harness.begin(...args); },
      restore: async (...args) => { await input(); return harness.restore(...args); },
      interrupt: () => harness.interrupt(),
      close: () => this.closePrepared(launch, prepared, harness, handle),
    };
  }
  private destinationKey(turnId: string): string {
    const row = this.options.db.prepare("SELECT key FROM session_workflow_destination_turns WHERE turn_id=?").get(turnId) as { key: string } | undefined;
    if (!row) throw new SessionReconciliationRequired();
    return row.key;
  }
  private async closePrepared(launch: WorkflowHarnessLaunch, prepared: PreparedWorkflowHarness, harness: ContinuationHarness | undefined, handle: WorkflowHarnessHandle): Promise<void> {
    // Keep the actual local orphan reachable even if a metadata write failed.
    // Its handle can be repaired after native cleanup without another launch.
    try { this.destination.closing(launch.segmentId, launch.owner); } catch { /* Native cleanup still runs. */ }
    if (harness) await harness.close(); else await prepared.dispose();
    if (!await prepared.proveCessation(handle)) throw new SessionReconciliationRequired();
    this.destination.handle(launch.segmentId, launch.owner, { ...handle, sessionId: launch.sessionId, turnId: launch.turnId, segmentId: launch.segmentId });
    this.destination.closing(launch.segmentId, launch.owner);
    this.destination.ceased(launch.segmentId, launch.owner);
    this.handles.delete(launch.segmentId);
    this.releaseLease(launch);
  }
  private releaseLease(launch: WorkflowHarnessLaunch): void {
    const fence = this.destination.settlements(launch.turnId).find(row => row.segmentId === launch.segmentId);
    if (fence?.phase === "launching") this.destination.notStarted(launch.segmentId, launch.owner);
    else if (fence?.phase !== "ceased" && fence?.phase !== "not_started") return;
    const lease = this.leases.get(launch.segmentId);
    this.leases.delete(launch.segmentId);
    lease?.release();
  }
  private deadline(sessionId: string, key: string): void {
    if (this.deadlines.has(key)) return;
    const fire = () => {
      const remaining = this.declaration.selection.deadline - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(fire, Math.min(remaining, 2_147_483_647));timer.unref();this.deadlines.set(key, timer);
      } else { void this.interruptTurn(sessionId, key).catch(() => {}); }
    };
    const timer = setTimeout(fire, Math.min(Math.max(0, this.declaration.selection.deadline - Date.now()), 2_147_483_647));timer.unref();this.deadlines.set(key, timer);
  }
  private clearSettledDeadline(key: string, turnId: string): void {
    if (this.destination.settlements(turnId).some(row => row.ceasedAt === null)) return;
    const timer = this.deadlines.get(key);if (timer) clearTimeout(timer);this.deadlines.delete(key);
  }
  /** Own service drain, without converting unknown native cleanup into success. */
  async close(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.execution.close(); } catch (error) { failures.push(error); }
    for (const entry of [...this.handles.values()]) {
      try { await this.closePrepared(entry.launch, entry.prepared, entry.harness, entry.handle); }
      catch (error) { failures.push(error); }
    }
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    if (this.destination.unsettled().some(row => row.sessionId === this.declaration.sessionId) || this.leases.size) failures.push(new SessionReconciliationRequired());
    if (failures.length) throw new AggregateError(failures, "Workflow harness cleanup remains uncertain");
  }
}

export function workflowSessionExecution(options: WorkflowBackendOptions, journal: ConstructorParameters<typeof WorkflowSessionTurns>[0]) {
  const backend = new SessionsWorkflowBackend(options);
  return { backend, turns: new WorkflowSessionTurns(journal, backend) };
}
