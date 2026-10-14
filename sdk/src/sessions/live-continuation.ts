import { randomUUID } from "node:crypto";
import type { Session, SessionConfig, SessionEvent, PermissionDecision, PermissionRequest } from "./index.js";
import type { ContinuationDescriptor, ContinuationEffects, ContinuationHarness, RecordedCallResult, SegmentOutcome } from "./continuations.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A live permission callback is retained, never represented as a durable snapshot. */
export class LiveContinuation implements ContinuationHarness {
  readonly approvalContinuation = "live" as const;
  private readonly epoch = randomUUID();
  private session!: Session;
  private boundary = deferred<SegmentOutcome>();
  private emit?: (event: SessionEvent) => Promise<void>;
  private readonly calls = new Map<string, PermissionRequest>();
  private readonly resultWaiters = new Map<string, { result: ReturnType<typeof deferred<RecordedCallResult>>; committed: ReturnType<typeof deferred<void>> }>();
  private readonly requests = new Map<string, ReturnType<typeof deferred<PermissionDecision>>>();
  private readonly seenProposals = new Set<string>();
  private reader?: Promise<void>;
  private closed = false;
  private failed?: string;
  private streamedText = "";

  private constructor(private readonly adapterId: string, private readonly fingerprint: string) {}

  static async open(adapterId: string, fingerprint: string, config: SessionConfig, start: (config: SessionConfig) => Promise<Session>): Promise<LiveContinuation> {
    const handle = new LiveContinuation(adapterId, fingerprint);
    handle.session = await start({ ...config, decide: (request) => handle.review(request) });
    handle.reader = handle.read();
    return handle;
  }

  validate(continuation: ContinuationDescriptor): void {
    const payload = continuation.payload as { epoch?: string; callId?: string } | null;
    if (continuation.format !== "barry.live.permission" || continuation.version !== 1 || continuation.adapterId !== this.adapterId
      || continuation.configFingerprint !== this.fingerprint || payload?.epoch !== this.epoch || !payload.callId || !this.requests.has(payload.callId)) {
      throw new Error("Live approval continuation was lost; the original harness is required");
    }
  }

  async begin(content: string, emit: (event: SessionEvent) => Promise<void>, conversation?: ContinuationDescriptor): Promise<SegmentOutcome> {
    if (this.closed) throw new Error("Live harness is closed");
    if (conversation && (conversation.format !== "barry.live.history" || conversation.adapterId !== this.adapterId || conversation.configFingerprint !== this.fingerprint)) throw new Error("Incompatible live conversation history");
    this.emit = emit;
    await this.session.deliver(content);
    return this.boundary.promise;
  }

  private async review(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.closed || this.failed) return { allow: false, reason: this.failed ?? "Harness closed" };
    if (this.requests.has(request.id)) return { allow: false, reason: "Harness reused a pending call identity" };
    // Serialise permission callbacks, including parallel native proposals. Each
    // boundary covers every interrupt that has been published in that segment.
    while (this.requests.size) {
      await Promise.all([...this.requests.values()].map((request) => request.promise));
      if (this.closed) return { allow: false, reason: "Harness closed" };
    }
    const decision = deferred<PermissionDecision>();
    this.calls.set(request.id, request); this.requests.set(request.id, decision);
    if (!this.seenProposals.has(request.id)) {
      this.seenProposals.add(request.id);
      await this.emit?.({ type: "tool_use", id: request.id, tool: request.tool, input: request.input });
    }
    this.boundary.resolve({ type: "interrupted", calls: [request], continuation: {
      format: "barry.live.permission", version: 1, adapterId: this.adapterId, adapterVersion: "live-v1",
      harnessVersion: this.session.harnessVersion ?? "unknown", configFingerprint: this.fingerprint,
      payload: { epoch: this.epoch, callId: request.id },
    } });
    return decision.promise;
  }

  async restore(continuation: ContinuationDescriptor, decisions: ReadonlyMap<string, PermissionDecision>, effects: ContinuationEffects, emit: (event: SessionEvent) => Promise<void>): Promise<SegmentOutcome> {
    this.validate(continuation);
    const id = (continuation.payload as { callId: string }).callId;
    const request = this.calls.get(id)!;
    if (decisions.size !== 1 || !decisions.has(id)) throw new Error("Resolve the complete live approval boundary");
    this.boundary = deferred<SegmentOutcome>(); this.emit = emit; this.streamedText = "";
    const pending = this.requests.get(id)!;
    let decision = decisions.get(id)!;
    if (decision.allow) decision = await effects.authorize(request);
    if (!decision.allow) {
      const outcome: RecordedCallResult = { id, result: decision.reason ?? "Denied by Barry policy", error: true };
      await effects.denied?.(request, outcome);
      this.requests.delete(id); pending.resolve(decision);
    } else {
      const waiter = { result: deferred<RecordedCallResult>(), committed: deferred<void>() }; this.resultWaiters.set(id, waiter);
      try {
        const outcome = await effects.execute(request, async () => {
          this.requests.delete(id); pending.resolve({ allow: true });
          return waiter.result.promise;
        });
        await emit({ type: "tool_result", id: outcome.id, result: outcome.result, ...(outcome.error === undefined ? {} : { error: outcome.error }) });
      } finally {
        waiter.committed.resolve(); this.resultWaiters.delete(id);
      }
    }
    return this.boundary.promise;
  }

  private async read(): Promise<void> {
    let result: unknown; let error: string | undefined;
    try {
      for await (const event of this.session.events()) {
        if (event.type === "partial") this.streamedText += event.text;
        if (event.type === "text" && event.role !== "user") {
          if (!event.text.startsWith(this.streamedText)) throw new Error("Harness final text differs from the published stream");
          const remainder = event.text.slice(this.streamedText.length);
          this.streamedText = event.text;
          if (remainder) await this.emit?.({ type: "partial", text: remainder });
          continue;
        }
        if (event.type === "tool_use") {
          if (this.seenProposals.has(event.id)) continue;
          this.seenProposals.add(event.id);
        }
        if (event.type === "permission_request" || event.type === "init" || event.type === "status") continue;
        if (event.type === "tool_result" && event.id) {
          const waiter = this.resultWaiters.get(event.id);
          if (waiter) {
            waiter.result.resolve({ id: event.id, result: event.result, ...(event.error === undefined ? {} : { error: event.error }) });
            await waiter.committed.promise;
            continue;
          }
        }
        if (event.type === "result") { result = event.structured ?? event.result; error = event.error; }
        if (event.type === "error") error = event.error;
        if (event.type === "done") {
          if (this.resultWaiters.size) {
            for (const waiter of this.resultWaiters.values()) waiter.result.reject(new Error("Harness completed without a correlated tool outcome"));
          }
          this.boundary.resolve(error ? { type: "failed", error } : { type: "completed", ...(result === undefined ? {} : { result }),
            ...(this.session.harnessSessionId ? { conversation: {
              format: "barry.live.history", version: 1, adapterId: this.adapterId, adapterVersion: "live-v1",
              harnessVersion: this.session.harnessVersion ?? "unknown", configFingerprint: this.fingerprint,
              payload: { harnessSessionId: this.session.harnessSessionId },
            } } : {}),
          });
          result = undefined; error = undefined;
          continue;
        }
        await this.emit?.(event);
      }
      if (!this.closed) throw new Error("Harness event stream ended unexpectedly");
    } catch (failure) {
      this.failed = failure instanceof Error ? failure.message : String(failure);
      for (const waiter of this.resultWaiters.values()) waiter.result.reject(failure);
      for (const request of this.requests.values()) request.resolve({ allow: false, reason: this.failed });
      this.requests.clear();
      this.boundary.resolve({ type: "failed", error: this.failed });
    }
  }

  async interrupt(): Promise<void> {
    this.emit = undefined;
    for (const request of this.requests.values()) request.resolve({ allow: false, reason: "Turn interrupted" });
    this.requests.clear();
    await this.session.interrupt();
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.emit = undefined;
    for (const request of this.requests.values()) request.resolve({ allow: false, reason: "Harness closed" });
    this.requests.clear();
    for (const waiter of this.resultWaiters.values()) { waiter.result.reject(new Error("Harness closed before tool outcome")); waiter.committed.resolve(); }
    await this.session.close(); await this.reader;
  }
}
