import type { z } from "zod";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { WorkflowError } from "./errors.js";
import type { WorkResult } from "./work-read.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { WorkArtifactStore } from "./work-artifacts.js";
import {
  encodeEnvelope,
  encode as encodePayload,
  limits,
  type ActivityTask,
  type Json,
} from "./types.js";
import { workReceiptDigest } from "./executor-journal.js";
import { workProjectionDigest } from "./work-projection.js";
import { indexCanonicalWork } from "./work-read.js";
import {
  projectWorkState,
  executionBindingSchema,
  executorStartSchema,
  executorObservationSchema,
  workReceiptSchema,
  workAdmissionSchema,
  workGrantSchema,
  workLogSchema,
  type WorkAdmission,
} from "./work-contracts.js";

export type WorkExecutionStart = z.infer<typeof executorStartSchema>;
export type WorkExecutionObservation = z.infer<typeof executorObservationSchema>;
export type WorkExecutionReceipt = z.infer<typeof workReceiptSchema>;
interface Row {
  activated_at: number | null;
  observation_revision: number;
  token: string;
  run_id: string;
  worker: string;
  owner_epoch: string;
  request: string;
  observation: string;
  receipt: string | null;
  receipt_digest: string | null;
}

/** Owner-private composition; callers own the same coordination transaction. */
export class OwnerWorkExecution {
  constructor(
    private readonly options: {
      store: WorkflowStore;
      artifacts?: WorkArtifactStore;
      epoch: () => string;
      now: () => number;
      reserve: (run: string, bytes: number) => void;
    },
  ) {}
  work(run: string): WorkAdmission | null {
    const row = this.options.store.one<{ record: string }>(
      "SELECT record FROM workflow_work_admissions WHERE run_id=?",
      run,
    );
    return row ? workAdmissionSchema.parse(JSON.parse(row.record)) : null;
  }
  bind(worker: string, task: ActivityTask, captureLogs = false): WorkExecutionStart {
    const work = this.work(task.runId);
    if (!work) throw new WorkflowError("WorkBindingMissing", "Activity is not common work.", 409);
    if (task.grantRevision !== work.grant_revision)
      throw new WorkflowError(
        "WorkGrantRefreshRequired",
        "Common work needs a full updated grant before dispatching a reauthorized run.",
        409,
      );
    const source = work.plan.source_closure.find(
      (ref) => ref.digest === task.artifact && ref.purpose === "source",
    );
    if (!source)
      throw new WorkflowError(
        "WorkSourceMissing",
        "Activity source is absent from the immutable source closure.",
        409,
      );
    this.options.artifacts?.verify(source);
    if (work.plan.node_job && (work.plan.node_job.activity_type !== task.type || work.plan.node_job.source_digest !== source.digest))
      throw new WorkflowError("WorkSourceMissing", "Node job activity differs from its immutable declaration.", 409);
    if (work.plan.process_program && (work.plan.process_program.activity_type !== task.type || work.plan.process_program.source_digest !== source.digest ||
      boundFingerprint(task.input) !== (work.plan.process_program.input_digest ?? work.plan.workflow.input_digest)))
      throw new WorkflowError("WorkSourceMissing", "Process activity differs from its retained source and inputs.", 409);
    if (work.plan.agent_program) {
      const retained = this.options.store.one<{ evidence: string }>(
        "SELECT evidence FROM workflow_work_grants WHERE run_id=? AND revision=?", work.workflow_id, work.grant_revision,
      );
      const grant = retained ? workGrantSchema.parse(JSON.parse(retained.evidence)) : null;
      if (!grant || work.plan.agent_program.activity_type !== task.type || boundFingerprint(work.plan.agent_program.profile) !== boundFingerprint(source)
        || work.plan.agent_program.installation !== work.namespace.installation || boundFingerprint(work.plan.agent_program.scope) !== boundFingerprint(grant.effective_scope))
        throw new WorkflowError("WorkSourceMissing", "Agent activity differs from its retained profile, installation or grant scope.", 409);
    }
    const previous = task.attempt > 1 ? this.options.store.one<{receipt: string}>(
      "SELECT e.receipt FROM workflow_work_executions e JOIN workflow_attempts a ON a.token=e.token WHERE a.command_id=? AND e.receipt IS NOT NULL ORDER BY a.attempt DESC LIMIT 1", task.activityId,
    ) : undefined;
    const prior = previous ? workReceiptSchema.parse(JSON.parse(previous.receipt)) : null;
    const start = executorStartSchema.parse({
      version: 2,
      launch_authorized: false,
      ...(captureLogs ? { capture_logs: true } : {}),
      ...(work.plan.validation ? {validation: work.plan.validation, activity_type: task.type, output_identity: work.namespace.identity_id} : {}),
      ...(work.plan.node_job ? { node_job: work.plan.node_job } : {}),
      ...(work.plan.agent_program ? { agent_program: work.plan.agent_program, activity_type: task.type, output_identity: work.namespace.identity_id, compatibility_action_id: work.action_id } : {}),
      ...(work.plan.process_program ? { process_program: work.plan.process_program, compatibility_action_id: work.action_id } : {}),
      ...(work.execution_deadline === null ? {} : {budget_deadline: work.execution_deadline}),
      ...(prior ? {retry_from: {attempt_id: prior.attempt_id, receipt_digest: prior.receipt_digest, attempt_number: task.attempt, retry_deadline: this.options.store.one<{deadline: number}>("SELECT work_retry_deadline deadline FROM workflow_commands WHERE id=?", task.activityId)!.deadline}} : {}),
      owner: work.namespace.installation,
      work_id: work.work_id,
      workflow_id: task.runId,
      activity_id: task.activityId,
      attempt_id: task.token,
      request_hash: boundFingerprint({
        admission: work.request_hash,
        activity: task.activityId,
        type: task.type,
        input: task.input,
      }),
      plan_digest: work.plan_digest,
      grant_ref: work.grant_ref,
      grant_revision: task.grantRevision,
      source,
      execution_fence: task.attempt,
      deadline: task.deadline,
      inputs: task.input,
      effect_policy: work.plan.effect_policy,
      resources: { ...work.plan.resources, host_reservation: null },
      executor_generation: work.plan.executor_generation,
    });
    const observation = executorObservationSchema.parse({
      ...this.binding(start),
      revision: 1,
      observed_at: this.options.now(),
      stage: "intent",
      physical_state: "not-started",
      effect_certainty: "not-started",
      cancel_requested: false,
      reason: null,
      receipt_ref: null,
      handle: null,
    });
    const request = encodeEnvelope(start),
      encoded = encodeEnvelope(observation);
    this.options.reserve(task.runId, Buffer.byteLength(request) + Buffer.byteLength(encoded) + 512);
    this.options.store.run(
      "INSERT INTO workflow_work_executions(token,run_id,worker,owner_epoch,request,observation,receipt,receipt_digest) VALUES(?,?,?,?,?,?,NULL,NULL)",
      task.token,
      task.runId,
      worker,
      this.options.epoch(),
      request,
      encoded,
    );
    return start;
  }
  startPermit(worker: string, token: string): WorkExecutionStart | null {
    const row = this.row(worker, token),
      request = executorStartSchema.parse(JSON.parse(row.request));
    return request.launch_authorized ? request : null;
  }
  activate(worker: string, token: string, deadline: number, resources: WorkExecutionStart["resources"], budgetDeadline: number): WorkExecutionStart {
    const row = this.row(worker, token),
      request = executorStartSchema.parse(JSON.parse(row.request));
    if (request.launch_authorized) return request;
    if (row.owner_epoch !== this.options.epoch() || row.observation_revision !== 0 || row.receipt)
      throw new WorkflowError(
        "WorkLaunchFenced",
        "Reservation cannot launch after fencing or recorded execution evidence.",
        409,
      );
    const start = executorStartSchema.parse({ ...request, deadline, resources, budget_deadline: budgetDeadline, launch_authorized: true });
    const observation = executorObservationSchema.parse({
      ...JSON.parse(row.observation),
      deadline,
    });
    this.options.store.run(
      "UPDATE workflow_work_executions SET request=?,observation=?,activated_at=? WHERE token=?",
      encodeEnvelope(start),
      encodeEnvelope(observation),
      this.options.now(),
      token,
    );
    return start;
  }
  private binding(start: WorkExecutionStart | WorkExecutionObservation | WorkExecutionReceipt) {
    return executionBindingSchema.parse(
      Object.fromEntries(
        Object.keys(executionBindingSchema.shape).map((key) => [
          key,
          start[key as keyof typeof start],
        ]),
      ),
    );
  }
  private row(worker: string, token: string): Row {
    const row = this.options.store.one<Row>(
      "SELECT * FROM workflow_work_executions WHERE token=? AND worker=?",
      token,
      worker,
    );
    if (!row)
      throw new WorkflowError(
        "WorkBindingMissing",
        "No execution binding belongs to this worker.",
        404,
      );
    return row;
  }
  inspect(
    worker: string,
    token: string,
  ): { observation: WorkExecutionObservation; stop_requested: boolean } {
    const row = this.row(worker, token),
      work = this.work(row.run_id)!;
    const run = this.options.store.one<{ status: string }>(
      "SELECT status FROM workflow_runs WHERE id=?",
      row.run_id,
    )!;
    return {
      observation: executorObservationSchema.parse(JSON.parse(row.observation)),
      stop_requested:
        work.facts.stop_requested || ["cancelled", "timed_out", "blocked"].includes(run.status),
    };
  }
  retainedReceipt(token: string): {
    worker: string;
    receipt: WorkExecutionReceipt;
    value: Json | null;
    invalid_output?: string;
    owner_epoch: string;
  } {
    const row = this.options.store.one<Row>(
      "SELECT * FROM workflow_work_executions WHERE token=?",
      token,
    );
    if (!row?.receipt)
      throw new WorkflowError(
        "WorkReceiptMissing",
        "Reconciliation requires retained executor evidence.",
        409,
      );
    const receipt = workReceiptSchema.parse(JSON.parse(row.receipt));
    const verified = this.receipt(row.worker, token, receipt);
    for (const stage of receipt.stages) for (const ref of [stage.result, stage.logs]) if (ref) this.verify(ref);
    return {
      worker: row.worker,
      receipt: verified.receipt,
      value: verified.value,
      invalid_output: verified.invalid_output,
      owner_epoch: row.owner_epoch,
    };
  }
  logs(receipt: WorkExecutionReceipt) {
    return receipt.stages.flatMap<NonNullable<WorkResult["logs"]>[number]>(stage => {
      if (!stage.logs) return [];
      const reference = stage.logs, bytes = this.verify(reference);
      try {
        const value = workLogSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        return [{ stage: stage.stage, reference, value, invalid_reason: null as string | null }];
      } catch {
        return [{ stage: stage.stage, reference, value: null, invalid_reason: "Retained logs are not valid bounded log data." }];
      }
    });
  }
  private check(row: Row, evidence: WorkExecutionObservation | WorkExecutionReceipt): void {
    const request = executorStartSchema.parse(JSON.parse(row.request));
    if (boundFingerprint(this.binding(request)) !== boundFingerprint(this.binding(evidence)))
      throw new WorkflowError(
        "WorkBindingConflict",
        "Executor evidence differs from its accepted activity binding.",
        409,
      );
  }
  observe(
    worker: string,
    token: string,
    input: WorkExecutionObservation,
  ): "accepted" | "duplicate" | "stale" {
    const observation = executorObservationSchema.parse(input),
      row = this.row(worker, token);
    const request = executorStartSchema.parse(JSON.parse(row.request));
    if (
      !request.launch_authorized &&
      (observation.physical_state !== "not-started" ||
        observation.effect_certainty !== "not-started")
    )
      throw new WorkflowError(
        "WorkLaunchUnauthorized",
        "Reservation has no permission to execute.",
        409,
      );
    this.check(row, observation);
    if (row.owner_epoch !== this.options.epoch() || row.receipt) return "stale";
    const old = executorObservationSchema.parse(JSON.parse(row.observation));
    if (observation.revision < row.observation_revision) return "stale";
    if (observation.revision === row.observation_revision) {
      if (boundFingerprint(old) !== boundFingerprint(observation))
        throw new WorkflowError(
          "WorkObservationConflict",
          "Same observation revision has different evidence.",
          409,
        );
      this.options.store.run("UPDATE workflow_work_executions SET last_observed_at=? WHERE token=?", this.options.now(), token);
      return "duplicate";
    }
    if (observation.receipt_ref)
      throw new WorkflowError(
        "WorkReceiptRequired",
        "A terminal observation requires its durable receipt.",
        409,
      );
    if (old.effect_certainty === "uncertain" && observation.effect_certainty === "not-started")
      throw new WorkflowError(
        "WorkObservationConflict",
        "Launch uncertainty cannot be erased by an observation.",
        409,
      );
    if (old.cancel_requested && !observation.cancel_requested)
      throw new WorkflowError("WorkObservationConflict", "Stop intent cannot be withdrawn.", 409);
    const encoded = encodeEnvelope(observation);
    this.options.reserve(
      row.run_id,
      Math.max(0, Buffer.byteLength(encoded) - Buffer.byteLength(row.observation)),
    );
    this.options.store.run(
      "UPDATE workflow_work_executions SET observation=?,observation_revision=?,last_observed_at=? WHERE token=?",
      encoded,
      observation.revision,
      this.options.now(),
      token,
    );
    return "accepted";
  }
  receipt(
    worker: string,
    token: string,
    input: WorkExecutionReceipt,
  ): {
    state: "new" | "duplicate";
    stale: boolean;
    ceased: boolean;
    receipt: WorkExecutionReceipt;
    value: Json | null;
    invalid_output?: string;
  } {
    const receipt = workReceiptSchema.parse(input),
      row = this.row(worker, token);
    if (
      !executorStartSchema.parse(JSON.parse(row.request)).launch_authorized &&
      (receipt.physical_state !== "not-started" || receipt.effect_certainty !== "not-started")
    )
      throw new WorkflowError(
        "WorkLaunchUnauthorized",
        "Unactivated reservation cannot report executed effects.",
        409,
      );
    this.check(row, receipt);
    const { receipt_digest, ...unsigned } = receipt;
    if (receipt_digest !== workReceiptDigest(unsigned))
      throw new WorkflowError(
        "WorkReceiptInvalid",
        "Receipt digest differs from its evidence.",
        409,
      );
    if (row.receipt) {
      if (row.receipt_digest !== receipt_digest)
        throw new WorkflowError(
          "WorkReceiptConflict",
          "This execution already retained another immutable receipt.",
          409,
        );
      return {
        state: "duplicate",
        stale: row.owner_epoch !== this.options.epoch(),
        ceased: ["ceased", "not-started"].includes(receipt.physical_state),
        receipt,
        ...this.output(receipt),
      };
    }
    if (receipt.outcome === "complete" && receipt.stages.some(stage => stage.stage !== "publication" && stage.state !== "skipped" &&
      (stage.state === "failed" || stage.completed_at === null || stage.completed_at > receipt.deadline)))
      throw new WorkflowError("WorkReceiptInvalid", "Completion requires successful effectful evidence within the original execution deadline.", 409);
    const old = executorObservationSchema.parse(JSON.parse(row.observation));
    if (receipt.revision <= old.revision)
      throw new WorkflowError(
        "WorkReceiptConflict",
        "Receipt must follow the latest observation revision.",
        409,
      );
    if (
      receipt.outcome !== "uncertain" &&
      !["ceased", "not-started"].includes(receipt.physical_state)
    )
      throw new WorkflowError(
        "WorkReceiptInvalid",
        "A certain terminal receipt requires cessation.",
        409,
      );
    const work = this.work(receipt.workflow_id)!;
    if (receipt.outcome === "complete") for (const stage of ["preflight", "postcondition"] as const)
      if (work.plan.process_program?.commands?.[stage] && !receipt.stages.some(value => value.stage === stage && value.state === "passed"))
        throw new WorkflowError("WorkReceiptInvalid", "Completion is missing a declared action command stage.", 409);
    for (const stage of receipt.stages) {
      if (stage.attempt_id !== token)
        throw new WorkflowError(
          "WorkReceiptInvalid",
          "Stage evidence belongs to another attempt.",
          409,
        );
      if (
        ["passed", "failed"].includes(stage.state) &&
        (stage.started_at === null ||
          stage.completed_at === null ||
          stage.started_at > stage.completed_at)
      )
        throw new WorkflowError(
          "WorkReceiptInvalid",
          "Executed stages need ordered completion evidence.",
          409,
        );
      for (const reference of [stage.result, stage.logs]) if (reference) {
        if (reference.owner_identity !== work.namespace.identity_id)
          throw new WorkflowError(
            "WorkArtifactForbidden",
            "Stage output belongs to another identity.",
            403,
          );
        this.verify(reference);
      }
    }
    if (
      receipt.outcome === "complete" &&
      !receipt.stages.some((stage) => stage.stage === "execution" && stage.state === "passed")
    )
      throw new WorkflowError(
        "WorkReceiptInvalid",
        "Completion needs successful main-stage evidence.",
        409,
      );
    if (receipt.outcome === "complete" && receipt.effect_certainty !== "known")
      throw new WorkflowError(
        "WorkReceiptInvalid",
        "Completed execution must carry known result/effect evidence.",
        409,
      );
    if (
      receipt.outcome !== "uncertain" &&
      receipt.stages.some((stage) => stage.state === "unknown")
    )
      throw new WorkflowError(
        "WorkReceiptInvalid",
        "Unknown stage effects require an uncertain receipt.",
        409,
      );
    if (
      receipt.validation === "passed" &&
      !receipt.stages.some((stage) => stage.stage === "validation" && stage.state === "passed")
    )
      throw new WorkflowError("WorkReceiptInvalid", "Passed validation needs stage evidence.", 409);
    const interpreted = this.output(receipt),
      encoded = encodeEnvelope(receipt);
    for (const reference of [receipt.output, ...receipt.stages.flatMap((stage) => [stage.result, stage.logs])]) {
      if (!reference) continue;
      const namespace = boundFingerprint(reference.owner_identity);
      if (
        !this.options.store.one(
          "SELECT 1 FROM workflow_work_sources WHERE run_id=? AND namespace_hash=? AND digest=? AND purpose=?",
          row.run_id,
          namespace,
          reference.digest,
          reference.purpose,
        )
      ) {
        this.options.reserve(row.run_id, 256);
        this.options.store.run(
          "INSERT INTO workflow_work_sources VALUES(?,?,?,?,?)",
          row.run_id,
          namespace,
          reference.digest,
          reference.bytes,
          reference.purpose,
        );
      }
    }
    this.options.reserve(row.run_id, Buffer.byteLength(encoded) + 512);
    this.options.store.run(
      "UPDATE workflow_work_executions SET receipt=?,receipt_digest=? WHERE token=?",
      encoded,
      receipt_digest,
      token,
    );
    const terminal = executorObservationSchema.parse({
      ...this.binding(receipt),
      revision: receipt.revision,
      observed_at: this.options.now(),
      stage: "terminal",
      physical_state: receipt.physical_state,
      effect_certainty: receipt.effect_certainty,
      cancel_requested: old.cancel_requested,
      reason: old.reason,
      receipt_ref: receipt.receipt_ref,
      handle: old.handle,
    });
    this.options.store.run(
      "UPDATE workflow_work_executions SET observation=? WHERE token=?",
      encodeEnvelope(terminal),
      token,
    );
    return {
      state: "new",
      stale: row.owner_epoch !== this.options.epoch(),
      ceased: ["ceased", "not-started"].includes(receipt.physical_state),
      receipt,
      ...interpreted,
    };
  }
  private verify(ref: WorkExecutionReceipt["source"]): Buffer {
    if (!this.options.artifacts)
      throw new WorkflowError(
        "WorkArtifactUnavailable",
        "Owner result storage is unavailable.",
        503,
        true,
      );
    return this.options.artifacts.verify(ref);
  }
  private output(receipt: WorkExecutionReceipt): { value: Json | null; invalid_output?: string } {
    const work = this.work(receipt.workflow_id)!;
    const requiredVerdict = work.plan.validation?.mode === "json-schema" && receipt.outcome === "complete" && receipt.validation !== "passed"
      ? "Required output validation was not proven." : undefined;
    if (!receipt.output) return { value: null, ...(requiredVerdict ? { invalid_output: requiredVerdict } : {}) };
    if (
      receipt.output.owner_identity !== work.namespace.identity_id ||
      receipt.output.purpose !== "output" ||
      !receipt.stages.some(
        (stage) =>
          stage.result && boundFingerprint(stage.result) === boundFingerprint(receipt.output),
      )
    )
      throw new WorkflowError(
        "WorkArtifactForbidden",
        "Result must be retained stage output in the original identity namespace.",
        403,
      );
    const bytes = this.verify(receipt.output);
    if (receipt.output.bytes > limits.payload || receipt.output.media_type !== "application/json")
      return { value: { output_artifact: { ...receipt.output } }, ...(requiredVerdict ? { invalid_output: requiredVerdict } : {}) };
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Json;
      encodePayload(value);
      return { value, ...(requiredVerdict ? { invalid_output: requiredVerdict } : {}) };
    } catch {
      // Byte integrity and binding have already been checked. Content failure is
      // an application verdict, never a reason to discard authenticated stop proof.
      return { value: { output_artifact: { ...receipt.output } },
        invalid_output: "Retained output is not valid bounded finite JSON." };
    }
  }
  /** Stop does not discard a recent guardian observation. A lost guardian still
   * becomes unknown without releasing any physical reservation. */
  expireStopObservations(): void {
    const rows = this.options.store.rows<{ token: string; run_id: string }>(
      "SELECT e.token,e.run_id FROM workflow_work_executions e JOIN workflow_attempts a ON a.token=e.token JOIN workflow_work_admissions w ON w.run_id=e.run_id WHERE a.physical_state='running' AND json_extract(w.record,'$.facts.stop_requested')=1 AND (e.owner_epoch<>? OR e.last_observed_at IS NULL OR e.last_observed_at>? OR e.last_observed_at<=?) ORDER BY coalesce(e.last_observed_at,0),e.token LIMIT 64", this.options.epoch(), this.options.now(), this.options.now() - 15000,
    );
    for (const row of rows) {
      this.options.store.run("UPDATE workflow_attempts SET physical_state='unknown' WHERE token=? AND physical_state='running'", row.token);
      this.publish(row.run_id);
    }
  }
  requestStop(runId: string): void {
    const work = this.work(runId);
    if (!work) throw new WorkflowError("WorkNotFound", "Work is unavailable.", 404);
    this.options.store.run("UPDATE workflow_work_admissions SET record=? WHERE run_id=?", encodeEnvelope({ ...work, facts: { ...work.facts, stop_requested: true } }), runId);
    this.publish(runId);
  }
  publish(runId: string): void {
    const work = this.work(runId);
    if (!work) return;
    const store = this.options.store,
      run = store.one<{ status: WorkAdmission["facts"]["coordinator"]; outcome: string | null }>(
        "SELECT status,outcome FROM workflow_runs WHERE id=?",
        runId,
      )!;
    const executions = store.rows<{
      observation: string | null;
      receipt: string | null;
      physical_state: string;
      state: string;
      last_observed_at: number | null;
      owner_epoch: string | null;
    }>(
      "SELECT e.observation,e.receipt,a.physical_state,a.state,e.last_observed_at,e.owner_epoch FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id LEFT JOIN workflow_work_executions e ON e.token=a.token WHERE c.run_id=? ORDER BY a.started_at,a.token",
      runId,
    );
    const pairs = executions.map((row) => ({
      ...row,
      observed: row.observation
        ? executorObservationSchema.parse(JSON.parse(row.observation))
        : null,
    }));
    const observations = pairs.flatMap((row) => (row.observed ? [row.observed] : []));
    const stopRequested = work.facts.stop_requested || ["cancelled", "timed_out"].includes(run.status);
    const lost = pairs.some(
      (row) =>
        row.physical_state !== "settled" &&
        (row.state !== "active" || row.observation === null) &&
        !(stopRequested && row.physical_state === "running" && row.owner_epoch === this.options.epoch() &&
          row.last_observed_at !== null && row.last_observed_at <= this.options.now() && row.last_observed_at > this.options.now() - 15000 &&
          row.observed && ["running", "stopping"].includes(row.observed.physical_state)),
    );
    const physical =
      lost || executions.some((row) => row.physical_state === "unknown")
        ? "unknown"
        : pairs.some(
              (row) =>
                row.observed?.physical_state === "unknown" && row.physical_state !== "settled",
            )
          ? "unknown"
          : pairs.some(
                (row) =>
                  row.observed &&
                  ["running", "stopping"].includes(row.observed.physical_state) &&
                  row.physical_state !== "settled",
              )
            ? "running"
            : executions.length && executions.every((row) => row.physical_state === "settled")
              ? "ceased"
              : "not-started";
    const effect =
      lost ||
      pairs.some((row) => row.observed === null) ||
      observations.some((row) => row.effect_certainty === "uncertain")
        ? "uncertain"
        : observations.some((row) => row.effect_certainty === "known")
          ? "known"
          : "not-started";
    const latest = observations.at(-1),
      stop =
        ["cancelled", "timed_out"].includes(run.status) ||
        work.facts.stop_requested ||
        observations.some((row) => row.cancel_requested);
    const waiting = store.one<{ timers: number; signals: number }>(
      "SELECT coalesce(sum(json_extract(definition,'$.kind')='timer'),0) timers,coalesce(sum(json_extract(definition,'$.kind')='signal'),0) signals FROM workflow_commands WHERE run_id=? AND state='pending'",
      runId,
    )!;
    const facts: WorkAdmission["facts"] = {
      ...work.facts,
      wait: waiting.signals ? "signal" : waiting.timers ? "timer" : "none",
      coordinator: run.status,
      physical,
      effect,
      stop_requested: stop,
      phase: ["completed", "failed", "cancelled", "timed_out"].includes(run.status)
        ? "terminal"
        : latest?.stage === "preflight"
          ? "preflight"
          : (latest?.stage === "validation" || latest?.stage === "postcondition")
            ? "validating"
            : latest?.stage === "publication"
              ? "publishing"
              : latest && !["intent", "terminal"].includes(latest.stage)
                ? "executing"
                : "queued",
      has_result: observations.some((row) => row.receipt_ref !== null) || run.outcome !== null,
    };
    const uncertainReason =
      latest?.reason ??
      (projectWorkState(facts).state === "needs-attention" && (physical === "unknown" || effect === "uncertain")
        ? {
            code: "ExecutionUncertain",
            stage: "recovery",
            since:
              work.reason?.code === "ExecutionUncertain" ? work.reason.since : this.options.now(),
            retryable: false,
            detail: "Executor evidence or physical settlement needs reconciliation.",
          }
        : null);
    const reason =
      uncertainReason ??
      (run.status === "blocked" && observations.some((row) => row.receipt_ref)
        ? {
            code: "LateExecutionEvidence",
            stage: "recovery",
            since:
              work.reason?.code === "LateExecutionEvidence"
                ? work.reason.since
                : this.options.now(),
            retryable: false,
            detail: "Retained receipt requires audited coordinator reconciliation.",
          }
        : null);
    const outcome = run.outcome
      ? (JSON.parse(run.outcome) as { ok: boolean; error?: { code?: string } })
      : null;
    const expiredDispatch = run.status === "failed" ? store.one<{ deadline: number }>(
      "SELECT work_dispatch_deadline deadline FROM workflow_commands WHERE run_id=? AND work_dispatch_deadline IS NOT NULL AND json_extract(outcome,'$.error.code')='DispatchTimeout' ORDER BY position DESC,slot DESC LIMIT 1", runId,
    ) : undefined;
    const deadlineReason =
      reason ??
      (outcome?.ok === false && (outcome.error?.code === "DispatchTimeout" || expiredDispatch)
        ? {
            code: "dispatch_timeout",
            stage: "placement",
            since: expiredDispatch?.deadline ?? work.dispatch_deadline,
            retryable: false,
            detail: "An eligible activity exceeded its dispatch budget before launch authorization.",
          }
        : null);
    const receiptRef =
      [...observations].reverse().find((row) => row.receipt_ref)?.receipt_ref ?? null;
    const projected = store.one<{ body: string }>(
      "SELECT body FROM workflow_work_outbox WHERE run_id=? AND kind='projection'",
      runId,
    );
    if (
      projected &&
      workProjectionDigest({
        ...work,
        facts,
        reason: deadlineReason,
        receipt_ref: receiptRef,
      } as WorkAdmission) ===
        workProjectionDigest(workAdmissionSchema.parse(JSON.parse(projected.body)))
    )
      return;
    const next = workAdmissionSchema.parse({
      ...work,
      facts,
      reason: deadlineReason,
      receipt_ref: receiptRef,
      revision: work.revision + 1,
      projection: {
        desired_revision: work.revision + 1,
        applied_revision: work.projection.applied_revision,
      },
    });
    const record = encodeEnvelope(next);
    this.options.reserve(
      runId,
      Math.max(0, 2 * (Buffer.byteLength(record) - Buffer.byteLength(encodeEnvelope(work)))),
    );
    store.run("UPDATE workflow_work_admissions SET record=? WHERE run_id=?", record, runId);
    indexCanonicalWork(store, next);
    store.run(
      "INSERT INTO workflow_work_outbox VALUES(?,'projection',?,0,?) ON CONFLICT(run_id,kind) DO UPDATE SET desired_revision=excluded.desired_revision,body=excluded.body",
      runId,
      next.revision,
      record,
    );
  }
}
