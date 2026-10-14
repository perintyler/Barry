import { ActivityFailure, PayloadLimit, encode, type Activity, type ActivityTask, type Outcome, type OwnerConnection, type WorkerAdvertisement } from "./types.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WorkerCredentialRejected } from "./worker-client.js";

interface Execution {
  connection: OwnerConnection; task: ActivityTask; abort: AbortController;
  nextHeartbeat: number; outcome?: Outcome; rejected: boolean; maintaining: boolean;
}

export class ActivityWorker {
  private readonly executions = new Map<string, Execution>();
  private stopped = false;
  private draining = false;
  private readonly lanes = new Set<OwnerConnection>();
  private readonly requests = new Map<OwnerConnection, string>();
  private readonly nextPoll = new Map<OwnerConnection, number>();
  private readonly nextAdvertisement = new Map<OwnerConnection, number>();
  private readonly failures = new Map<OwnerConnection, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private reserved = 0;
  private cursor = 0;
  constructor(private readonly options: {
    connections: OwnerConnection[]; activities: Record<string, Activity>; capacity?: number;
    labels?: WorkerAdvertisement["labels"]; now?: () => number;
    artifacts?: Record<string, string>;
    onError?: (error: unknown) => void;
  }) {
    if (!Number.isInteger(options.capacity ?? 4) || (options.capacity ?? 4) < 1 || (options.capacity ?? 4) > 1000) throw new Error("invalid worker capacity");
    if (options.connections.length > 16) throw new Error("owner connection limit is 16");
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    // Slow claims on one owner must not starve leases held on another.
    const maintenance = [...this.executions.entries()].map(([token, execution]) => this.track((async () => {
      if (execution.maintaining) return;
      execution.maintaining = true;
      const at = (this.options.now ?? (() => performance.now()))();
      try {
        if (execution.rejected) {
          if (execution.outcome) {
            if (execution.connection.settlePhysical) await execution.connection.settlePhysical(token);
            else await execution.connection.complete(token, execution.outcome);
            this.executions.delete(token);
          }
        } else if (execution.outcome) {
          await execution.connection.complete(token, execution.outcome);
          this.executions.delete(token);
        } else if (at >= execution.nextHeartbeat) {
          const live = await execution.connection.heartbeat(token);
          execution.nextHeartbeat = at + execution.task.heartbeatMs;
          if (!live) { execution.rejected = true; execution.abort.abort(); }
        }
      } catch (error) {
        // A revoked worker can neither heartbeat nor report: stop the effect now
        // and forget the attempt; the owner retries it when its lease expires.
        if (error instanceof WorkerCredentialRejected) { execution.rejected = true; execution.abort.abort(); this.executions.delete(token); }
        this.options.onError?.(error);
      }
      finally { execution.maintaining = false; }
    })()));
    // Yield to ready acknowledgements without coupling every owner's progress to one hung RPC.
    await Promise.race([Promise.all(maintenance), new Promise(resolve => setTimeout(resolve, 5))]);
    if (this.stopped || this.draining) return;
    const connections = this.options.connections, claims: Promise<void>[] = [];
    for (let offset = 0; offset < connections.length; offset++) {
      const connection = connections[(this.cursor + offset) % connections.length];
      if (this.lanes.has(connection) || (this.nextPoll.get(connection) ?? 0) > performance.now()) continue;
      this.lanes.add(connection);
      claims.push(this.track((async () => {
        try {
          const capacity = this.options.capacity ?? 4;
          const occupied = [...this.executions.values()].filter(execution => execution.connection === connection && !execution.rejected).length;
          if ((this.nextAdvertisement.get(connection) ?? 0) <= performance.now()) {
            await connection.advertise({ types: Object.keys(this.options.activities), labels: this.options.labels ?? {}, artifacts: this.options.artifacts ?? {}, capacity: Math.max(0, capacity - this.executions.size - this.reserved + occupied) });
            this.nextAdvertisement.set(connection, performance.now() + 5000);
          }
          if (!this.stopped && !this.draining && this.executions.size + this.reserved < capacity) {
            this.reserved++;
            try {
              const requestId = this.requests.get(connection) ?? randomUUID();
              this.requests.set(connection, requestId);
              const claimStarted = performance.now();
              const task = await connection.claim(requestId);
              this.failures.delete(connection);
              if (!task) { this.requests.delete(connection); this.nextPoll.set(connection, performance.now() + 250); return; }
              if (this.stopped || this.draining || (task.artifact && this.options.artifacts?.[task.type] !== task.artifact)) { await connection.decline?.(task.token); this.requests.delete(connection); return; }
              // A receipt can outlive its lease. Never perform an effect from a recovered
              // claim until the owner confirms that this session still holds authority.
              if (!await connection.heartbeat(task.token)) { this.requests.delete(connection); return; }
              task.timeoutMs = Math.floor(task.timeoutMs - (performance.now() - claimStarted));
              if (task.timeoutMs <= 0) { await connection.decline?.(task.token); this.requests.delete(connection); return; }
              if (this.stopped || this.draining) { await connection.decline?.(task.token); return; }
              const execution: Execution = { connection, task, abort: new AbortController(), nextHeartbeat: (this.options.now ?? (() => performance.now()))() + task.heartbeatMs, rejected: false, maintaining: false };
              this.executions.set(task.token, execution);
              this.requests.delete(connection);
              void this.track(this.execute(execution));
            } finally { this.reserved--; }
          }
        } catch (error) { const failures = Math.min(5, (this.failures.get(connection) ?? 0) + 1); this.failures.set(connection, failures); this.nextPoll.set(connection, performance.now() + Math.min(5000, 250 * 2 ** failures)); this.options.onError?.(error); }
        finally { this.lanes.delete(connection); }
      })()));
    }
    this.cursor = connections.length ? (this.cursor + 1) % connections.length : 0;
    // A caller that awaits tick() must still be able to maintain healthy owners
    // while another lane is waiting on its transport deadline.
    await Promise.race([Promise.all(claims), new Promise(resolve => setTimeout(resolve, 5))]);
  }

  stop(): void {
    this.stopped = true;
    for (const execution of this.executions.values()) execution.abort.abort();
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  /** False means the transport/executor did not quiesce: caller must not close its store under callbacks. */
  async drain(timeoutMs = 30_000): Promise<boolean> {
    this.draining = true;
    const end = performance.now() + timeoutMs, abortAt = end - Math.min(1000, timeoutMs / 2);
    while (performance.now() < end) {
      if (performance.now() >= abortAt) for (const execution of this.executions.values()) execution.abort.abort();
      await this.tick();
      if (!this.executions.size && !this.pending.size && !this.lanes.size) { this.stopped = true; return true; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.stop();
    return false;
  }

  private async execute(execution: Execution): Promise<void> {
    const timeout = setTimeout(() => execution.abort.abort(), Math.min(execution.task.timeoutMs, 2_147_483_647));
    timeout.unref();
    try {
      const activity = this.options.activities[execution.task.type];
      if (!activity) throw new ActivityFailure("activity is not registered", "UnknownActivity");
      const value = await activity(execution.task.input, { ...execution.task, signal: execution.abort.signal });
      execution.outcome = { ok: true, value: JSON.parse(encode(value)) };
    } catch (error) {
      const supplied = error instanceof Error && "activityOutcome" in error ? error.activityOutcome : null;
      if (supplied && typeof supplied === "object" && "ok" in supplied && supplied.ok === false) {
        execution.outcome = supplied as Outcome;
        return;
      }
      execution.outcome = { ok: false, error: {
        code: error instanceof PayloadLimit ? "ResultTooLarge" : error instanceof ActivityFailure ? error.code.slice(0, 200) || "ActivityFailed" : "ActivityFailed",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
        retryable: !(error instanceof ActivityFailure) && !(error instanceof PayloadLimit),
      } };
    } finally { clearTimeout(timeout); }
  }
}
