import type { WorkflowStore } from "./workflow-store.js";
import type { WorkAdmission } from "./work-contracts.js";
import { executionBindingSchema, workReceiptSchema } from "./work-contracts.js";
import type { WorkExecutionStart, WorkExecutionReceipt } from "./work-execution.js";
import {
  workResourceRequestSchema,
  type WorkResourceRequest,
  type WorkResourceReservation,
} from "./work-resource-broker.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { WorkflowError } from "./errors.js";
import { encodeEnvelope } from "./types.js";
import { workReceiptDigest } from "./executor-journal.js";

/** Trusted synchronous local arbiters. Remote transport adapters require an async acquisition driver. */
export interface WorkResourceArbiter {
  readonly id: string;
  resourceKind(resource: string): "host" | "endpoint" | undefined;
  acquire(requests: WorkResourceRequest[]): WorkResourceReservation[];
  lookup(request: WorkResourceRequest): WorkResourceReservation | null;
  settle(reservation: string, receipt: WorkExecutionReceipt): WorkResourceReservation;
}
export interface WorkResourceExecutionOptions {
  host: (work: WorkAdmission, worker: string) => { broker: string; resource: string };
  brokers: ReadonlyMap<string, WorkResourceArbiter>;
}
interface Intent {
  token: string;
  run_id: string;
  role: "host" | "endpoint";
  broker: string;
  request: string;
  reservation: string | null;
  settlement: string | null;
}

/** Acquisition intents commit with claim; broker acknowledgements commit with the start permit. */
export class OwnerWorkResources {
  constructor(
    private readonly store: Pick<WorkflowStore, "rows" | "run" | "transaction">,
    private readonly options: WorkResourceExecutionOptions | undefined,
    private readonly reserve: (run: string, bytes: number) => void,
  ) {}
  private rows(token: string): Intent[] {
    return this.store.rows<Intent>(
      "SELECT * FROM workflow_work_resource_intents WHERE token=? ORDER BY role DESC",
      token,
    );
  }
  private broker(id: string): WorkResourceArbiter {
    const broker = this.options?.brokers.get(id);
    if (!broker || broker.id !== id)
      throw new WorkflowError(
        "WorkResourcesUnavailable",
        "Required resource arbiter is unavailable.",
        409,
      );
    return broker;
  }
  bind(work: WorkAdmission, worker: string, start: WorkExecutionStart): void {
    if (!this.options) return; // Claims remain inspectable; begin fails closed without resource authority.
    const host = this.options.host(work, worker);
    const { deadline: _deadline, ...binding } = executionBindingSchema.parse(
      Object.fromEntries(
        Object.keys(executionBindingSchema.shape).map((key) => [
          key,
          start[key as keyof WorkExecutionStart],
        ]),
      ),
    );
    const base = {
      version: 2 as const,
      binding,
      namespace: work.namespace,
      lane: start.resources.lane,
      reserve_before: start.deadline,
    };
    const intents: { role: "host" | "endpoint"; broker: string; request: WorkResourceRequest }[] = [
      {
        role: "host" as const,
        broker: host.broker,
        request: workResourceRequestSchema.parse({
          ...base,
          resource: host.resource,
          pool: start.resources.executor,
        }),
      },
    ];
    if (start.resources.endpoint) {
      const endpoint = start.resources.endpoint;
      intents.push({
        role: "endpoint",
        broker: endpoint.broker,
        request: workResourceRequestSchema.parse({
          ...base,
          resource: endpoint.endpoint,
          pool: "model",
          input_tokens: endpoint.max_input_tokens,
          output_tokens: endpoint.max_output_tokens,
          cost_micros: Math.ceil(endpoint.max_cost * 1_000_000),
        }),
      });
    }
    for (const intent of intents) {
      if (this.broker(intent.broker).resourceKind(intent.request.resource) !== intent.role)
        throw new WorkflowError(
          "WorkResourcePlacementInvalid",
          "Resource arbiter does not own the required host or endpoint kind.",
          409,
        );
      const request = encodeEnvelope(intent.request);
      this.reserve(start.workflow_id, Buffer.byteLength(request) + 512);
      this.store.run(
        "INSERT INTO workflow_work_resource_intents(token,run_id,role,broker,request) VALUES(?,?,?,?,?)",
        start.attempt_id,
        start.workflow_id,
        intent.role,
        intent.broker,
        request,
      );
    }
  }
  acquire(start: WorkExecutionStart): WorkExecutionStart["resources"] {
    const intents = this.rows(start.attempt_id);
    if (
      !intents.some((row) => row.role === "host") ||
      (start.resources.endpoint && !intents.some((row) => row.role === "endpoint"))
    )
      throw new WorkflowError(
        "WorkResourcesUnavailable",
        "Launch requires durable physical resource acquisition intents.",
        409,
      );
    const resources = structuredClone(start.resources);
    for (const row of intents) {
      const request = workResourceRequestSchema.parse(JSON.parse(row.request));
      const held = this.broker(row.broker).acquire([request])[0];
      if (
        !held ||
        held.state !== "held" ||
        boundFingerprint(held.request) !== boundFingerprint(request) ||
        (row.reservation !== null && row.reservation !== held.reservation)
      )
        throw new WorkflowError(
          "WorkResourceFenced",
          "Resource acknowledgement is uncertain, released or mismatched.",
          409,
        );
      this.store.run(
        "UPDATE workflow_work_resource_intents SET reservation=? WHERE token=? AND role=?",
        held.reservation,
        row.token,
        row.role,
      );
      if (row.role === "host") resources.host_reservation = held.reservation;
      else resources.endpoint!.reservation = held.reservation;
    }
    return resources;
  }
  assertHeld(token: string): void {
    const rows = this.rows(token);
    if (!rows.some((row) => row.role === "host"))
      throw new WorkflowError(
        "WorkResourcesUnavailable",
        "Physical resource authority is unavailable.",
        409,
      );
    for (const row of rows) {
      const held = this.broker(row.broker).lookup(
        workResourceRequestSchema.parse(JSON.parse(row.request)),
      );
      if (!held || held.state !== "held" || held.reservation !== row.reservation)
        throw new WorkflowError(
          "WorkResourceFenced",
          "Physical or endpoint capacity no longer authorizes effects.",
          409,
        );
    }
  }
  /** Persist the proof before any external settlement. Retry/restart resumes from identical evidence. */
  prepareSettlement(token: string, receipt: WorkExecutionReceipt): void {
    if (!["ceased", "not-started"].includes(receipt.physical_state)) return;
    for (const row of this.rows(token)) {
      if (row.settlement === null)
        this.reserve(row.run_id, Buffer.byteLength(encodeEnvelope(receipt)));
      this.store.run(
        "UPDATE workflow_work_resource_intents SET settlement=coalesce(settlement,?) WHERE token=? AND role=?",
        encodeEnvelope(receipt),
        row.token,
        row.role,
      );
    }
  }
  reconcile(limit = 64, token?: string): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("invalid resource recovery budget");
    const rows = this.store.rows<Intent>(
      "SELECT * FROM workflow_work_resource_intents WHERE settlement IS NOT NULL AND reconciled=0 AND (? IS NULL OR token=?) ORDER BY recovery_visits,token,role LIMIT ?",
      token ?? null, token ?? null, limit,
    );
    let settled = 0;
    const errors: unknown[] = [];
    for (const row of rows) {
      // Persist progress before contacting an arbiter: repeated crashes or failures
      // cannot keep a leading batch ahead of unrelated repair across restart.
      this.store.transaction(() => this.store.run(
        "UPDATE workflow_work_resource_intents SET recovery_visits=recovery_visits+1 WHERE token=? AND role=?",
        row.token, row.role,
      ));
      try {
        const broker = this.broker(row.broker),
          request = workResourceRequestSchema.parse(JSON.parse(row.request));
        const held = broker.lookup(request);
        if (held)
          broker.settle(held.reservation, workReceiptSchema.parse(JSON.parse(row.settlement!)));
        else if (row.reservation !== null)
          throw new WorkflowError(
            "WorkResourceEvidenceMissing",
            "Acknowledged reservation is missing from the arbiter.",
            409,
          );
        this.store.transaction(() =>
          this.store.run(
            "UPDATE workflow_work_resource_intents SET reconciled=1 WHERE token=? AND role=?",
            row.token,
            row.role,
          ),
        );
        settled++;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Resource settlement recovery incomplete: ${errors[0] instanceof Error ? errors[0].message : String(errors[0])}`,
      );
    return settled;
  }
  /** Only an unactivated, durably fenced reservation proves no authorized physical launch. */
  prepareUnlaunched(runId?: string): void {
    const rows = this.store.rows<{
      token: string;
      request: string;
      settled_at: number;
    }>(
      `SELECT e.token,e.request,a.settled_at
      FROM workflow_work_executions e JOIN workflow_attempts a ON a.token=e.token
      WHERE (? IS NULL OR e.run_id=?) AND json_extract(e.request,'$.launch_authorized')=0 AND a.physical_state='settled' AND a.settled_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM workflow_work_resource_intents i WHERE i.token=e.token AND i.settlement IS NULL) LIMIT 64`,
      runId ?? null,
      runId ?? null,
    );
    for (const row of rows) {
      const start = JSON.parse(row.request) as WorkExecutionStart;
      const binding = executionBindingSchema.parse(
        Object.fromEntries(
          Object.keys(executionBindingSchema.shape).map((key) => [
            key,
            start[key as keyof WorkExecutionStart],
          ]),
        ),
      );
      const unsigned = {
        ...binding,
        receipt_ref: `unlaunched-${row.token}`,
        revision: 1,
        committed_at: row.settled_at,
        physical_state: "not-started" as const,
        effect_certainty: "not-started" as const,
        outcome: "cancelled" as const,
        stages: [],
        output: null,
        summary: "Launch reservation durably fenced before authorization.",
        validation: "skipped" as const,
        validation_failures: null,
      };
      this.prepareSettlement(
        row.token,
        workReceiptSchema.parse({ ...unsigned, receipt_digest: workReceiptDigest(unsigned) }),
      );
    }
  }
}
