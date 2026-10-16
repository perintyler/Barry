import { performance } from "node:perf_hooks";
import { ExecutorJournal } from "./executor-journal.js";
import { executionBindingSchema, executorFeaturesSchema } from "./work-contracts.js";
import type { WorkExecutionObservation, WorkExecutionReceipt } from "./work-execution.js";
import type { connectWorkOwnerV3 } from "./protocol.js";
import type { ActivityTask, WorkerAdvertisement } from "./types.js";
import { WorkerCredentialRejected } from "./worker-client.js";
import type { z } from "zod";

export type WorkOwnerConnection = ReturnType<typeof connectWorkOwnerV3>;
export type WorkExecutorFamily = "process" | "structured-agent";
type Binding = z.infer<typeof executionBindingSchema>;

/** Native custody belongs to the concrete supervisor; this loop owns durable
 * assignments, online owner authority and receipt delivery for one family. */
export interface WorkActivitySupervisor {
  readonly bootIdentity: string;
  start(task: ActivityTask): Promise<WorkExecutionObservation>;
  resumeValidation(binding: Binding): Promise<WorkExecutionObservation | null>;
  recoverReceipt(binding: Binding): WorkExecutionReceipt | null;
  inspect(binding: Binding): { observation: WorkExecutionObservation | null; receipt: WorkExecutionReceipt | null };
  owns(binding: Binding): boolean;
  occupiedCount(owner?: string): number;
  leaseLost(owner: string): void;
  cancel(binding: Binding): WorkExecutionObservation;
  close(): Promise<void>;
}
const bindingOf = (start: z.infer<typeof executionBindingSchema>) => executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, start[key as keyof typeof start]])));

/** Service loop for common work only. No direct-execution or legacy completion fallback.
 * The supplied clients and artifact preparation are authenticated installation adapters. */
export class WorkActivityWorker {
  private readonly inflight = new Set<Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly retired = new Set<string>();
  private readonly recoveryCursor = new Map<string, number>();
  private readonly advertisedAt = new Map<string, number>();
  private readonly advertisedCapacity = new Map<string, number>();
  private reserved = 0;
  private readonly preparing = new Set<string>();
  private stopping = false;
  private closing = false;
  private readonly executor: WorkExecutorFamily;
  constructor(private readonly options: {
    connections: { owner: string; client: WorkOwnerConnection }[];
    journal: ExecutorJournal;
    supervisor: WorkActivitySupervisor;
    /** Omitted for the existing portable process adapter. */
    executor?: WorkExecutorFamily;
    advertisement: Omit<WorkerAdvertisement, "capacity">;
    features: () => z.input<typeof executorFeaturesSchema>;
    prepare: (task: ActivityTask) => Promise<void>;
    capacity?: number;
    onError?: (error: unknown) => void;
  }) {
    this.executor = options.executor ?? "process";
    if (this.executor !== "process" && this.executor !== "structured-agent")
      throw new Error("unsupported common worker executor family");
    if (!Number.isInteger(options.capacity ?? 4) || (options.capacity ?? 4) < 1 || (options.capacity ?? 4) > 100)
      throw new Error("invalid common worker capacity");
    if (options.connections.length > 16 || new Set(options.connections.map(connection => connection.owner)).size !== options.connections.length)
      throw new Error("common worker requires at most 16 distinct owners");
  }
  private nextConnection = 0;
  async tick(): Promise<void> {
    if (this.closing) return;
    const pending: Promise<void>[] = [];
    const connections = this.options.connections;
    const first = this.nextConnection++ % connections.length;
    for (let index = 0; index < connections.length; index++) {
      const connection = connections[(first + index) % connections.length];
      if (this.busy.has(connection.owner) || this.retired.has(connection.owner)) continue;
      this.busy.add(connection.owner);
      const turn = this.turn(connection.owner, connection.client).catch(error => {
        if (error instanceof WorkerCredentialRejected) {
          this.retired.add(connection.owner);
          this.options.supervisor.leaseLost(connection.owner);
        }
        this.options.onError?.(error);
      }).finally(() => { this.busy.delete(connection.owner); this.inflight.delete(turn); });
      this.inflight.add(turn); pending.push(turn);
    }
    await Promise.race([Promise.all(pending), new Promise<void>(resolve => setTimeout(resolve, 5))]);
  }
  private async turn(owner: string, client: WorkOwnerConnection): Promise<void> {
    const journal = this.options.journal, supervisor = this.options.supervisor, capacity = this.options.capacity ?? 4;
    // Each failed delivery advances a durable fair cursor; unrelated receipts still repair.
    const visited = new Set<string>();
    for (let count = 0; count < 8; count++) {
      const delivery = journal.nextDelivery(owner);
      if (!delivery || visited.has(delivery.receipt.receipt_ref)) break;
      visited.add(delivery.receipt.receipt_ref);
      try {
        const ack = await client.complete(delivery.receipt.attempt_id, delivery.receipt);
        journal.acknowledgeDelivery(delivery.binding, delivery.receipt.receipt_digest, ack.status);
      } catch (error) {
        if (error instanceof WorkerCredentialRejected) throw error;
        this.options.onError?.(error);
      }
    }
    const page = journal.unfinished(owner, this.recoveryCursor.get(owner) ?? 0);
    this.recoveryCursor.set(owner, page.cursor);
    for (const entry of page.entries) {
      if (entry.start) this.assertExecutor(entry.start);
      try {
        if (supervisor.recoverReceipt(entry.binding)) continue;
        if (!supervisor.owns(entry.binding)) {
          if (entry.observation.physical_state === "not-started") supervisor.cancel(entry.binding);
          else if (entry.observation.physical_state === "ceased" && entry.observation.effect_certainty === "known") {
            const state = await client.inspect(entry.binding.attempt_id);
            if (state.stop_requested || !await client.heartbeat(entry.binding.attempt_id)) {
              supervisor.cancel(entry.binding); supervisor.recoverReceipt(entry.binding);
            } else if (supervisor.occupiedCount() + this.reserved < capacity) {
              this.reserved++; this.preparing.add(owner);
              try { await supervisor.resumeValidation(entry.binding); }
              finally { this.preparing.delete(owner); this.reserved--; }
            }
          } else {
            const observed = journal.markGuardianLost(entry.binding);
            await client.observe(entry.binding.attempt_id, observed);
          }
          continue; // Unknown stages receive no lease renewal or replacement launch.
        }
        const state = await client.inspect(entry.binding.attempt_id);
        if (state.stop_requested || !await client.heartbeat(entry.binding.attempt_id)) supervisor.cancel(entry.binding);
        const current = supervisor.inspect(entry.binding);
        if (current.observation && !current.receipt) await client.observe(entry.binding.attempt_id, current.observation);
      } catch (error) {
        if (entry.start?.effect_policy.class !== "pure" && supervisor.owns(entry.binding)) supervisor.cancel(entry.binding);
        if (error instanceof WorkerCredentialRejected) throw error;
        this.options.onError?.(error);
      }
    }
    if (this.stopping) {
      const inbox = journal.claimInbox(owner);
      // Repair an already retained assignment without acquiring another one.
      // An unconfirmed claim key stays durable: replaying claim here could
      // create a new assignment if its first request never reached the owner.
      const start = inbox?.permit ?? inbox?.task?.work;
      if (inbox && start) {
        this.assertExecutor(start);
        const binding = bindingOf(start);
        if (!journal.inspect(binding)) supervisor.cancel(binding);
        if (journal.inspect(binding)) journal.clearClaim(owner, inbox.request_id);
      }
      return;
    }
    // In-flight empty probes serialize local claims, but are not assigned work.
    // Advertising them as occupancy can repeatedly erase another owner's offer
    // between its advertisement and claim. Acquired tasks and pipelines count.
    const available = Math.max(0, capacity - supervisor.occupiedCount() - this.preparing.size + supervisor.occupiedCount(owner) + (this.preparing.has(owner) ? 1 : 0));
    if ((this.advertisedAt.get(owner) ?? 0) <= performance.now() || this.advertisedCapacity.get(owner) !== available) {
      const features = executorFeaturesSchema.parse({ ...this.options.features(), requires_validation_declaration: true });
      if (!features.features.includes("declared-validation") || features.boot_identity !== supervisor.bootIdentity)
        throw new Error("common worker requires truthful declared-validation and boot capabilities");
      if (features.containment !== "portable" || features.executors.length !== 1 || features.executors[0] !== this.executor)
        throw new Error("this worker only advertises its selected qualified portable executor family");
      await client.advertise({ ...this.options.advertisement,
        capacity: available }, features);
      this.advertisedCapacity.set(owner, available);
      this.advertisedAt.set(owner, performance.now() + 5000);
    }
    if (this.stopping || supervisor.occupiedCount() + this.reserved >= capacity) return;
    this.reserved++;
    try {
      const requestId = journal.prepareClaim(owner);
      let inbox = journal.claimInbox(owner)!;
      if (!inbox.task) {
        const claimed = await client.claim(requestId);
        if (!claimed) { journal.clearClaim(owner, requestId); return; }
        journal.retainClaim(owner, requestId, claimed);
        inbox = journal.claimInbox(owner)!;
      }
      const task = inbox.task!;
      this.assertExecutor(task.work);
      this.preparing.add(owner);
      if (!inbox.permit) {
        const state = await client.inspect(task.token);
        if (state.stop_requested || !await client.heartbeat(task.token)) {
          supervisor.cancel(bindingOf(state.observation)); journal.clearClaim(owner, requestId); return;
        }
        await this.options.prepare(task);
        if (this.stopping) {
          supervisor.cancel(bindingOf(task.work!)); journal.clearClaim(owner, requestId); return;
        }
        journal.retainPermit(owner, await client.begin(task.token));
        inbox = journal.claimInbox(owner)!;
      }
      const start = inbox.permit!, binding = bindingOf(start);
      this.assertExecutor(start);
      if (this.stopping || !await client.effect(task.token)) supervisor.cancel(binding);
      else await supervisor.start({ ...task, work: start });
      if (journal.inspect(binding)) journal.clearClaim(owner, requestId);
    } finally { this.preparing.delete(owner); this.reserved--; }
  }
  private assertExecutor(start: ActivityTask["work"]): void {
    const resource = this.executor === "structured-agent" ? "agent" : "process";
    if (!start || start.resources.executor !== resource)
      throw new Error("common worker assignment differs from its selected executor family");
  }
  async close(): Promise<void> { this.closing = true; this.stopping = true; await this.options.supervisor.close(); await Promise.allSettled([...this.inflight]); }
  stopClaims(): void { this.stopping = true; }
}
