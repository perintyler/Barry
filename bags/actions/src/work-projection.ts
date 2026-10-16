import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { workAdmissionSchema, workNamespaceSchema, workProjectionDigest, projectWorkState, WorkflowError,
  type WorkAdmission, type WorkNamespace, type WorkResult, type WorkProjectionTarget } from "@barry-rocks/sdk/internal/workflows";
import type { ActionsDb } from "./db.js";
import { MAX_OUTPUT_CHARS } from "./action-runs.js";

/** A trusted host selects the identity-owned database before creating a target.
 * Each target binds one namespace; its identity-owned database can contain
 * several caller sessions belonging to that same identity. */
export function createActionWorkProjection(options: {
  database: ActionsDb;
  namespace: WorkNamespace;
  generation?: string;
  result: (work: WorkAdmission) => WorkResult | Promise<WorkResult>;
}): WorkProjectionTarget {
  const generation = options.generation ?? "initial";
  if (!generation || generation.length > 200) throw new Error("Invalid projection generation.");
  const namespace = workNamespaceSchema.parse(options.namespace), namespaceHash = boundFingerprint(namespace), db = options.database;
  if (db.inTransaction) throw new Error("Action projection requires its own commit boundary.");
  db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
  const ownerHash = boundFingerprint({ installation: namespace.installation, identity_id: namespace.identity_id,
    ...(namespace.identity_id === null ? { principal_kind: namespace.principal_kind, principal_id: namespace.principal_id } : {}) });
  const conflict = (message: string): never => { throw new WorkflowError("ActionProjectionConflict", message, 409); };
  const read = (id: string) => db.prepare("SELECT * FROM action_work_projections WHERE action_id=?").get(id) as { binding: string; revision: number; digest: string; generation: string } | undefined;
  const check = (work: WorkAdmission, binding: string, digest: string): boolean => {
    const old = read(work.action_id!);
    if (old && old.binding !== binding) conflict("Action projection binding cannot change.");
    if (old?.generation === generation && old.revision === work.revision && old.digest !== digest) conflict("Same action revision has different facts.");
    return Boolean(old && old.generation === generation && old.revision >= work.revision);
  };
  return { async apply(input) {
    const work = workAdmissionSchema.parse(input), digest = workProjectionDigest(work);
    if (boundFingerprint(work.namespace) !== namespaceHash) conflict("Action projection belongs to another admission namespace.");
    const ack = { work_id: work.work_id, revision: work.revision, digest };
    if (work.plan.definition.kind !== "action") return ack;
    const definition = work.plan.definition;
    if (!work.action_id) conflict("Action admission has no compatibility identity.");
    const binding = boundFingerprint({ namespace, action_id: work.action_id, work_id: work.work_id, workflow_id: work.workflow_id,
      accepted_at: work.accepted_at, idempotency_key: work.idempotency_key, request_hash: work.request_hash, plan_digest: work.plan_digest });
    const bound = db.prepare("SELECT namespace,generation FROM action_work_projection_owner WHERE id=1").get() as { namespace: string; generation: string } | undefined;
    if (bound && bound.namespace !== ownerHash) conflict("Actions database belongs to another admission namespace.");
    if (bound && bound.generation !== generation) conflict("Projection generation is obsolete; prepare an owner-authorized rebuild.");
    if (check(work, binding, digest)) return ack;
    const state = projectWorkState(work.facts).state;
    const closed = ["completed", "failed", "cancelled"].includes(state);
    const result = work.facts.has_result || work.receipt_ref || closed ? await options.result(work) : null;
    if (result && (result.work_id !== work.work_id || result.revision !== work.revision || result.receipt_ref !== work.receipt_ref ||
        result.status !== (work.facts.has_result ? "available" : "pending")))
      conflict("Result snapshot does not match the projected work revision.");
    if (closed && (!Number.isSafeInteger(result?.closed_at) || result!.closed_at! < 0)) conflict("Closed work requires its canonical closure timestamp.");
    const post = result?.action_checks?.postcondition;
    const failures = post ? !post.passed && post.failures.length === 0 ? [post.detail || "Postcondition verdict is unknown."] : post.failures : null;
    const status = state === "cancelled" ? "cancelled" : state === "failed" || state === "completed" && post && !post.passed ? "failed" : state === "completed" ? "complete" : "started";
    const retained = result?.retained_output;
    const value = retained && !retained.invalid_reason ? retained.value : result?.outcome?.ok ? result.outcome.value : undefined;
    const outputType = (work.plan.process_program?.output ?? (work.plan.validation?.mode === "json-schema" ? "json" : "text-tail")) === "json" ? "json" : "text";
    const output = value === undefined || value === null && outputType === "text" ? null : outputType === "json" ? JSON.stringify(value) : typeof value === "string" ? value : JSON.stringify(value);
    if (output && output.length > MAX_OUTPUT_CHARS) conflict("Retained action output exceeds the compatibility contract.");
    const at = new Date(work.accepted_at).toISOString();
    const summary = state === "completed" && post && !post.passed ? `Workflow execution completed; postconditions did not pass: ${post.detail || failures?.join("; ")}`.slice(0, 4000) :
      work.reason?.detail ?? (result?.outcome && !result.outcome.ok ? result.outcome.error.message : state === "completed" ? "Workflow execution completed." : null);
    const trigger = work.origin.trigger === "schedule" ? "schedule" : work.origin.entry_point === "work-cli" ? "cli" : "api";
    db.transaction(() => {
      const currentOwner = db.prepare("SELECT namespace,generation FROM action_work_projection_owner WHERE id=1").get() as { namespace: string; generation: string } | undefined;
      if (currentOwner && currentOwner.namespace !== ownerHash) conflict("Actions database belongs to another admission namespace.");
      if (currentOwner && currentOwner.generation !== generation) conflict("Projection generation is obsolete.");
      if (check(work, binding, digest)) return;
      if (!read(work.action_id!) && db.prepare("SELECT 1 FROM action_runs WHERE id=?").get(work.action_id)) conflict("Compatibility identity already belongs to a legacy action run.");
      db.prepare(`INSERT OR IGNORE INTO action_work_projection_history(action_id,generation,revision,digest,record,result)
        SELECT action_id,generation,revision,digest,record,result FROM action_work_projections WHERE action_id=? AND generation!=?`).run(work.action_id, generation);
      db.prepare("INSERT OR IGNORE INTO action_work_projection_owner(id,namespace,generation) VALUES(1,?,?)").run(ownerHash, generation);
      db.prepare(`INSERT INTO action_runs(id,action,bag,session_id,status,summary,metadata,started_at,completed_at,validated_at,validation_failures,output,output_type,trigger,schedule_id)
        VALUES(@id,@action,@bag,@session,@status,@summary,@metadata,@started,@completed,@validated,@failures,@output,@output_type,@trigger,@schedule)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary=excluded.summary,metadata=excluded.metadata,completed_at=excluded.completed_at,
          validated_at=excluded.validated_at,validation_failures=excluded.validation_failures,output=excluded.output,output_type=excluded.output_type`).run({
        id: work.action_id, action: work.plan.definition.reference, bag: definition.catalog_namespace,
        session: work.namespace.caller_session_id, status, summary, metadata: JSON.stringify({ executor_generation: "work-v2" }), started: at,
        completed: closed ? new Date(result!.closed_at!).toISOString() : null, validated: post && result?.closed_at ? new Date(result.closed_at).toISOString() : null,
        failures: failures === null ? null : JSON.stringify(failures), output, output_type: output === null ? null : outputType, trigger, schedule: work.origin.trigger === "schedule" ? work.origin.producer_ref ?? null : null,
      });
      db.prepare(`INSERT INTO action_work_projections(action_id,work_id,workflow_id,binding,revision,digest,record,result,generation) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET
        revision=excluded.revision,digest=excluded.digest,record=excluded.record,result=excluded.result,generation=excluded.generation`).run(
        work.action_id, work.work_id, work.workflow_id, binding, work.revision, digest, JSON.stringify(work), result ? JSON.stringify(result) : null, generation);
    })();
    return ack;
  } };
}

/** Trusted owner startup/restore boundary, never exposed to a worker or caller.
 * Existing row evidence stays intact and becomes stale until canonically rebuilt. */
export function prepareActionWorkProjectionGeneration(options: {
  database: ActionsDb; namespace: WorkNamespace; generation: string;
}): void {
  const namespace = workNamespaceSchema.parse(options.namespace), generation = options.generation;
  if (!generation || generation.length > 200 || options.database.inTransaction) throw new Error("Invalid projection generation boundary.");
  const owner = boundFingerprint({ installation: namespace.installation, identity_id: namespace.identity_id,
    ...(namespace.identity_id === null ? { principal_kind: namespace.principal_kind, principal_id: namespace.principal_id } : {}) });
  const db = options.database; db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
  db.transaction(() => {
    const previous = db.prepare("SELECT namespace,generation FROM action_work_projection_owner WHERE id=1").get() as { namespace: string; generation: string } | undefined;
    if (previous && previous.namespace !== owner) throw new WorkflowError("ActionProjectionConflict", "Projection database belongs to another owner.", 409);
    if (previous?.generation === generation) return;
    if (db.prepare("SELECT 1 FROM action_work_projection_generations WHERE generation=?").get(generation))
      throw new WorkflowError("ActionProjectionConflict", "A superseded projection generation cannot be reactivated.", 409);
    const at = new Date().toISOString();
    if (previous) db.prepare("INSERT OR IGNORE INTO action_work_projection_generations VALUES(?,?,?)").run(previous.generation, null, at);
    db.prepare("INSERT INTO action_work_projection_generations VALUES(?,?,?)").run(generation, previous?.generation ?? null, at);
    db.prepare("INSERT INTO action_work_projection_owner(id,namespace,generation) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation").run(owner, generation);
  })();
}
