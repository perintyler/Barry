import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  statSync,
  statfsSync,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  fchmodSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import {
  executionBindingSchema,
  workNamespaceSchema,
  workReceiptSchema,
} from "./work-contracts.js";
import { workReceiptDigest } from "./executor-journal.js";
import { WorkflowError } from "./errors.js";
import { encodeEnvelope } from "./types.js";

const ref = z.string().min(1).max(200),
  amount = z.number().int().nonnegative();
const bindingSchema = executionBindingSchema.omit({ deadline: true });
export const workResourceRequestSchema = z
  .strictObject({
    version: z.literal(2),
    binding: bindingSchema,
    namespace: workNamespaceSchema,
    resource: ref,
    pool: z.enum(["agent", "process", "tool", "model"]),
    lane: z.enum(["unscheduled", "scheduled", "internal"]),
    input_tokens: amount.default(0),
    output_tokens: amount.default(0),
    cost_micros: amount.default(0),
    reserve_before: z.number().int().nonnegative(),
  })
  .refine(
    (request) => request.binding.owner === request.namespace.installation,
    "resource owner differs from authority installation",
  );
export type WorkResourceRequest = z.infer<typeof workResourceRequestSchema>;
const hostSchema = z.strictObject({
  kind: z.literal("host"),
  agents: z
    .strictObject({
      unscheduled: amount.default(16),
      scheduled: amount.default(4),
      per_caller: amount.default(4),
    })
    .default({ unscheduled: 16, scheduled: 4, per_caller: 4 }),
  processes: z
    .strictObject({ unscheduled: amount.default(16), scheduled: amount.default(4) })
    .default({ unscheduled: 16, scheduled: 4 }),
  guarded: amount.default(8),
});
const endpointSchema = z.strictObject({
  kind: z.literal("endpoint"),
  concurrency: z.number().int().positive(),
  input_tokens: amount,
  output_tokens: amount,
  cost_micros: amount,
});
export const workResourceLimitsSchema = z
  .record(ref, z.discriminatedUnion("kind", [hostSchema, endpointSchema]))
  .refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100,
    "broker must own 1..100 resources",
  );
export type WorkResourceLimits = z.input<typeof workResourceLimitsSchema>;
export interface WorkResourceReservation {
  reservation: string;
  resource: string;
  revision: number;
  state: "held" | "unknown" | "released";
  request: WorkResourceRequest;
  created_at: number;
  receipt_digest: string | null;
}

/** Private host/endpoint-owning arbiter. Authenticated adapters supply trusted grants and receipt evidence. */
export class WorkResourceBroker {
  readonly id: string;
  private db!: SqliteDatabase;
  private uncertain = false;
  private readonly limits: z.infer<typeof workResourceLimitsSchema>;
  constructor(
    private readonly options: {
      path: string;
      broker: string;
      limits: WorkResourceLimits;
      now?: () => number;
    },
  ) {
    if (!isAbsolute(options.path)) throw new Error("resource broker path must be absolute");
    ref.parse(options.broker);
    this.id = options.broker;
    this.limits = workResourceLimitsSchema.parse(options.limits);
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.open(true);
  }
  resourceKind(resource: string): "host" | "endpoint" | undefined {
    return this.limits[resource]?.kind;
  }
  private open(initialize: boolean): void {
    for (const path of [
      this.options.path,
      `${this.options.path}-wal`,
      `${this.options.path}-shm`,
    ]) {
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("resource broker must be a private owned regular file");
      }
    }
    const descriptor = openSync(
      this.options.path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
    const db = new SqliteDatabase(this.options.path);
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 1 || (!initialize && version !== 1))
        throw new Error("unsupported resource broker schema");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50");
      if (initialize) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS resource_meta(broker TEXT PRIMARY KEY,limits_digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS resource_reservations(
            reservation TEXT PRIMARY KEY,resource TEXT NOT NULL,owner TEXT NOT NULL,attempt TEXT NOT NULL,pool TEXT NOT NULL,lane TEXT NOT NULL,caller TEXT NOT NULL,
            request TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,receipt_digest TEXT,
            input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cost_micros INTEGER NOT NULL,
            UNIQUE(resource,owner,attempt));
          CREATE INDEX IF NOT EXISTS resource_occupancy ON resource_reservations(resource,state,pool,lane,caller);
          CREATE TRIGGER IF NOT EXISTS resource_request_immutable BEFORE UPDATE OF reservation,resource,owner,attempt,pool,lane,caller,request,input_tokens,output_tokens,cost_micros ON resource_reservations
            BEGIN SELECT RAISE(ABORT,'resource reservation binding is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS resource_release_immutable BEFORE UPDATE ON resource_reservations WHEN OLD.state='released'
            BEGIN SELECT RAISE(ABORT,'settled resource evidence is immutable'); END;
          PRAGMA user_version=1;`);
        const previous = db.prepare("SELECT * FROM resource_meta").get();
        if (
          previous &&
          (previous.broker !== this.options.broker ||
            previous.limits_digest !== boundFingerprint(this.limits))
        )
          throw new Error(
            "resource broker identity or limits changed; explicit drain/reconfiguration is required",
          );
        db.prepare("INSERT OR IGNORE INTO resource_meta VALUES(?,?)").run(
          this.options.broker,
          boundFingerprint(this.limits),
        );
        db.exec("COMMIT");
      } else {
        const meta = db.prepare("SELECT * FROM resource_meta").get();
        if (
          meta?.broker !== this.options.broker ||
          meta?.limits_digest !== boundFingerprint(this.limits)
        )
          throw new Error("resource broker identity/limits changed");
      }
      this.db = db;
      this.uncertain = false;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Original fault. */
      }
      db.close();
      throw error;
    }
  }
  private recover(): void {
    if (this.uncertain) {
      if (this.db.isOpen) this.db.close();
      this.open(false);
    }
  }
  private transaction<T>(body: () => T): T {
    this.recover();
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const result = body();
      committing = true;
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      let rolledBack = false;
      try {
        this.db.exec("ROLLBACK");
        rolledBack = true;
      } catch {
        /* Preserve fault. */
      }
      this.uncertain = committing || (!rolledBack && this.db.isTransaction);
      throw error;
    }
  }
  private decode(row: Record<string, unknown>): WorkResourceReservation {
    return {
      reservation: String(row.reservation),
      resource: String(row.resource),
      revision: Number(row.revision),
      state: z.enum(["held", "unknown", "released"]).parse(row.state),
      request: workResourceRequestSchema.parse(JSON.parse(String(row.request))),
      created_at: Number(row.created_at),
      receipt_digest: row.receipt_digest === null ? null : String(row.receipt_digest),
    };
  }
  lookup(input: WorkResourceRequest): WorkResourceReservation | null {
    this.recover();
    const request = workResourceRequestSchema.parse(input);
    const row = this.db
      .prepare("SELECT * FROM resource_reservations WHERE resource=? AND owner=? AND attempt=?")
      .get(request.resource, request.binding.owner, request.binding.attempt_id);
    if (!row) return null;
    const reservation = this.decode(row);
    if (boundFingerprint(reservation.request) !== boundFingerprint(request))
      throw new WorkflowError(
        "ResourceConflict",
        "Reservation key identifies different execution or budgets.",
        409,
      );
    return reservation;
  }
  acquire(inputs: WorkResourceRequest[]): WorkResourceReservation[] {
    const requests = z.array(workResourceRequestSchema).min(1).max(2).parse(inputs);
    if (new Set(requests.map((request) => request.resource)).size !== requests.length)
      throw new Error("resource batch contains duplicates");
    return this.transaction(() =>
      requests.map((request) => {
        const existing = this.db
          .prepare("SELECT * FROM resource_reservations WHERE resource=? AND owner=? AND attempt=?")
          .get(request.resource, request.binding.owner, request.binding.attempt_id);
        if (existing) {
          const reservation = this.decode(existing);
          if (boundFingerprint(reservation.request) !== boundFingerprint(request))
            throw new WorkflowError(
              "ResourceConflict",
              "Reservation key identifies different execution or budgets.",
              409,
            );
          return reservation;
        }
        const now = (this.options.now ?? Date.now)();
        if (request.reserve_before <= now)
          throw new WorkflowError(
            "ResourceDeadlineExpired",
            "Resource reservation deadline expired.",
            409,
          );
        const limits = this.limits[request.resource];
        if (!limits)
          throw new WorkflowError("ResourceUnavailable", "Broker does not own this resource.", 409);
        const count = (condition: string, ...values: string[]) =>
          Number(
            this.db
              .prepare(
                `SELECT count(*) n FROM resource_reservations WHERE resource=? AND state!='released' AND ${condition}`,
              )
              .get(request.resource, ...values)?.n,
          );
        const caller = boundFingerprint([
          request.namespace.installation,
          request.namespace.principal_kind,
          request.namespace.principal_id,
          request.namespace.caller_session_id,
        ]);
        let full = false;
        if (limits.kind === "host") {
          if (request.input_tokens || request.output_tokens || request.cost_micros)
            throw new WorkflowError(
              "ResourceBudgetInvalid",
              "Host reservations cannot declare inference allowances.",
              409,
            );
          const lane = request.lane === "scheduled" ? "scheduled" : "unscheduled";
          const condition = lane === "scheduled" ? "lane='scheduled'" : "lane!='scheduled'";
          if (request.pool === "agent")
            full =
              count(`pool='agent' AND ${condition}`) >= limits.agents[lane] ||
              count("pool='agent' AND caller=?", caller) >= limits.agents.per_caller;
          else if (request.pool === "process")
            full = count(`pool='process' AND ${condition}`) >= limits.processes[lane];
          else full = count("pool IN ('tool','model')") >= limits.guarded;
        } else {
          const totals = this.db
            .prepare(
              "SELECT count(*) n,coalesce(sum(input_tokens),0) i,coalesce(sum(output_tokens),0) o,coalesce(sum(cost_micros),0) c FROM resource_reservations WHERE resource=? AND state!='released'",
            )
            .get(request.resource)!;
          full =
            Number(totals.n) >= limits.concurrency ||
            Number(totals.i) + request.input_tokens > limits.input_tokens ||
            Number(totals.o) + request.output_tokens > limits.output_tokens ||
            Number(totals.c) + request.cost_micros > limits.cost_micros;
        }
        if (full)
          throw new WorkflowError(
            "ResourceBusy",
            "Aggregate physical or endpoint allowance is occupied.",
            429,
            true,
          );
        const disk = statfsSync(dirname(this.options.path)),
          size =
            statSync(this.options.path).size +
            (existsSync(`${this.options.path}-wal`)
              ? statSync(`${this.options.path}-wal`).size
              : 0);
        if (size > 858993459 || disk.bavail * disk.bsize < 268435456 + 16384)
          throw new WorkflowError(
            "ResourceStoragePressure",
            "Broker cannot retain reservation evidence.",
            503,
            true,
          );
        if (
          Number(this.db.prepare("SELECT count(*) n FROM resource_reservations").get()?.n) >=
          1000000
        )
          throw new WorkflowError(
            "ResourceRetentionQuota",
            "Broker retention quota requires explicit archival.",
            429,
          );
        const id = `res_${randomUUID()}`;
        this.db
          .prepare(
            "INSERT INTO resource_reservations VALUES(?,?,?,?,?,?,?,?,1,'held',?,NULL,?,?,?)",
          )
          .run(
            id,
            request.resource,
            request.binding.owner,
            request.binding.attempt_id,
            request.pool,
            request.lane,
            caller,
            encodeEnvelope(request),
            now,
            request.input_tokens,
            request.output_tokens,
            request.cost_micros,
          );
        return this.decode(
          this.db.prepare("SELECT * FROM resource_reservations WHERE reservation=?").get(id)!,
        );
      }),
    );
  }
  inspect(reservation: string): WorkResourceReservation | null {
    this.recover();
    ref.parse(reservation);
    const row = this.db
      .prepare("SELECT * FROM resource_reservations WHERE reservation=?")
      .get(reservation);
    return row ? this.decode(row) : null;
  }
  markUnknown(reservation: string): WorkResourceReservation {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM resource_reservations WHERE reservation=?")
        .get(ref.parse(reservation));
      if (!row) throw new WorkflowError("ResourceNotFound", "Reservation is unavailable.", 404);
      if (row.state === "held")
        this.db
          .prepare(
            "UPDATE resource_reservations SET state='unknown',revision=revision+1 WHERE reservation=?",
          )
          .run(reservation);
      return this.decode(
        this.db
          .prepare("SELECT * FROM resource_reservations WHERE reservation=?")
          .get(reservation)!,
      );
    });
  }
  settle(reservation: string, input: z.infer<typeof workReceiptSchema>): WorkResourceReservation {
    const receipt = workReceiptSchema.parse(input),
      { receipt_digest, ...unsigned } = receipt;
    if (workReceiptDigest(unsigned) !== receipt_digest)
      throw new WorkflowError(
        "ResourceReceiptInvalid",
        "Receipt digest differs from evidence.",
        409,
      );
    if (!["ceased", "not-started"].includes(receipt.physical_state))
      throw new WorkflowError(
        "ResourceSettlementUnknown",
        "Unproven physical settlement cannot release capacity.",
        409,
      );
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM resource_reservations WHERE reservation=?")
        .get(ref.parse(reservation));
      if (!row) throw new WorkflowError("ResourceNotFound", "Reservation is unavailable.", 404);
      const current = this.decode(row),
        binding = bindingSchema.parse(
          Object.fromEntries(
            Object.keys(bindingSchema.shape).map((key) => [
              key,
              receipt[key as keyof typeof receipt],
            ]),
          ),
        );
      if (boundFingerprint(current.request.binding) !== boundFingerprint(binding))
        throw new WorkflowError(
          "ResourceReceiptConflict",
          "Settlement evidence belongs to another execution.",
          409,
        );
      if (current.state === "released") {
        if (current.receipt_digest !== receipt_digest)
          throw new WorkflowError(
            "ResourceReceiptConflict",
            "Settlement evidence is immutable.",
            409,
          );
        return current;
      }
      this.db
        .prepare(
          "UPDATE resource_reservations SET state='released',receipt_digest=?,revision=revision+1 WHERE reservation=?",
        )
        .run(receipt_digest, reservation);
      return this.decode(
        this.db
          .prepare("SELECT * FROM resource_reservations WHERE reservation=?")
          .get(reservation)!,
      );
    });
  }
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
