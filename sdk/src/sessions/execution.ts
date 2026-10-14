import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision, ContinuationDescriptor, ContinuationHarness,
  RecordedCallResult, ReviewPolicy, TurnSnapshot,
} from "./continuations.js";
import type { PermissionDecision, PermissionRequest, SessionEvent } from "./index.js";

export interface TurnExecutionStore {
  admit(input: { sessionId: string; requestId: string; runId: string; actor: string; content: unknown; policy: ReviewPolicy; ifActive?: "error" | "queue" }): TurnSnapshot;
  promoteQueued?(sessionId: string): { turn: TurnSnapshot; input: unknown } | undefined;
  snapshot(sessionId: string, turnId: string): TurnSnapshot;
  claim(sessionId: string, turnId: string, owner: string): boolean;
  pause(sessionId: string, turnId: string, owner: string, continuation: ContinuationDescriptor, calls: PermissionRequest[]): TurnSnapshot;
  resolve(input: { sessionId: string; turnId: string; requestId: string; runId: string; actor: string; decisions: ApprovalDecision[]; context?: unknown }): TurnSnapshot;
  continuation(sessionId: string, turnId: string): ContinuationDescriptor;
  conversation(sessionId: string): ContinuationDescriptor | undefined;
  cancel(sessionId: string, turnId: string): TurnSnapshot;
  released(sessionId: string, turnId: string, owner: string): void;
  lost(sessionId: string, turnId: string, error: string): TurnSnapshot;
  decisions(sessionId: string, turnId: string): Map<string, PermissionDecision>;
  recorded(sessionId: string, turnId: string, call: PermissionRequest): RecordedCallResult | undefined;
  denied(sessionId: string, turnId: string, owner: string, call: PermissionRequest, outcome: RecordedCallResult): RecordedCallResult;
  execute(sessionId: string, turnId: string, owner: string, call: PermissionRequest, effect: () => Promise<RecordedCallResult>): Promise<RecordedCallResult>;
  append(sessionId: string, turnId: string, event: unknown): number;
  finish(sessionId: string, turnId: string, owner: string, outcome: { state: "completed" | "failed" | "recovery_required"; result?: unknown; error?: string; conversation?: ContinuationDescriptor }): TurnSnapshot;
}

export interface TurnExecutionDependencies {
  store: TurnExecutionStore;
  openHarness(sessionId: string): Promise<ContinuationHarness>;
  authorize(sessionId: string, call: PermissionRequest): Promise<PermissionDecision>;
  acquire?(): Promise<{ release(): void }>;
  /** Notification is only a wake-up; the committed store is the replay source. */
  committed?(sessionId: string, sequence: number): void;
}

/** One execution path for HTTP, apps and workflow turn receipts. */
export class TurnExecution {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly handles = new Map<string, ContinuationHarness>();
  private readonly parked = new Map<string, { sessionId: string; harness: ContinuationHarness }>();
  private draining = false;
  private readonly cleanupErrors: unknown[] = [];

  constructor(private readonly dependencies: TurnExecutionDependencies) {}

  admit(input: Parameters<TurnExecutionStore["admit"]>[0]): TurnSnapshot {
    if (this.draining) throw new Error("Session execution is draining");
    const turn = this.dependencies.store.admit(input);
    if (turn.state === "running") this.dispatch(turn, input.content, false);
    return turn;
  }

  resolve(input: Parameters<TurnExecutionStore["resolve"]>[0]): TurnSnapshot {
    if (this.draining) throw new Error("Session execution is draining");
    const turn = this.dependencies.store.resolve(input);
    this.dispatch(turn, undefined, true);
    return turn;
  }

  /** Only runnable, unclaimed records are dispatched; never steal a process lease. */
  recover(turn: TurnSnapshot, input?: unknown, restoring = true): void {
    if (this.draining) return;
    this.dispatch(turn, input, restoring);
  }

  async cancel(sessionId: string, turnId: string): Promise<TurnSnapshot> {
    this.dependencies.store.cancel(sessionId, turnId);
    const parked = this.parked.get(turnId);
    if (parked) {
      await parked.harness.close(); this.parked.delete(turnId);
      this.dependencies.store.released(sessionId, turnId, `cancel:${turnId}`);
    }
    await this.handles.get(turnId)?.interrupt();
    await this.tasks.get(turnId);
    const next = this.dependencies.store.promoteQueued?.(sessionId);
    if (next) this.dispatch(next.turn, next.input, false);
    return this.dependencies.store.snapshot(sessionId, turnId);
  }

  private dispatch(turn: TurnSnapshot, input: unknown, restoring: boolean): void {
    if (turn.state !== "running") return;
    const previous = this.tasks.get(turn.id);
    if (previous) {
      void previous.then(() => this.dispatch(turn, input, restoring));
      return;
    }
    const owner = randomUUID();
    if (!this.dependencies.store.claim(turn.sessionId, turn.id, owner)) return;
    const task = this.run(turn, owner, input, restoring).catch((error) => {
      this.cleanupErrors.push(error);
      // Failed physical cleanup retains the claim. It must remain visible and
      // cannot become an unhandled background rejection or a competing run.
      this.dependencies.store.lost(turn.sessionId, turn.id, `Harness cleanup failed: ${String(error)}`);
    }).finally(() => this.tasks.delete(turn.id));
    this.tasks.set(turn.id, task);
  }

  private publish(turn: TurnSnapshot, event: unknown): void {
    const sequence = this.dependencies.store.append(turn.sessionId, turn.id, event);
    try { this.dependencies.committed?.(turn.sessionId, sequence); } catch { /* Replay recovers a failed wake-up. */ }
  }

  private async run(turn: TurnSnapshot, owner: string, input: unknown, restoring: boolean): Promise<void> {
    const { store } = this.dependencies;
    let harness: ContinuationHarness | undefined;
    let lease: { release(): void } | undefined;
    try {
      lease = await this.dependencies.acquire?.();
      if (store.snapshot(turn.sessionId, turn.id).state === "cancelled") return;
      harness = this.parked.get(turn.id)?.harness ?? await this.dependencies.openHarness(turn.sessionId);
      this.parked.delete(turn.id);
      this.handles.set(turn.id, harness);
      if (harness.approvalContinuation === "unsupported") throw new Error("This harness does not support approval continuation");
      const emit = async (event: SessionEvent) => this.publish(turn, JSON.parse(JSON.stringify(event)));
      const effects = {
        recorded: async (call: PermissionRequest) => store.recorded(turn.sessionId, turn.id, call),
        denied: async (call: PermissionRequest, outcome: RecordedCallResult) => store.denied(turn.sessionId, turn.id, owner, call, outcome),
        authorize: (call: PermissionRequest) => this.dependencies.authorize(turn.sessionId, call),
        execute: (call: PermissionRequest, effect: () => Promise<RecordedCallResult>) => store.execute(turn.sessionId, turn.id, owner, call, effect),
      };
      let outcome;
      if (restoring) {
        const checkpoint = store.continuation(turn.sessionId, turn.id);
        harness.validate(checkpoint);
        outcome = await harness.restore(checkpoint, store.decisions(turn.sessionId, turn.id), effects, emit);
      } else {
        const content = typeof input === "string" ? input : input && typeof input === "object" && "text" in input ? input.text : undefined;
        if (typeof content !== "string") throw new Error("This harness requires text input");
        outcome = await harness.begin(content, emit, store.conversation(turn.sessionId));
      }
      if (outcome.type === "interrupted") {
        const paused = store.pause(turn.sessionId, turn.id, owner, outcome.continuation, outcome.calls);
        // Close before any automatic resolution can open a successor runtime.
        if (harness.approvalContinuation === "live") this.parked.set(turn.id, { sessionId: turn.sessionId, harness });
        else await harness.close();
        harness = undefined; this.handles.delete(turn.id);
        store.released(turn.sessionId, turn.id, owner);
        if (paused.reviewPolicy.mode === "automatic" && !this.draining) {
          const decisions: ApprovalDecision[] = [];
          for (const interrupt of paused.interrupts.filter((item) => item.status === "pending")) {
            decisions.push({ interruptId: interrupt.id, decision: await this.dependencies.authorize(turn.sessionId, interrupt.call) });
          }
          const resumed = store.resolve({ sessionId: turn.sessionId, turnId: turn.id, requestId: `automatic:${paused.runId}`, runId: randomUUID(), actor: "session-policy", decisions });
          // The current dispatch owns the map entry until its finally block.
          this.dispatch(resumed, undefined, true);
        }
      } else {
        const finished = store.finish(turn.sessionId, turn.id, owner, outcome.type === "failed"
          ? { state: "failed", error: outcome.error }
          : { state: "completed", ...(outcome.result === undefined ? {} : { result: outcome.result }), ...(outcome.conversation ? { conversation: outcome.conversation } : {}) });
        this.publish(finished, { type: "turn_snapshot", snapshot: finished });
        const next = store.promoteQueued?.(turn.sessionId);
        if (next) this.dispatch(next.turn, next.input, false);
      }
    } catch (error) {
      const current = store.snapshot(turn.sessionId, turn.id);
      if (current.state === "running") {
        const blocked = store.finish(turn.sessionId, turn.id, owner, { state: "recovery_required", error: error instanceof Error ? error.message : String(error) });
        this.publish(blocked, { type: "turn_snapshot", snapshot: blocked });
      }
    } finally {
      this.handles.delete(turn.id);
      await harness?.close();
      store.released(turn.sessionId, turn.id, owner);
      lease?.release();
    }
  }

  async settled(turnId: string): Promise<void> { await this.tasks.get(turnId); }

  async close(): Promise<void> {
    this.draining = true;
    await Promise.allSettled([...this.handles.values()].map((handle) => handle.interrupt()));
    await Promise.allSettled([...this.tasks.values()]);
    for (const [turnId, parked] of this.parked) {
      try {
        await parked.harness.close();
        this.dependencies.store.lost(parked.sessionId, turnId, "Live harness closed during service drain");
      } catch (error) {
        this.cleanupErrors.push(error);
        this.dependencies.store.lost(parked.sessionId, turnId, `Live harness cleanup failed: ${String(error)}`);
      }
    }
    this.parked.clear();
    if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, "Harness cleanup was incomplete");
  }
}
