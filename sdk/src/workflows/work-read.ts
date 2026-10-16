import { z } from "zod";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import type { Outcome, Json } from "./types.js";
import type { WorkArtifactRef } from "./work-artifacts.js";
import { WorkflowError } from "./errors.js";
import type { WorkflowStore } from "./workflow-store.js";
import { readCanonicalWork } from "./work-projection.js";
import {
  workAdmissionSchema,
  workNamespaceSchema,
  projectWorkState,
  type WorkAdmission,
  type WorkControl,
  type WorkLog,
  type WorkCommandReport,
} from "./work-contracts.js";

const ref = z.string().min(1).max(200);
const time = z.number().int().nonnegative();
const state = z.enum([
  "queued",
  "running",
  "waiting",
  "waiting-for-approval",
  "stopping",
  "needs-attention",
  "completed",
  "failed",
  "cancelled",
]);
export const workReadScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("namespace"), namespace: workNamespaceSchema }),
  z.strictObject({ kind: z.literal("identity"), installation: ref, identity_id: ref }),
  z.strictObject({ kind: z.literal("installation"), installation: ref }),
]);
export type WorkReadScope = z.infer<typeof workReadScopeSchema>;
export const workListQuerySchema = z
  .strictObject({
    limit: z.number().int().min(1).max(100).default(50),
    states: z.array(state).min(1).max(9).optional(),
    definition_kind: z.enum(["action", "job", "workflow"]).optional(),
    definition_ref: ref.optional(),
    trigger: z.enum(["invocation", "schedule", "event", "internal", "manual"]).optional(),
    after: time.optional(),
    before: time.optional(),
    cursor: z.string().max(2048).optional(),
  })
  .refine(
    (query) =>
      query.after === undefined || query.before === undefined || query.after <= query.before,
    "date range is reversed",
  );
export type WorkListQuery = z.input<typeof workListQuerySchema>;
const cursorSchema = z.strictObject({
  version: z.literal(2),
  query: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: ref,
  sequence: time,
  anchor_at: time,
  anchor_id: ref,
  last_at: time,
  last_id: ref,
});

/** Derived read index is committed with canonical state, never maintained by a replica. */
export function indexCanonicalWork(store: WorkflowStore, input: WorkAdmission): void {
  const work = workAdmissionSchema.parse(input);
  const stored = store.one<{ namespace_hash: string; run_id: string; accepted_at: number }>(
    "SELECT namespace_hash,run_id,accepted_at FROM workflow_work_admissions WHERE work_id=?",
    work.work_id,
  );
  if (
    !stored ||
    stored.namespace_hash !== boundFingerprint(work.namespace) ||
    stored.run_id !== work.workflow_id ||
    stored.accepted_at !== work.accepted_at
  )
    throw new WorkflowError(
      "WorkIndexBindingInvalid",
      "Index differs from canonical admission ownership.",
      409,
    );
  const previous = store.one<{ sequence: number }>(
    "SELECT sequence FROM workflow_work_index WHERE work_id=?",
    work.work_id,
  );
  const sequence =
    previous?.sequence ??
    Number(
      store.one<{ value: string }>(
        "SELECT value FROM workflow_meta WHERE key='work-index-sequence'",
      )!.value,
    ) + 1;
  if (!previous)
    store.run("UPDATE workflow_meta SET value=? WHERE key='work-index-sequence'", String(sequence));
  store.run(
    `INSERT INTO workflow_work_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,revision=excluded.revision WHERE workflow_work_index.revision<=excluded.revision`,
    work.work_id,
    work.workflow_id,
    work.namespace.installation,
    boundFingerprint(work.namespace),
    work.namespace.identity_id,
    projectWorkState(work.facts).state,
    work.plan.definition.kind,
    work.plan.definition.reference,
    work.origin.trigger,
    work.accepted_at,
    work.revision,
    sequence,
  );
}
/** Incremental upgrade. Queries refuse partial counts until all canonical rows are indexed. */
export function backfillWorkIndex(store: WorkflowStore, limit = 64): void {
  if (
    store.one<{ value: string }>("SELECT value FROM workflow_meta WHERE key='work-index-ready'")
      ?.value === "1"
  )
    return;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
    throw new Error("work index batch must be 1..64");
  store.transaction(() => {
    const rows = store.rows<{ record: string }>(
      "SELECT a.record FROM workflow_work_admissions a LEFT JOIN workflow_work_index i ON i.work_id=a.work_id WHERE i.work_id IS NULL ORDER BY a.work_id LIMIT ?",
      limit,
    );
    for (const row of rows)
      indexCanonicalWork(store, workAdmissionSchema.parse(JSON.parse(row.record)));
    if (rows.length < limit)
      store.run("UPDATE workflow_meta SET value='1' WHERE key='work-index-ready'");
  });
}
function scopeWhere(input: WorkReadScope): { clause: string; values: string[] } {
  const scope = workReadScopeSchema.parse(input);
  if (scope.kind === "namespace")
    return {
      clause: "i.namespace_hash=? AND a.namespace_hash=?",
      values: [boundFingerprint(scope.namespace), boundFingerprint(scope.namespace)],
    };
  if (scope.kind === "identity")
    return {
      clause: "i.installation=? AND i.identity_id=? AND i.namespace_hash=a.namespace_hash",
      values: [scope.installation, scope.identity_id],
    };
  return {
    clause: "i.installation=? AND i.namespace_hash=a.namespace_hash",
    values: [scope.installation],
  };
}
export function summarizeWork(
  work: WorkAdmission,
  controls: readonly WorkControl[] = ["inspect", "result"],
) {
  const projection = projectWorkState(work.facts);
  return {
    version: 2 as const,
    work_id: work.work_id,
    workflow_id: work.workflow_id,
    action_id: work.action_id,
    job_run_id: work.job_run_id,
    title: work.title,
    source: work.plan.definition,
    origin: work.origin,
    namespace: work.namespace,
    accepted_at: work.accepted_at,
    first_started_at: work.first_started_at,
    dispatch_deadline: work.dispatch_deadline,
    execution_deadline: work.execution_deadline,
    revision: work.revision,
    state: projection.state,
    facts: work.facts,
    reason: work.reason,
    receipt_ref: work.receipt_ref,
    allowed_actions: projection.allowed_actions.filter((control) => controls.includes(control)),
    can_review_reconciliation: controls.includes("reconcile"),
    projection: work.projection,
  };
}
export function listCanonicalWork(
  store: WorkflowStore,
  scope: WorkReadScope,
  input: WorkListQuery,
  controls?: readonly WorkControl[],
) {
  const query = workListQuerySchema.parse(input),
    normalized = { ...query, states: query.states ? [...new Set(query.states)].sort() : undefined };
  const { cursor: _cursor, limit: _limit, ...filters } = normalized;
  const hash = boundFingerprint({
    scope: workReadScopeSchema.parse(scope),
    filters: Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
  });
  const key = Buffer.from(
    store.one<{ value: string }>("SELECT value FROM workflow_meta WHERE key='work-cursor-key'")!
      .value,
    "hex",
  );
  const epoch = store.one<{ value: string }>(
    "SELECT value FROM workflow_meta WHERE key='epoch'",
  )!.value;
  const seal = (value: z.infer<typeof cursorSchema>) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("barry.work.cursor.v2"));
    const json = Buffer.from(JSON.stringify(value));
    if (json.length > 1024)
      throw new WorkflowError("InvalidWorkCursor", "Cursor metadata exceeds its bound.", 400);
    const padded = Buffer.alloc(1024, 0x20);
    json.copy(padded);
    const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
  };
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(query.cursor)) throw new Error("encoding");
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.length < 29) throw new Error("short cursor");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from("barry.work.cursor.v2"));
      decipher.setAuthTag(bytes.subarray(-16));
      cursor = cursorSchema.parse(
        JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
            "utf8",
          ),
        ),
      );
      if (cursor.query !== hash || cursor.epoch !== epoch)
        throw new Error("scope, filters or recovery generation differ");
    } catch {
      throw new WorkflowError(
        "InvalidWorkCursor",
        "Cursor belongs to another scope/filter or is malformed.",
        400,
      );
    }
  }
  return store.read(() => {
    if (
      store.one<{ value: string }>("SELECT value FROM workflow_meta WHERE key='work-index-ready'")
        ?.value !== "1"
    )
      throw new WorkflowError(
        "WorkIndexPending",
        "Canonical history indexing is in progress; counts are not yet complete.",
        503,
        true,
      );
    const auth = scopeWhere(scope),
      clauses = [auth.clause],
      values: (string | number)[] = [...auth.values];
    if (query.states) {
      clauses.push(`i.state IN (${normalized.states!.map(() => "?").join(",")})`);
      values.push(...normalized.states!);
    }
    for (const [column, value] of [
      ["definition_kind", query.definition_kind],
      ["definition_ref", query.definition_ref],
      ["trigger_kind", query.trigger],
    ] as const)
      if (value !== undefined) {
        clauses.push(`i.${column}=?`);
        values.push(value);
      }
    if (query.after !== undefined) {
      clauses.push("i.accepted_at>=?");
      values.push(query.after);
    }
    if (query.before !== undefined) {
      clauses.push("i.accepted_at<=?");
      values.push(query.before);
    }
    const base = clauses.join(" AND "),
      from = "FROM workflow_work_index i JOIN workflow_work_admissions a ON a.work_id=i.work_id";
    const sequence =
      cursor?.sequence ??
      Number(
        store.one<{ value: string }>(
          "SELECT value FROM workflow_meta WHERE key='work-index-sequence'",
        )!.value,
      );
    const top =
      cursor ??
      store.one<{ anchor_at: number; anchor_id: string }>(
        `SELECT i.accepted_at anchor_at,i.work_id anchor_id ${from} WHERE ${base} ORDER BY i.accepted_at DESC,i.work_id DESC LIMIT 1`,
        ...values,
      );
    if (!top)
      return { items: [], total: 0, counts: {}, next_cursor: null, observed_at: Date.now() };
    clauses.push("(i.accepted_at<? OR (i.accepted_at=? AND i.work_id<=?))");
    values.push(top.anchor_at, top.anchor_at, top.anchor_id);
    clauses.push("i.sequence<=?");
    values.push(sequence);
    const countWhere = clauses.join(" AND ");
    const grouped = store.rows<{ state: string; count: number }>(
      `SELECT i.state,count(*) count ${from} WHERE ${countWhere} GROUP BY i.state`,
      ...values,
    );
    if (cursor) {
      clauses.push("(i.accepted_at<? OR (i.accepted_at=? AND i.work_id<?))");
      values.push(cursor.last_at, cursor.last_at, cursor.last_id);
    }
    const rows = store.rows<{ work_id: string }>(
      `SELECT i.work_id ${from} WHERE ${clauses.join(" AND ")} ORDER BY i.accepted_at DESC,i.work_id DESC LIMIT ?`,
      ...values,
      query.limit + 1,
    );
    const hasMore = rows.length > query.limit,
      selected = rows.slice(0, query.limit);
    const works = selected.map((row) => {
      const canonical = store.one<{ record: string }>(
        "SELECT record FROM workflow_work_admissions WHERE work_id=?",
        row.work_id,
      )!;
      const work = workAdmissionSchema.parse(JSON.parse(canonical.record));
      return readCanonicalWork(store, work.namespace, work.work_id)!;
    });
    const last = works.at(-1);
    return {
      items: works.map((work) => summarizeWork(work, controls)),
      total: grouped.reduce((sum, row) => sum + row.count, 0),
      counts: Object.fromEntries(grouped.map((row) => [row.state, row.count])),
      next_cursor:
        hasMore && last
          ? seal({
              version: 2,
              query: hash,
              epoch,
              sequence,
              anchor_at: top.anchor_at,
              anchor_id: top.anchor_id,
              last_at: last.accepted_at,
              last_id: last.work_id,
            })
          : null,
      observed_at: Date.now(),
    };
  });
}

export interface WorkResult {
  /** Canonical coordinator closure, distinct from physical cessation. */
  closed_at?: number | null;
  action_checks?: { preflight?: WorkCommandReport; postcondition?: WorkCommandReport };
  version: 2;
  work_id: string;
  revision: number;
  status: "pending" | "available";
  receipt_ref: string | null;
  outcome: Outcome | null;
  logs?: { stage: string; reference: WorkArtifactRef; value: WorkLog | null; invalid_reason: string | null }[];
  retained_output: null | {
    reference: WorkArtifactRef;
    value: Json | null;
    invalid_reason: string | null;
    validation: "skipped" | "passed" | "failed" | "unknown";
    validation_failures: string[] | null;
  };
}
/** Public adapters supply this authorization from current trusted caller context, never body scope. */
export class WorkReadService<Credentials> {
  constructor(
    private readonly options: {
      authorize: (
        credentials: Credentials,
        operation: "list" | "inspect" | "lookup" | "result",
        workId?: string,
      ) => Promise<{ scope: WorkReadScope; controls: readonly WorkControl[] }>;
      owner: {
        listWork: typeof listCanonicalWork extends (
          store: WorkflowStore,
          ...args: infer Args
        ) => infer Result
          ? (...args: Args) => Result
          : never;
        workResult: (scope: WorkReadScope, workId: string) => WorkResult;
        scopedWork: (scope: WorkReadScope, workId: string) => WorkAdmission | null;
        workOperation: (
          scope: WorkReadScope,
          key: string,
          session?: string,
        ) => WorkAdmission | null;
      };
    },
  ) {}
  async list(input: WorkListQuery, credentials: Credentials) {
    const query = workListQuerySchema.parse(input),
      authority = await this.options.authorize(credentials, "list");
    return this.options.owner.listWork(authority.scope, query, authority.controls);
  }
  async inspect(workId: string, credentials: Credentials) {
    workId = ref.parse(workId);
    const authority = await this.options.authorize(credentials, "inspect", workId),
      work = this.options.owner.scopedWork(authority.scope, workId);
    if (!work) throw new WorkflowError("WorkNotFound", "Work is unavailable to this caller.", 404);
    return summarizeWork(work, authority.controls);
  }
  async result(workId: string, credentials: Credentials): Promise<WorkResult> {
    workId = ref.parse(workId);
    const authority = await this.options.authorize(credentials, "result", workId);
    if (!authority.controls.includes("result")) throw new WorkflowError("Forbidden", "Current caller cannot read work output.", 403);
    return this.options.owner.workResult(authority.scope, workId);
  }
  async lookupOperation(key: string, credentials: Credentials, session?: string) {
    key = ref.parse(key);
    if (session !== undefined) session = ref.parse(session);
    const authority = await this.options.authorize(credentials, "lookup"),
      work = this.options.owner.workOperation(authority.scope, key, session);
    if (!work)
      throw new WorkflowError("WorkNotFound", "Operation is unavailable to this caller.", 404);
    return summarizeWork(work, authority.controls);
  }
}
export function findCanonicalOperation(
  store: WorkflowStore,
  input: WorkReadScope,
  key: string,
  session?: string,
): WorkAdmission | null {
  const scope = workReadScopeSchema.parse(input);
  ref.parse(key);
  if (session !== undefined) ref.parse(session);
  const clauses = ["idempotency_key=?"],
    values = [key];
  if (scope.kind === "namespace") {
    clauses.push("namespace_hash=?");
    values.push(boundFingerprint(scope.namespace));
  } else {
    clauses.push("json_extract(record,'$.namespace.installation')=?");
    values.push(scope.installation);
    if (scope.kind === "identity") {
      clauses.push("json_extract(record,'$.namespace.identity_id')=?");
      values.push(scope.identity_id);
    }
  }
  if (session !== undefined) {
    clauses.push("json_extract(record,'$.namespace.caller_session_id')=?");
    values.push(session);
  }
  const rows = store.rows<{ work_id: string }>(
    `SELECT work_id FROM workflow_work_admissions WHERE ${clauses.join(" AND ")} LIMIT 2`,
    ...values,
  );
  if (rows.length > 1)
    throw new WorkflowError(
      "WorkOperationAmbiguous",
      "Key appears in multiple authorized origins; supply its originating session or work ID.",
      409,
    );
  return rows.length ? scopedCanonicalWork(store, scope, rows[0].work_id) : null;
}
export function scopedCanonicalWork(
  store: WorkflowStore,
  scope: WorkReadScope,
  workId: string,
): WorkAdmission | null {
  ref.parse(workId);
  scope = workReadScopeSchema.parse(scope);
  const row = store.one<{ record: string; namespace_hash: string }>(
    "SELECT record,namespace_hash FROM workflow_work_admissions WHERE work_id=?",
    workId,
  );
  if (!row) return null;
  const work = workAdmissionSchema.parse(JSON.parse(row.record));
  if (row.namespace_hash !== boundFingerprint(work.namespace))
    throw new WorkflowError("WorkBindingInvalid", "Canonical ownership evidence differs.", 503);
  if (
    scope.kind === "namespace"
      ? row.namespace_hash !== boundFingerprint(scope.namespace)
      : scope.installation !== work.namespace.installation ||
        (scope.kind === "identity" && scope.identity_id !== work.namespace.identity_id)
  )
    return null;
  return readCanonicalWork(store, work.namespace, workId);
}
