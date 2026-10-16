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
  fsyncSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import {
  executionBindingSchema,
  executorStartSchema,
  executorObservationSchema,
  stageReceiptSchema,
  workArtifactSchema,
  workReceiptSchema,
  logicalStageEffectKey,
  workCommandReportSchema,
} from "./work-contracts.js";
import { WorkflowError } from "./errors.js";
import { encodeEnvelope } from "./types.js";
import { type WorkArtifactStore, type WorkArtifactRef } from "./work-artifacts.js";
import { workTaskSchema } from "./protocol.js";
import type { ActivityTask } from "./types.js";

type Binding = z.infer<typeof executionBindingSchema>;
type Start = z.infer<typeof executorStartSchema>;
type Observation = z.infer<typeof executorObservationSchema>;
type StageReceipt = z.infer<typeof stageReceiptSchema>;
type Receipt = z.infer<typeof workReceiptSchema>;
type Stage = StageReceipt["stage"];
type Handle = NonNullable<Observation["handle"]>;
interface Entry {
  binding: Binding;
  request: Start | null;
  observation: Observation;
  fence: number;
}
const stages: Stage[] = ["preflight", "execution", "validation", "postcondition", "publication"];
const publicationMetadataSchema = z.strictObject({
  summary: workReceiptSchema.shape.summary,
  validation: workReceiptSchema.shape.validation,
  validation_failures: workReceiptSchema.shape.validation_failures,
});
function conflict(message: string): never {
  throw new WorkflowError("ExecutorBindingConflict", message, 409);
}
export function workReceiptDigest(receipt: Omit<Receipt, "receipt_digest">): string {
  return boundFingerprint(receipt);
}

/**
 * Private executor-local durable evidence. Only an authenticated executor boundary
 * may call this store. It grants one launch permit after an intent commit; adapters
 * must recheck online authority before claiming and cannot retry a lost permit.
 * Physical supervision and result spooling are deliberately separate adapters.
 */
export class ExecutorJournal {
  private db!: SqliteDatabase;
  private uncertain = false;
  constructor(
    private readonly options: {
      path: string;
      installation: string;
      now?: () => number;
      artifacts?: WorkArtifactStore;
    },
  ) {
    if (!isAbsolute(options.path)) throw new Error("executor journal path must be absolute");
    if (!options.installation || Buffer.byteLength(options.installation) > 200)
      throw new Error("invalid executor installation");
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.open(true);
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
          throw new Error("executor journal must be a private owned regular file");
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
      if (version > 5 || (!initialize && version !== 5))
        throw new Error("unsupported executor journal version");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50");
      if (initialize) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS executor_meta(installation TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS executions(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,
            binding TEXT NOT NULL,request TEXT,observation TEXT NOT NULL,fence INTEGER NOT NULL,
            PRIMARY KEY(owner,workflow,activity));
          CREATE TABLE IF NOT EXISTS execution_stages(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,stage TEXT NOT NULL,
            effect_key TEXT NOT NULL,intent_at INTEGER NOT NULL,handle TEXT,receipt TEXT,
            PRIMARY KEY(owner,workflow,activity,stage));
          CREATE TABLE IF NOT EXISTS execution_receipts(
            receipt_ref TEXT PRIMARY KEY,owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,
            revision INTEGER NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,
            UNIQUE(owner,workflow,activity,revision));
          CREATE TABLE IF NOT EXISTS execution_late_evidence(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,digest TEXT NOT NULL,
            receipt TEXT NOT NULL,observed_at INTEGER NOT NULL,current_fence INTEGER NOT NULL,
            PRIMARY KEY(owner,workflow,activity,digest));
          CREATE TABLE IF NOT EXISTS execution_stage_outputs(
            owner TEXT NOT NULL,workflow TEXT NOT NULL,activity TEXT NOT NULL,stage TEXT NOT NULL,
            reference TEXT NOT NULL,PRIMARY KEY(owner,workflow,activity,stage));
          CREATE TABLE IF NOT EXISTS execution_deliveries(
            receipt_ref TEXT PRIMARY KEY REFERENCES execution_receipts(receipt_ref),
            acknowledged TEXT,visits INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS execution_delivery_pending ON execution_deliveries(visits,receipt_ref) WHERE acknowledged IS NULL;
          CREATE TRIGGER IF NOT EXISTS execution_delivery_ack_immutable BEFORE UPDATE OF acknowledged ON execution_deliveries
            WHEN OLD.acknowledged IS NOT NULL AND OLD.acknowledged IS NOT NEW.acknowledged
            BEGIN SELECT RAISE(ABORT,'receipt acknowledgement is immutable'); END;
          CREATE TABLE IF NOT EXISTS execution_claim_inbox(
            owner TEXT PRIMARY KEY,request_id TEXT NOT NULL,task TEXT,permit TEXT);
          CREATE TRIGGER IF NOT EXISTS execution_stage_output_immutable BEFORE UPDATE ON execution_stage_outputs
            BEGIN SELECT RAISE(ABORT,'stage output is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_binding_immutable BEFORE UPDATE OF binding ON executions
            BEGIN SELECT RAISE(ABORT,'execution binding is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_request_immutable BEFORE UPDATE OF request ON executions
            WHEN OLD.request IS NOT NULL BEGIN SELECT RAISE(ABORT,'execution request is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_receipt_immutable BEFORE UPDATE ON execution_receipts
            BEGIN SELECT RAISE(ABORT,'execution receipt is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_stage_receipt_immutable BEFORE UPDATE OF receipt ON execution_stages
            WHEN OLD.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'stage receipt is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS execution_late_evidence_immutable BEFORE UPDATE ON execution_late_evidence
            BEGIN SELECT RAISE(ABORT,'late executor evidence is immutable'); END;
          CREATE UNIQUE INDEX IF NOT EXISTS execution_attempt_binding ON executions(owner,workflow,json_extract(binding,'$.activity_id'),json_extract(binding,'$.attempt_id'));
          INSERT OR IGNORE INTO execution_deliveries(receipt_ref) SELECT receipt_ref FROM execution_receipts;
          PRAGMA user_version=5;`);
        const previous = db.prepare("SELECT installation FROM executor_meta").get();
        if (previous && previous.installation !== this.options.installation)
          throw new Error("executor journal belongs to another installation");
        db.prepare("INSERT OR IGNORE INTO executor_meta VALUES(?)").run(this.options.installation);
        if (version < 3) {
          // Upgrade old journals before declaring the spool ownership boundary.
          // Streaming keeps memory bounded; failure leaves the old schema version
          // and any already-created pins intact for the next repair attempt.
          for (const row of db.prepare("SELECT receipt FROM execution_stages WHERE receipt IS NOT NULL UNION ALL SELECT receipt FROM execution_receipts UNION ALL SELECT receipt FROM execution_late_evidence").iterate()) {
            const retained = JSON.parse(String(row.receipt));
            for (const reference of retained.stages ? [retained.output, ...retained.stages.map((stage: StageReceipt) => stage.result)] : [retained.result])
              if (reference) this.verifyOutput(reference);
          }
        }
        db.exec("COMMIT");
      } else if (
        db.prepare("SELECT installation FROM executor_meta").get()?.installation !==
        this.options.installation
      )
        throw new Error("executor journal installation differs");
      this.db = db;
      this.uncertain = false;
      const directory = openSync(dirname(this.options.path), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Original open error. */
      }
      db.close();
      throw error;
    }
  }
  private recover(): void {
    if (!this.uncertain) return;
    if (this.db.isOpen) this.db.close();
    try {
      this.open(false);
    } catch {
      throw new WorkflowError(
        "ExecutorJournalUnavailable",
        "Executor evidence is unavailable; do not relaunch.",
        503,
        true,
      );
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
        /* Preserve original fault. */
      }
      this.uncertain = committing || (!rolledBack && this.db.isTransaction);
      throw error;
    }
  }
  private key(binding: Binding): [string, string, string] {
    const row = this.db
      .prepare(
        "SELECT activity FROM executions WHERE owner=? AND workflow=? AND json_extract(binding,'$.activity_id')=? AND json_extract(binding,'$.attempt_id')=?",
      )
      .get(binding.owner, binding.workflow_id, binding.activity_id, binding.attempt_id);
    if (row) return [binding.owner, binding.workflow_id, String(row.activity)];
    const prior = this.db
      .prepare(
        "SELECT 1 FROM executions WHERE owner=? AND workflow=? AND json_extract(binding,'$.activity_id')=?",
      )
      .get(binding.owner, binding.workflow_id, binding.activity_id);
    return [
      binding.owner,
      binding.workflow_id,
      prior ? encodeEnvelope([binding.activity_id, binding.attempt_id]) : binding.activity_id,
    ];
  }
  private assertRetry(request: Start): void {
    const rows = this.db
      .prepare(
        "SELECT binding,request,fence,activity,observation FROM executions WHERE owner=? AND workflow=? AND json_extract(binding,'$.activity_id')=? ORDER BY json_extract(binding,'$.execution_fence') DESC",
      )
      .all(request.owner, request.workflow_id, request.activity_id);
    if (!rows.length) {
      if (request.retry_from)
        conflict("Retry proof has no retained prior execution on this executor.");
      return;
    }
    if (!request.retry_from)
      conflict("Logical activity already binds another attempt; verified retry proof is required.");
    const policy = request.effect_policy;
    if (
      (policy.class !== "pure" && policy.class !== "repeatable") ||
      rows.length >= policy.max_attempts ||
      request.resources.endpoint !== null
    )
      conflict(
        "Declared retry policy or accounted resource budget does not authorize another attempt.",
      );
    const first = this.db
      .prepare(
        "SELECT min(s.intent_at) at FROM execution_stages s JOIN executions e USING(owner,workflow,activity) WHERE e.owner=? AND e.workflow=? AND json_extract(e.binding,'$.activity_id')=?",
      )
      .get(request.owner, request.workflow_id, request.activity_id)?.at;
    if (
      first === null ||
      first === undefined ||
      request.retry_from.retry_deadline > Number(first) + policy.retry_budget_ms
    )
      conflict("Retry deadline exceeds the original elapsed retry budget.");
    const prior = executorStartSchema.parse(JSON.parse(String(rows[0].request)));
    const receipt = this.receipt(
      executionBindingSchema.parse(
        Object.fromEntries(
          Object.keys(executionBindingSchema.shape).map((key) => [key, prior[key as keyof Start]]),
        ),
      ),
    );
    const stable = (value: Start) =>
      Object.fromEntries(
        Object.keys(executionBindingSchema.shape)
          .filter((key) => !["attempt_id", "execution_fence", "deadline"].includes(key))
          .map((key) => [key, value[key as keyof Start]]),
      );
    if (receipt) {
      const { receipt_digest, ...unsigned } = receipt;
      if (workReceiptDigest(unsigned) !== receipt_digest)
        conflict("Retained retry evidence digest differs.");
    }
    if (
      !receipt ||
      receipt.outcome !== "failed" ||
      !receipt.failure?.retryable ||
      receipt.validation === "failed" ||
      receipt.validation === "unknown" ||
      receipt.physical_state !== "ceased" ||
      receipt.effect_certainty !== "known" ||
      receipt.stages.some((stage) => stage.state === "unknown") ||
      receipt.stages.some((stage) => stage.stage === "execution" && stage.state === "passed") ||
      ["InvalidOutput", "ValidationFailed", "SchemaError"].includes(receipt.failure.code) ||
      executorObservationSchema.parse(JSON.parse(String(rows[0].observation))).cancel_requested ||
      prior.resources.endpoint !== null ||
      request.resources.executor !== prior.resources.executor ||
      request.resources.lane !== prior.resources.lane ||
      request.resources.logical_reservation !== prior.resources.logical_reservation ||
      request.executor_generation !== prior.executor_generation ||
      request.retry_from.attempt_id !== prior.attempt_id ||
      request.retry_from.receipt_digest !== receipt.receipt_digest ||
      request.retry_from.attempt_number !== rows.length + 1 ||
      request.execution_fence <= Math.max(...rows.map((row) => Number(row.fence))) ||
      boundFingerprint(stable(request)) !== boundFingerprint(stable(prior)) ||
      boundFingerprint(request.effect_policy) !== boundFingerprint(prior.effect_policy) ||
      boundFingerprint(request.inputs) !== boundFingerprint(prior.inputs) ||
      request.activity_type !== prior.activity_type ||
      request.output_identity !== prior.output_identity ||
      boundFingerprint(request.validation ?? null) !== boundFingerprint(prior.validation ?? null) ||
      request.budget_deadline !== (prior.budget_deadline ?? prior.deadline) ||
      request.deadline > request.budget_deadline ||
      request.deadline > request.retry_from.retry_deadline ||
      this.now() >= request.retry_from.retry_deadline ||
      (prior.retry_from && prior.retry_from.retry_deadline !== request.retry_from.retry_deadline)
    )
      conflict(
        "Retry evidence does not prove the same bounded execution with settled known failure.",
      );
    for (const row of rows) {
      const binding = executionBindingSchema.parse(JSON.parse(String(row.binding))),
        result = this.receipt(binding);
      if (
        !result ||
        !["ceased", "not-started"].includes(result.physical_state) ||
        result.effect_certainty === "uncertain"
      )
        conflict("An earlier attempt remains unsettled or uncertain.");
    }
  }
  private entry(binding: Binding, command: boolean): Entry | undefined {
    binding = executionBindingSchema.parse(binding);
    const row = this.db
      .prepare("SELECT * FROM executions WHERE owner=? AND workflow=? AND activity=?")
      .get(...this.key(binding));
    if (!row) return;
    const stored = executionBindingSchema.parse(JSON.parse(String(row.binding)));
    if (boundFingerprint(binding) !== boundFingerprint(stored))
      conflict("Logical activity already binds another attempt, source, grant or deadline.");
    if (command && binding.execution_fence < Number(row.fence))
      throw new WorkflowError(
        "StaleExecutionFence",
        "Execution command is fenced; inspect existing evidence.",
        409,
      );
    return {
      binding: stored,
      request:
        row.request === null ? null : executorStartSchema.parse(JSON.parse(String(row.request))),
      observation: executorObservationSchema.parse(JSON.parse(String(row.observation))),
      fence: Number(row.fence),
    };
  }
  private required(binding: Binding, command = true): Entry {
    return this.entry(binding, command) ?? conflict("Execution intent is not recorded.");
  }
  private update(entry: Entry, patch: Partial<Observation>): Observation {
    const observation = executorObservationSchema.parse({
      ...entry.observation,
      ...patch,
      revision: entry.observation.revision + 1,
      observed_at: this.now(),
    });
    this.db
      .prepare("UPDATE executions SET observation=? WHERE owner=? AND workflow=? AND activity=?")
      .run(encodeEnvelope(observation), ...this.key(entry.binding));
    return observation;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private verifyOutput(reference: WorkArtifactRef | null): void {
    if (!reference) return;
    if (!this.options.artifacts)
      throw new WorkflowError(
        "ExecutorArtifactUnavailable",
        "Receipt output needs a durable executor artifact store.",
        503,
      );
    this.options.artifacts.retainExecutor(reference);
  }
  private create(binding: Binding, request: Start | null, cancelled: boolean): Observation {
    const observation = executorObservationSchema.parse({
      ...binding,
      revision: 1,
      observed_at: this.now(),
      stage: cancelled ? "terminal" : "intent",
      physical_state: "not-started",
      effect_certainty: "not-started",
      cancel_requested: cancelled,
      reason: null,
      receipt_ref: null,
      handle: null,
    });
    this.db
      .prepare("INSERT INTO executions VALUES(?,?,?,?,?,?,?)")
      .run(
        ...this.key(binding),
        encodeEnvelope(binding),
        request ? encodeEnvelope(request) : null,
        encodeEnvelope(observation),
        binding.execution_fence,
      );
    return observation;
  }
  start(input: Start): Observation {
    const request = executorStartSchema.parse(input),
      binding = executionBindingSchema.parse(
        Object.fromEntries(
          Object.keys(executionBindingSchema.shape).map((key) => [
            key,
            request[key as keyof Start],
          ]),
        ),
      );
    if (!request.launch_authorized)
      throw new WorkflowError(
        "WorkLaunchUnauthorized",
        "A reservation is not an executor start permit.",
        409,
      );
    return this.transaction(() => {
      const previous = this.entry(binding, true);
      if (previous) {
        if (previous.request && boundFingerprint(previous.request) !== boundFingerprint(request))
          conflict("Start redelivery changes immutable executor inputs or policy.");
        return previous.observation;
      }
      this.assertRetry(request);
      if (request.deadline <= this.now())
        throw new WorkflowError(
          "ExecutionDeadlineExpired",
          "Execution deadline has expired before start.",
          409,
        );
      const disk = statfsSync(dirname(this.options.path));
      const bytes =
        statSync(this.options.path).size +
        (existsSync(`${this.options.path}-wal`) ? statSync(`${this.options.path}-wal`).size : 0);
      const unsettled = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM executions WHERE json_extract(observation,'$.receipt_ref') IS NULL OR json_extract(observation,'$.physical_state') NOT IN ('ceased','not-started')",
          )
          .get()?.n,
      );
      const reserved = (unsettled + 1) * 1048576 + Buffer.byteLength(encodeEnvelope(request));
      if (bytes + reserved >= 858993459 || disk.bavail * disk.bsize < 268435456 + reserved)
        throw new WorkflowError(
          "ExecutorStoragePressure",
          "Executor cannot reserve durable launch evidence.",
          503,
          true,
        );
      if (Number(this.db.prepare("SELECT count(*) n FROM executions").get()?.n) >= 100000)
        throw new WorkflowError(
          "ExecutorRetentionQuota",
          "Executor evidence quota is exhausted.",
          429,
        );
      return this.create(binding, request, false);
    });
  }
  inspect(binding: Binding): Observation | null {
    this.recover();
    return this.entry(binding, false)?.observation ?? null;
  }
  cancel(binding: Binding, commandFence = binding.execution_fence): Observation {
    binding = executionBindingSchema.parse(binding);
    if (!Number.isSafeInteger(commandFence) || commandFence < binding.execution_fence)
      conflict("Cancellation fence is invalid.");
    return this.transaction(() => {
      const previous = this.entry(binding, false);
      if (!previous) {
        const observation = this.create(binding, null, true);
        this.db
          .prepare("UPDATE executions SET fence=? WHERE owner=? AND workflow=? AND activity=?")
          .run(commandFence, ...this.key(binding));
        return observation;
      }
      if (commandFence < previous.fence)
        throw new WorkflowError("StaleExecutionFence", "Cancellation command is fenced.", 409);
      this.db
        .prepare(
          "UPDATE executions SET fence=max(fence,?) WHERE owner=? AND workflow=? AND activity=?",
        )
        .run(commandFence, ...this.key(binding));
      if (
        (previous.observation.receipt_ref &&
          ["ceased", "not-started"].includes(previous.observation.physical_state)) ||
        previous.observation.cancel_requested
      )
        return previous.observation;
      return this.update(previous, {
        cancel_requested: true,
        physical_state:
          previous.observation.physical_state === "running"
            ? "stopping"
            : previous.observation.physical_state,
      });
    });
  }
  /** Fences mutations without treating a lost lease as physical cessation. */
  fence(binding: Binding, next: number): Observation {
    if (!Number.isSafeInteger(next) || next <= binding.execution_fence)
      conflict("New execution fence must increase.");
    return this.transaction(() => {
      const previous = this.required(binding, false);
      this.db
        .prepare(
          "UPDATE executions SET fence=max(fence,?) WHERE owner=? AND workflow=? AND activity=?",
        )
        .run(next, ...this.key(binding));
      return previous.observation;
    });
  }
  /** Exactly one committed claim may launch a stage. A lost return value is uncertainty. */
  claimStage(binding: Binding, stage: Stage): { launch: boolean; observation: Observation } {
    stageReceiptSchema.shape.stage.parse(stage);
    if (stage === "publication")
      conflict(
        "Publication uses atomic retained-result publishing, not an external launch permit.",
      );
    return this.transaction(() => {
      const previous = this.required(binding);
      const observation = previous.observation;
      if (observation.receipt_ref || observation.cancel_requested)
        return { launch: false, observation };
      if (!previous.request) conflict("Cancelled intent has no executable request.");
      const old = this.db
        .prepare(
          "SELECT receipt FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND stage=?",
        )
        .get(...this.key(binding), stage);
      if (old) return { launch: false, observation };
      if (binding.deadline <= this.now())
        throw new WorkflowError(
          "ExecutionDeadlineExpired",
          "Original execution deadline has expired.",
          409,
        );
      const incomplete = this.db
        .prepare(
          "SELECT stage FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND receipt IS NULL",
        )
        .get(...this.key(binding));
      if (incomplete)
        conflict("An earlier stage may still be executing; reconcile it before another launch.");
      if (observation.effect_certainty === "uncertain")
        conflict("An earlier stage has uncertain effects; reconcile before further execution.");
      const later = this.db
        .prepare("SELECT stage FROM execution_stages WHERE owner=? AND workflow=? AND activity=?")
        .all(...this.key(binding));
      if (later.some((row) => stages.indexOf(String(row.stage) as Stage) >= stages.indexOf(stage)))
        conflict("Execution stages cannot move backward.");
      this.db
        .prepare("INSERT INTO execution_stages VALUES(?,?,?,?,?,?,NULL,NULL)")
        .run(
          ...this.key(binding),
          stage,
          logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, stage),
          this.now(),
        );
      return {
        launch: true,
        observation: this.update(previous, {
          stage: "launching",
          physical_state: "unknown",
          effect_certainty: "uncertain",
          handle: null,
        }),
      };
    });
  }
  recordHandle(binding: Binding, stage: Stage, handle: Handle): Observation {
    handle = executorObservationSchema.shape.handle.unwrap().parse(handle);
    if (handle.kind !== "provider" && handle.installation !== this.options.installation)
      conflict("Executor handle belongs to another installation.");
    return this.transaction(() => {
      const previous = this.required(binding);
      const row = this.db
        .prepare(
          "SELECT handle,receipt FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND stage=?",
        )
        .get(...this.key(binding), stage);
      if (!row) conflict("Stage launch intent is missing.");
      if (row.handle !== null) {
        if (boundFingerprint(JSON.parse(String(row.handle))) !== boundFingerprint(handle))
          conflict("Stage execution handle cannot change.");
        return previous.observation;
      }
      if (previous.observation.receipt_ref)
        conflict("Terminal handle evidence requires audited reconciliation.");
      if (row.receipt !== null) conflict("Completed stage cannot receive a new execution handle.");
      this.db
        .prepare(
          "UPDATE execution_stages SET handle=? WHERE owner=? AND workflow=? AND activity=? AND stage=?",
        )
        .run(encodeEnvelope(handle), ...this.key(binding), stage);
      return this.update(previous, {
        stage,
        handle,
        physical_state: previous.observation.cancel_requested ? "stopping" : "running",
      });
    });
  }
  /** Recheck fencing/stop/deadline after asynchronous online authorization, before input. */
  assertStageInput(binding: Binding, stage: Stage, handle: Handle): void {
    this.recover();
    const entry = this.required(binding);
    const row = this.db.prepare("SELECT handle,receipt FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND stage=?")
      .get(...this.key(binding), stage);
    if (entry.observation.cancel_requested || entry.observation.receipt_ref || binding.deadline <= this.now() ||
      !row || row.receipt !== null || row.handle === null || boundFingerprint(JSON.parse(String(row.handle))) !== boundFingerprint(handle))
      conflict("Stage input is no longer authorized for this process handle.");
  }
  completeStage(
    binding: Binding,
    input: StageReceipt,
    physical: "ceased" | "not-started",
  ): Observation {
    const receipt = stageReceiptSchema.parse(input);
    this.verifyOutput(receipt.result);
    this.verifyOutput(receipt.logs ?? null);
    if (!["ceased", "not-started"].includes(physical))
      conflict("Stage completion requires observed cessation.");
    if (
      receipt.attempt_id !== binding.attempt_id ||
      receipt.effect_key !==
        logicalStageEffectKey(
          binding.owner,
          binding.workflow_id,
          binding.activity_id,
          receipt.stage,
        )
    )
      conflict("Stage receipt binding differs.");
    return this.transaction(() => {
      const previous = this.required(binding);
      const retained = this.retainedStageOutput(binding, receipt.stage);
      if (retained && boundFingerprint(retained) !== boundFingerprint(receipt.result))
        conflict("Completion must reference the retained stage output.");
      const retainedLog = this.retainedStageOutput(binding, receipt.stage, "log");
      if (retainedLog && boundFingerprint(retainedLog) !== boundFingerprint(receipt.logs ?? null)) conflict("Completion must reference the retained stage log.");
      const row = this.db
        .prepare(
          "SELECT receipt FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND stage=?",
        )
        .get(...this.key(binding), receipt.stage);
      if (!row) conflict("Stage launch intent is missing.");
      if (row.receipt !== null) {
        if (boundFingerprint(JSON.parse(String(row.receipt))) !== boundFingerprint(receipt))
          conflict("Stage receipt is immutable.");
        return previous.observation;
      }
      if (previous.observation.receipt_ref)
        conflict("Terminal stage evidence requires audited reconciliation.");
      if (receipt.state === "skipped" && physical !== "not-started")
        conflict("Skipped stage cannot claim a physical execution.");
      if (receipt.state !== "skipped" && physical !== "ceased")
        conflict("Executed stage requires cessation evidence.");
      if (
        receipt.completed_at === null ||
        receipt.started_at === null ||
        receipt.completed_at < receipt.started_at
      )
        conflict("Stage receipt needs ordered execution timestamps.");
      this.db
        .prepare(
          "UPDATE execution_stages SET receipt=? WHERE owner=? AND workflow=? AND activity=? AND stage=?",
        )
        .run(encodeEnvelope(receipt), ...this.key(binding), receipt.stage);
      const recorded = this.stageReceipts(binding);
      const earlierUnknown = recorded.some((stage) => stage.state === "unknown");
      return this.update(previous, {
        stage: receipt.stage,
        physical_state:
          physical === "not-started" && recorded.some((stage) => stage.state !== "skipped")
            ? "ceased"
            : physical,
        effect_certainty: earlierUnknown ? "uncertain" : "known",
      });
    });
  }
  /** Read retained intent without authorizing another stage or interpreting an outcome. */
  stageIntent(binding: Binding, stage: Stage): { started_at: number; handle: Handle | null; receipt: StageReceipt | null } | null {
    stageReceiptSchema.shape.stage.parse(stage); this.recover(); this.required(binding, false);
    const row = this.db.prepare("SELECT intent_at,handle,receipt FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND stage=?").get(...this.key(binding), stage);
    return row ? { started_at: Number(row.intent_at), handle: row.handle === null ? null : executorObservationSchema.shape.handle.unwrap().parse(JSON.parse(String(row.handle))),
      receipt: row.receipt === null ? null : stageReceiptSchema.parse(JSON.parse(String(row.receipt))) } : null;
  }
  stageReceipts(binding: Binding): StageReceipt[] {
    this.recover();
    this.required(binding, false);
    return this.db
      .prepare(
        "SELECT receipt FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND receipt IS NOT NULL ORDER BY intent_at,stage",
      )
      .all(...this.key(binding))
      .map((row) => stageReceiptSchema.parse(JSON.parse(String(row.receipt))));
  }
  /** Retain bytes independently of cessation; a live/unknown stage must not lose its output.
   * Log slots share the existing artifact table so archived v5 journals retain their format. */
  retainStageOutput(binding: Binding, stage: Stage, reference: WorkArtifactRef, kind: "output" | "log" = "output"): void {
    stageReceiptSchema.shape.stage.parse(stage);
    if (kind === "log") stageReceiptSchema.shape.logs.parse(reference);
    this.verifyOutput(reference);
    this.transaction(() => {
      this.required(binding);
      const intent = this.db.prepare("SELECT 1 FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND stage=?")
        .get(...this.key(binding), stage);
      if (!intent) conflict("Stage output requires a committed launch intent.");
      const previous = this.retainedStageOutput(binding, stage, kind);
      if (previous && boundFingerprint(previous) !== boundFingerprint(reference)) conflict("Retained stage output cannot change.");
      this.db.prepare("INSERT OR IGNORE INTO execution_stage_outputs VALUES(?,?,?,?,?)")
        .run(...this.key(binding), kind === "log" ? `${stage}:log` : stage, encodeEnvelope(reference));
    });
  }
  retainedStageOutput(binding: Binding, stage: Stage, kind: "output" | "log" = "output"): WorkArtifactRef | null {
    this.recover();
    this.required(binding, false);
    const row = this.db.prepare("SELECT reference FROM execution_stage_outputs WHERE owner=? AND workflow=? AND activity=? AND stage=?")
      .get(...this.key(binding), kind === "log" ? `${stage}:log` : stage);
    return row ? workArtifactSchema.parse(JSON.parse(String(row.reference))) : null;
  }
  private validateReceipt(binding: Binding, input: Receipt): Receipt {
    const receipt = workReceiptSchema.parse(input);
    if (
      receipt.outcome === "complete" &&
      receipt.stages.some(
        (stage) =>
          stage.stage !== "publication" &&
          stage.state !== "skipped" &&
          (stage.state === "failed" ||
            stage.completed_at === null ||
            stage.completed_at > receipt.deadline),
      )
    )
      conflict(
        "Completion requires successful effectful evidence within the original execution deadline.",
      );
    this.verifyOutput(receipt.output);
    for (const stage of receipt.stages) { this.verifyOutput(stage.result); this.verifyOutput(stage.logs ?? null); }
    const { receipt_digest, ...unsigned } = receipt;
    if (receipt_digest !== workReceiptDigest(unsigned))
      conflict("Receipt digest differs from retained evidence.");
    const receiptBinding = Object.fromEntries(
      Object.keys(executionBindingSchema.shape).map((key) => [key, receipt[key as keyof Receipt]]),
    );
    if (boundFingerprint(receiptBinding) !== boundFingerprint(binding))
      conflict("Receipt execution binding differs.");
    return receipt;
  }
  commitReceipt(binding: Binding, input: Receipt): Receipt {
    const receipt = this.validateReceipt(binding, input);
    return this.transaction(() => this.applyReceipt(binding, receipt));
  }
  private applyReceipt(binding: Binding, receipt: Receipt): Receipt {
    const { receipt_digest } = receipt;
    const previous = this.required(binding);
    const old = this.db
      .prepare(
        "SELECT receipt FROM execution_receipts WHERE owner=? AND workflow=? AND activity=? ORDER BY revision DESC LIMIT 1",
      )
      .get(...this.key(binding));
    if (old) {
      const stored = workReceiptSchema.parse(JSON.parse(String(old.receipt)));
      if (boundFingerprint(stored) !== boundFingerprint(receipt))
        conflict("Accepted receipt is immutable; late evidence needs audited reconciliation.");
      return stored;
    }
    const observation = previous.observation;
    if (receipt.outcome === "complete" && previous.request?.validation?.mode === "json-schema" && receipt.validation !== "passed")
      conflict("Completion requires the retained declaration's validation verdict.");
    if (receipt.revision !== observation.revision + 1)
      conflict("Receipt does not follow the current observation revision.");
    if (
      receipt.physical_state !== observation.physical_state ||
      receipt.effect_certainty !== observation.effect_certainty
    )
      conflict("Receipt overstates observed physical or effect certainty.");
    if (
      receipt.outcome !== "uncertain" &&
      !["ceased", "not-started"].includes(receipt.physical_state)
    )
      conflict("Terminal receipt requires observed cessation.");
    if (receipt.outcome === "complete" && observation.cancel_requested)
      conflict(
        "Stop intent preceded completion; preserve output in a cancelled or uncertain receipt.",
      );
    const recorded = this.stageReceipts(binding);
    if (receipt.outcome === "complete") for (const stage of ["preflight", "postcondition"] as const)
      if (previous.request?.process_program?.commands?.[stage] && !recorded.some(value => value.stage === stage && value.state === "passed"))
        conflict("Completion requires all declared action command stages.");
    if (
      receipt.output &&
      (receipt.output.purpose !== "output" ||
        !recorded.some(
          (stage) =>
            stage.result && boundFingerprint(stage.result) === boundFingerprint(receipt.output),
        ))
    )
      conflict("Output must reference durable stage evidence.");
    if (
      receipt.outcome === "complete" &&
      !recorded.some((stage) => stage.stage === "execution" && stage.state === "passed")
    )
      conflict("Completion requires a retained successful execution stage.");
    if (
      receipt.validation === "passed" &&
      !recorded.some((stage) => stage.stage === "validation" && stage.state === "passed")
    )
      conflict("Passed validation requires its retained stage receipt.");
    if (
      boundFingerprint(
        [...recorded].sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage)),
      ) !==
      boundFingerprint(
        [...receipt.stages].sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage)),
      )
    )
      conflict("Receipt stage evidence differs from journal.");
    if (
      receipt.outcome !== "uncertain" &&
      this.db
        .prepare(
          "SELECT stage FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND receipt IS NULL",
        )
        .get(...this.key(binding))
    )
      conflict("Unresolved launch intent cannot become a certain terminal receipt.");
    this.db
      .prepare("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?)")
      .run(
        receipt.receipt_ref,
        ...this.key(binding),
        receipt.revision,
        receipt_digest,
        encodeEnvelope(receipt),
      );
    this.update(previous, { stage: "terminal", receipt_ref: receipt.receipt_ref });
    this.db.prepare("INSERT OR IGNORE INTO execution_deliveries(receipt_ref) VALUES(?)").run(receipt.receipt_ref);
    return receipt;
  }
  claimInbox(owner: string): { request_id: string; task: ActivityTask | null; permit: Start | null } | null {
    this.recover();
    const row = this.db.prepare("SELECT * FROM execution_claim_inbox WHERE owner=?").get(owner);
    return row ? { request_id: String(row.request_id), task: row.task === null ? null : workTaskSchema.parse(JSON.parse(String(row.task))),
      permit: row.permit === null ? null : executorStartSchema.parse(JSON.parse(String(row.permit))) } : null;
  }
  prepareClaim(owner: string): string {
    return this.transaction(() => {
      const old = this.claimInbox(owner); if (old) return old.request_id;
      const id = randomUUID();
      this.db.prepare("INSERT INTO execution_claim_inbox(owner,request_id) VALUES(?,?)").run(owner, id);
      return id;
    });
  }
  retainClaim(owner: string, requestId: string, task: ActivityTask): void {
    const parsed = workTaskSchema.parse(task);
    if (parsed.owner !== owner || !parsed.work || parsed.work.owner !== owner) conflict("Claim belongs to another owner.");
    this.transaction(() => {
      const inbox = this.claimInbox(owner);
      if (!inbox || inbox.request_id !== requestId) conflict("Claim request is unavailable.");
      if (inbox.task && boundFingerprint(inbox.task) !== boundFingerprint(parsed)) conflict("Claim response cannot change.");
      this.db.prepare("UPDATE execution_claim_inbox SET task=coalesce(task,?) WHERE owner=?").run(encodeEnvelope(parsed), owner);
    });
  }
  retainPermit(owner: string, permit: Start): void {
    permit = executorStartSchema.parse(permit);
    this.transaction(() => {
      const inbox = this.claimInbox(owner);
      if (!inbox?.task || permit.owner !== owner || permit.attempt_id !== inbox.task.token) conflict("Permit does not match the retained claim.");
      const claim = executorStartSchema.parse(inbox.task.work);
      const stable = (start: Start) => {
        const { deadline: _deadline, budget_deadline: _budget, launch_authorized: _launch, resources, ...immutable } = start;
        const { host_reservation: _host, endpoint, ...host } = resources;
        const endpointRequest = endpoint ? (({ reservation: _reservation, ...request }) => request)(endpoint) : null;
        return { ...immutable, resources: { ...host, endpoint: endpointRequest } };
      };
      if (!permit.launch_authorized || boundFingerprint(stable(claim)) !== boundFingerprint(stable(permit)) ||
        claim.budget_deadline !== undefined && claim.budget_deadline !== permit.budget_deadline)
        conflict("Activation changed immutable claim inputs, authority or resources.");
      if (inbox.permit && boundFingerprint(inbox.permit) !== boundFingerprint(permit)) conflict("Start permit cannot change.");
      this.db.prepare("UPDATE execution_claim_inbox SET permit=coalesce(permit,?) WHERE owner=?").run(encodeEnvelope(permit), owner);
    });
  }
  clearClaim(owner: string, requestId: string): void {
    this.transaction(() => this.db.prepare("DELETE FROM execution_claim_inbox WHERE owner=? AND request_id=?").run(owner, requestId));
  }
  pendingDeliveryCount(owner?: string): number {
    this.recover();
    return Number(this.db.prepare("SELECT count(*) n FROM execution_deliveries d JOIN execution_receipts r USING(receipt_ref) WHERE d.acknowledged IS NULL AND (? IS NULL OR r.owner=?)")
      .get(owner ?? null, owner ?? null)?.n);
  }
  nextDelivery(owner: string): { binding: Binding; receipt: Receipt } | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT e.binding,r.receipt,r.receipt_ref FROM execution_deliveries d JOIN execution_receipts r USING(receipt_ref) JOIN executions e USING(owner,workflow,activity) WHERE d.acknowledged IS NULL AND r.owner=? ORDER BY d.visits,r.receipt_ref LIMIT 1").get(owner);
      if (!row) return null;
      this.db.prepare("UPDATE execution_deliveries SET visits=visits+1 WHERE receipt_ref=?").run(String(row.receipt_ref));
      return { binding: executionBindingSchema.parse(JSON.parse(String(row.binding))), receipt: workReceiptSchema.parse(JSON.parse(String(row.receipt))) };
    });
  }
  acknowledgeDelivery(binding: Binding, digest: string, status: "accepted" | "alreadyAccepted" | "stale"): void {
    z.enum(["accepted", "alreadyAccepted", "stale"]).parse(status);
    this.transaction(() => {
      const receipt = this.receipt(binding);
      if (!receipt || receipt.receipt_digest !== digest) conflict("Acknowledgement differs from the retained receipt.");
      this.db.prepare("UPDATE execution_deliveries SET acknowledged=coalesce(acknowledged,?) WHERE receipt_ref=?")
        .run(status, receipt.receipt_ref);
    });
  }
  occupiedCount(owner?: string): number {
    this.recover();
    return Number(this.db.prepare("SELECT count(*) n FROM executions WHERE (? IS NULL OR owner=?) AND json_extract(observation,'$.physical_state') NOT IN ('ceased','not-started')")
      .get(owner ?? null, owner ?? null)?.n);
  }
  unfinished(owner: string, after = 0, limit = 64): { cursor: number; entries: { binding: Binding; start: Start | null; observation: Observation }[] } {
    this.recover();
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("invalid journal recovery page");
    const rows = this.db.prepare("SELECT rowid cursor,* FROM executions WHERE owner=? AND rowid>? AND json_extract(observation,'$.receipt_ref') IS NULL ORDER BY rowid LIMIT ?").all(owner, after, limit);
    return { cursor: rows.length < limit ? 0 : Number(rows.at(-1)!.cursor), entries: rows.map(row => ({
      binding: executionBindingSchema.parse(JSON.parse(String(row.binding))), start: row.request === null ? null : executorStartSchema.parse(JSON.parse(String(row.request))),
      observation: executorObservationSchema.parse(JSON.parse(String(row.observation))) })) };
  }
  markGuardianLost(binding: Binding): Observation {
    return this.transaction(() => {
      const entry = this.required(binding);
      if (entry.observation.receipt_ref || ["ceased", "not-started"].includes(entry.observation.physical_state)) return entry.observation;
      if (entry.observation.reason?.code === "ExecutorGuardianLost") return entry.observation;
      return this.update(entry, { physical_state: "unknown", effect_certainty: "uncertain", reason: {
        code: "ExecutorGuardianLost", stage: "recovery", since: this.now(), retryable: false,
        detail: "No live guardian owns this execution; reconcile retained evidence without another launch." } });
    });
  }
  retainedStart(binding: Binding): Start | null { this.recover(); return this.required(binding, false).request; }
  /** Local metadata only: no effect callback or launch permit, and no repeated main/validation stage. */
  publishRetainedResult(
    binding: Binding,
    metadata: Pick<Receipt, "summary" | "validation" | "validation_failures">,
  ): Receipt {
    binding = executionBindingSchema.parse(binding);
    metadata = publicationMetadataSchema.parse(metadata);
    return this.transaction(() => {
      const entry = this.required(binding);
      const old = this.receipt(binding);
      if (old) {
        if (
          boundFingerprint({
            summary: old.summary,
            validation: old.validation,
            validation_failures: old.validation_failures,
          }) !== boundFingerprint(metadata)
        )
          conflict("Published metadata is immutable.");
        return old;
      }
      const recorded = this.stageReceipts(binding),
        main = recorded.find((stage) => stage.stage === "execution");
      if (
        !main ||
        !["passed", "failed"].includes(main.state) ||
        entry.observation.effect_certainty !== "known" ||
        entry.observation.physical_state !== "ceased"
      )
        conflict("Publication requires a retained known main result and observed cessation.");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM execution_stages WHERE owner=? AND workflow=? AND activity=? AND receipt IS NULL",
          )
          .get(...this.key(binding))
      )
        conflict("Publication cannot repair an unresolved stage launch.");
      if (
        recorded.some(
          (stage) =>
            stage.state === "unknown" ||
            (stage.stage !== "publication" &&
              stage.state !== "skipped" &&
              (stage.completed_at === null || stage.completed_at > binding.deadline)),
        )
      )
        conflict(
          "Effectful stage evidence is uncertain or exceeds the original execution deadline.",
        );
      const validation = recorded.find((stage) => stage.stage === "validation");
      if (
        (metadata.validation === "skipped" && validation && validation.state !== "skipped") ||
        (metadata.validation === "passed" && validation?.state !== "passed") ||
        (metadata.validation === "failed" && validation?.state !== "failed") ||
        metadata.validation === "unknown"
      )
        conflict("Publication validation verdict differs from retained stage evidence.");
      const unsigned: Omit<Receipt, "receipt_digest"> = {
        ...binding,
        receipt_ref: this.newReceiptRef(),
        revision: entry.observation.revision + 1,
        committed_at: this.now(),
        physical_state: entry.observation.physical_state,
        effect_certainty: entry.observation.effect_certainty,
        outcome: entry.observation.cancel_requested
          ? "cancelled"
          : recorded.some((stage) => stage.state === "failed") || metadata.validation === "failed"
            ? "failed"
            : "complete",
        stages: recorded,
        output: main.result,
        ...metadata,
      };
      if (entry.request?.process_program?.commands) {
        unsigned.action_checks = {};
        for (const stage of ["preflight", "postcondition"] as const) {
          const recordedStage = recorded.find(value => value.stage === stage);
          if (!recordedStage) continue;
          try {
            const artifacts = this.options.artifacts;
            if (!artifacts || !recordedStage.result || recordedStage.result.purpose !== "output" || recordedStage.result.media_type !== "application/json" || recordedStage.result.bytes > 65536) throw new Error("missing bounded command report");
            unsigned.action_checks[stage] = workCommandReportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifacts.verify(recordedStage.result))));
          } catch { unsigned.action_checks[stage] = { passed: false, unknown: true, detail: "Retained command verdict is unavailable or invalid.", failures: ["Command check did not retain a valid verdict."] }; }
        }
      }
      const receipt = this.validateReceipt(binding, {
        ...unsigned,
        receipt_digest: workReceiptDigest(unsigned),
      });
      return this.applyReceipt(binding, receipt);
    });
  }
  receipt(binding: Binding): Receipt | null {
    this.recover();
    this.required(binding, false);
    const row = this.db
      .prepare(
        "SELECT receipt FROM execution_receipts WHERE owner=? AND workflow=? AND activity=? ORDER BY revision DESC LIMIT 1",
      )
      .get(...this.key(binding));
    return row ? workReceiptSchema.parse(JSON.parse(String(row.receipt))) : null;
  }
  /** Keep stale/later evidence for reconciliation; it cannot overwrite an accepted result. */
  retainLateReceipt(binding: Binding, input: Receipt): void {
    const receipt = workReceiptSchema.parse(input),
      { receipt_digest, ...unsigned } = receipt;
    this.verifyOutput(receipt.output);
    for (const stage of receipt.stages) { this.verifyOutput(stage.result); this.verifyOutput(stage.logs ?? null); }
    if (receipt_digest !== workReceiptDigest(unsigned)) conflict("Late receipt digest differs.");
    const original = Object.fromEntries(
      Object.keys(executionBindingSchema.shape).map((key) => [key, receipt[key as keyof Receipt]]),
    );
    if (boundFingerprint(original) !== boundFingerprint(binding))
      conflict("Late receipt binding differs.");
    this.transaction(() => {
      const previous = this.required(binding, false);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM execution_late_evidence WHERE owner=? AND workflow=? AND activity=? AND digest=?",
          )
          .get(...this.key(binding), receipt_digest)
      )
        return;
      const count = Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM execution_late_evidence WHERE owner=? AND workflow=? AND activity=?",
          )
          .get(...this.key(binding))?.n,
      );
      if (count >= 100)
        throw new WorkflowError(
          "ExecutorEvidenceQuota",
          "Late evidence quota requires explicit archival.",
          429,
        );
      this.db
        .prepare("INSERT INTO execution_late_evidence VALUES(?,?,?,?,?,?,?)")
        .run(
          ...this.key(binding),
          receipt_digest,
          encodeEnvelope(receipt),
          this.now(),
          previous.fence,
        );
    });
  }
  lateReceipts(binding: Binding): Receipt[] {
    this.recover();
    this.required(binding, false);
    return this.db
      .prepare(
        "SELECT receipt FROM execution_late_evidence WHERE owner=? AND workflow=? AND activity=? ORDER BY observed_at,digest",
      )
      .all(...this.key(binding))
      .map((row) => workReceiptSchema.parse(JSON.parse(String(row.receipt))));
  }
  newReceiptRef(): string {
    return `erc_${randomUUID()}`;
  }
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
