import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import {
  workAdmissionSchema,
  workNamespaceSchema,
  projectWorkState,
  type WorkAdmission,
  type WorkNamespace,
} from "./work-contracts.js";
import type { WorkflowStore } from "./workflow-store.js";
import { WorkflowError } from "./errors.js";
import { encodeEnvelope } from "./types.js";

/** Progress acknowledgements do not change the semantic revision of the view. */
export function workProjectionDigest(work: WorkAdmission): string {
  const {
    projection: _projection,
    notification: _notification,
    ...view
  } = workAdmissionSchema.parse(work);
  return boundFingerprint(view);
}
function binding(work: WorkAdmission): string {
  return boundFingerprint({
    namespace: work.namespace,
    work_id: work.work_id,
    workflow_id: work.workflow_id,
    action_id: work.action_id,
    job_run_id: work.job_run_id,
    idempotency_key: work.idempotency_key,
    request_hash: work.request_hash,
    plan_digest: work.plan_digest,
    accepted_at: work.accepted_at,
    grant_ref: work.grant_ref,
    grant_revision: work.grant_revision,
    origin: work.origin,
  });
}
export interface WorkProjectionTarget {
  apply(
    work: WorkAdmission,
  ):
    | Promise<{ work_id: string; revision: number; digest: string }>
    | { work_id: string; revision: number; digest: string };
}

/** Private replica: callers authenticate read access before selecting a namespace. */
export class WorkProjectionReplica implements WorkProjectionTarget {
  private db!: SqliteDatabase;
  private uncertain = false;
  constructor(private readonly options: { path: string; owner: string }) {
    if (!isAbsolute(options.path)) throw new Error("projection path must be absolute");
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.open(true);
  }
  private open(initialize: boolean): void {
    const db = new SqliteDatabase(this.options.path);
    try {
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 1 || (!initialize && version !== 1))
        throw new Error("unsupported work projection schema");
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50");
      if (initialize) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS projection_meta(owner TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS work_views(work_id TEXT PRIMARY KEY,namespace_hash TEXT NOT NULL,
            revision INTEGER NOT NULL,digest TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS work_views_namespace ON work_views(namespace_hash,work_id);
          PRAGMA user_version=1;`);
        const previous = db.prepare("SELECT owner FROM projection_meta").get();
        if (previous && previous.owner !== this.options.owner)
          throw new Error("projection belongs to another owner");
        db.prepare("INSERT OR IGNORE INTO projection_meta VALUES(?)").run(this.options.owner);
        db.exec("COMMIT");
      } else if (
        db.prepare("SELECT owner FROM projection_meta").get()?.owner !== this.options.owner
      )
        throw new Error("projection owner changed");
      this.db = db;
      this.uncertain = false;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Original startup failure. */
      }
      db.close();
      throw error;
    }
  }
  private recover(): void {
    if (!this.uncertain) return;
    if (this.db.isOpen) this.db.close();
    this.open(false);
  }
  apply(input: WorkAdmission) {
    const work = workAdmissionSchema.parse(input),
      digest = workProjectionDigest(work);
    if (work.namespace.installation !== this.options.owner)
      throw new WorkflowError(
        "ProjectionForbidden",
        "Projection belongs to another installation.",
        403,
      );
    const namespace = boundFingerprint(work.namespace),
      immutable = binding(work);
    this.recover();
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const old = this.db
        .prepare("SELECT namespace_hash,revision,digest,binding FROM work_views WHERE work_id=?")
        .get(work.work_id);
      if (old && (old.namespace_hash !== namespace || old.binding !== immutable))
        throw new WorkflowError(
          "ProjectionConflict",
          "Work projection cannot change admission ownership or binding.",
          409,
        );
      if (old && Number(old.revision) === work.revision && old.digest !== digest)
        throw new WorkflowError(
          "ProjectionConflict",
          "Same view revision contains different facts.",
          409,
        );
      if (!old || Number(old.revision) < work.revision)
        this.db
          .prepare(
            "INSERT INTO work_views VALUES(?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,state=excluded.state,record=excluded.record WHERE work_views.revision<excluded.revision",
          )
          .run(
            work.work_id,
            namespace,
            work.revision,
            digest,
            immutable,
            projectWorkState(work.facts).state,
            encodeEnvelope(work),
          );
      committing = true;
      this.db.exec("COMMIT");
      return { work_id: work.work_id, revision: work.revision, digest };
    } catch (error) {
      let rolledBack = false;
      try {
        this.db.exec("ROLLBACK");
        rolledBack = true;
      } catch {
        /* Keep original failure. */
      }
      this.uncertain = committing || (!rolledBack && this.db.isTransaction);
      throw error;
    }
  }
  get(namespace: WorkNamespace, workId: string): WorkAdmission | null {
    this.recover();
    const row = this.db
      .prepare("SELECT record FROM work_views WHERE namespace_hash=? AND work_id=?")
      .get(boundFingerprint(workNamespaceSchema.parse(namespace)), workId);
    return row ? workAdmissionSchema.parse(JSON.parse(String(row.record))) : null;
  }
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

/** Delivery happens outside the owner transaction; acknowledgement is a guarded CAS. */
export async function publishWorkProjections(
  store: WorkflowStore,
  target: WorkProjectionTarget,
  limit = 16,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
    throw new Error("projection batch must be 1..64");
  const cursor = store.one<{ value: string }>("SELECT value FROM workflow_meta WHERE key='projection-delivery-cursor'")?.value ?? "";
  const page = (after: string) => store.rows<{ run_id: string; desired_revision: number; body: string }>(
    "SELECT run_id,desired_revision,body FROM workflow_work_outbox WHERE kind='projection' AND applied_revision<desired_revision AND run_id>? ORDER BY run_id LIMIT ?", after, limit,
  );
  const pending = page(cursor);
  if (!pending.length && cursor) pending.push(...page(""));
  let applied = 0;
  const errors: unknown[] = [];
  for (const item of pending) {
    // Persist traversal before an external call. Poisoned rows and repeated
    // owner restarts cannot keep a leading batch ahead of unrelated work.
    store.transaction(() => store.run("INSERT INTO workflow_meta(key,value) VALUES('projection-delivery-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", item.run_id));
    try {
      const work = workAdmissionSchema.parse(JSON.parse(item.body));
      if (work.revision !== item.desired_revision)
        throw new WorkflowError(
          "ProjectionConflict",
          "Outbox body revision differs from its intent.",
          409,
        );
      const ack = await target.apply(work);
      if (
        ack.work_id !== work.work_id ||
        ack.revision !== item.desired_revision ||
        ack.digest !== workProjectionDigest(work)
      )
        throw new WorkflowError(
          "ProjectionAcknowledgementInvalid",
          "Target did not acknowledge this exact view.",
          503,
          true,
        );
      store.transaction(() => {
        store.run(
          "UPDATE workflow_work_outbox SET applied_revision=? WHERE run_id=? AND kind='projection' AND desired_revision=? AND body=? AND applied_revision<?",
          item.desired_revision,
          item.run_id,
          item.desired_revision,
          item.body,
          item.desired_revision,
        );
        if (store.one<{ changed: number }>("SELECT changes() changed")!.changed) applied++;
      });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
  return applied;
}

/** Canonical acceptance always wins over a stale/missing/unavailable replica. */
export function readCanonicalWork(
  store: WorkflowStore,
  namespace: WorkNamespace,
  workId: string,
): WorkAdmission | null {
  const row = store.one<{ record: string; applied_revision: number; desired_revision: number }>(
    "SELECT w.record,coalesce(o.applied_revision,0) applied_revision,coalesce(o.desired_revision,json_extract(w.record,'$.revision')) desired_revision FROM workflow_work_admissions w LEFT JOIN workflow_work_outbox o ON o.run_id=w.run_id AND o.kind='projection' WHERE w.namespace_hash=? AND w.work_id=?",
    boundFingerprint(workNamespaceSchema.parse(namespace)),
    workId,
  );
  if (!row) return null;
  const work = workAdmissionSchema.parse(JSON.parse(row.record));
  return workAdmissionSchema.parse({
    ...work,
    projection: { desired_revision: row.desired_revision, applied_revision: row.applied_revision },
  });
}
