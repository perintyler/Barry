import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  ActivityFailure,
  advertisementSchema,
  commandSchema,
  encodeRecord as encode,
  encode as encodePayload,
  encodeCommand,
  identifier,
  outcomeSchema,
  startSchema,
  type ActivityCommand,
  type ActivityTask,
  type Failure,
  type HistoryEvent,
  type Json,
  type LeafCommand,
  type Outcome,
  type StartWorkflow,
  type WorkerAdvertisement,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStatus,
  jobContractSchema,
  jobRunInputSchema,
  type JobContract,
} from "./types.js";
import { WorkflowStore } from "./workflow-store.js";
import { type WorkflowArtifact, verifyArtifact } from "./artifacts.js";
import { ExecutionFault, type ReplayExecutor } from "./executor.js";
import { validateProposal, type ReplaySnapshot, type Proposal } from "./evaluator.js";
import { limits, encode as boundedEncode } from "./types.js";
import type { SQLInputValue } from "node:sqlite";
import { validateAgainstSchema } from "../tools/validate.js";
import { WorkflowError } from "./errors.js";
import { runGrantSchema, grantRequestHash, type RunGrant } from "./grants.js";
import { scopeFingerprint } from "../bounds/execution-scope.js";

interface RunRow {
  id: string;
  owner: string;
  type: string;
  version: string;
  input: string;
  request: string;
  status: WorkflowStatus;
  started_at: number;
  deadline: number;
  outcome: string | null;
  error: string | null;
  revision: number;
  artifact: string | null;
  principal: string;
  budget_bytes: number;
  closed_at: number | null;
  grant_revision: number | null;
}
interface CommandRow {
  id: string;
  run_id: string;
  position: number;
  slot: number;
  definition: string;
  state: "pending" | "leased" | "done" | "cancelled";
  outcome: string | null;
  deadline: number;
  ready_at: number;
  attempts: number;
  token: string | null;
  lease_until: number | null;
  attempt_deadline: number | null;
}
interface AttemptRow {
  token: string;
  command_id: string;
  worker: string;
  state: string;
  outcome: string | null;
}
type Advertisement = ReturnType<typeof advertisementSchema.parse> & { expiresAt: number };
class ReplayMismatch extends Error {}
class AuthoredFault extends Error {}
function authored<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new AuthoredFault(errorMessage(error));
  }
}
const failed = (code: string, message: string, retryable = false): Outcome => ({
  ok: false,
  error: { code, message, retryable },
});
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4096);

export class WorkflowOwner {
  readonly id: string;
  private readonly store: WorkflowStore;
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly workers = new Map<string, Advertisement>();
  private readonly sessions = new Map<string, string>();
  private readonly clock: () => number;
  private readonly artifacts = new Map<string, WorkflowArtifact>();
  private readonly activityArtifacts: Record<string, string>;
  /** A worker name in a node bound, mapped to the worker id the owner assigned; ids pass through. */
  private readonly permitsWorkerJob: (worker: string, type: string) => boolean;
  private readonly onWorkerSession?: (worker: string, takeover: boolean) => void;
  private readonly resolveNode: (reference: string) => string;
  private readonly executor?: ReplayExecutor;
  private readonly authorize?: (
    run: { principal: string; type: string; authorizer?: string },
    activityType: string,
  ) => boolean;
  private readonly workerProfiles: Record<string, string[]>;
  private pumping: Promise<void> | null = null;
  private closed = false;

  constructor(options: {
    id: string;
    path: string;
    definitions?: WorkflowDefinition[];
    artifacts?: WorkflowArtifact[];
    activityArtifacts?: Record<string, string>;
    executor?: ReplayExecutor;
    now?: () => number;
    authorize?: (
      run: { principal: string; type: string; authorizer?: string },
      activityType: string,
    ) => boolean;
    workerProfiles?: Record<string, string[]>;
    resolveNode?: (reference: string) => string;
    jobs?: JobContract[];
    permitsWorkerJob?: (worker: string, type: string) => boolean;
    onWorkerSession?: (worker: string, takeover: boolean) => void;
  }) {
    this.id = identifier.parse(options.id);
    this.permitsWorkerJob = options.permitsWorkerJob ?? (() => true);
    this.onWorkerSession = options.onWorkerSession;
    this.resolveNode = options.resolveNode ?? ((reference) => reference);
    this.clock = options.now ?? Date.now;
    this.executor = options.executor;
    this.authorize = options.authorize;
    this.workerProfiles = structuredClone(options.workerProfiles ?? {});
    this.activityArtifacts = { ...options.activityArtifacts };
    const jobs = (options.jobs ?? []).map((job) => jobContractSchema.parse(job));
    // A job runs as an activity of its own type, pinned to its bundle like any other activity.
    for (const job of jobs) {
      if (this.activityArtifacts[job.type] && this.activityArtifacts[job.type] !== job.digest)
        throw new Error(`job ${job.type} and an activity of the same type name different code`);
      this.activityArtifacts[job.type] = job.digest;
    }
    for (const definition of options.definitions ?? []) {
      const key = encode([identifier.parse(definition.type), identifier.parse(definition.version)]);
      if (this.definitions.has(key)) throw new Error(`duplicate workflow definition ${key}`);
      this.definitions.set(key, definition);
    }
    this.store = new WorkflowStore(options.path, this.id);
    try {
      for (const [type, digest] of Object.entries(this.activityArtifacts)) {
        identifier.parse(type);
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid activity artifact digest");
        this.store.transaction(() => {
          const previous = this.store.one<{ digest: string }>(
            "SELECT digest FROM workflow_artifacts WHERE type=? AND version='activity'",
            type,
          );
          if (previous && previous.digest !== digest)
            throw new Error(
              "activity type already pinned to different code; register a new type version",
            );
          this.store.run(
            "INSERT OR IGNORE INTO workflow_artifacts VALUES(?,'activity',?)",
            type,
            digest,
          );
        });
      }
      for (const job of jobs) {
        const contract = encode(job);
        this.store.transaction(() => {
          const previous = this.store.one<{ contract: string }>(
            "SELECT contract FROM workflow_job_contracts WHERE type=?",
            job.type,
          );
          if (previous && previous.contract !== contract)
            throw new Error(`job ${job.type} changed its contract in place; give it a new version`);
          this.store.run(
            "INSERT OR IGNORE INTO workflow_job_contracts VALUES(?,?,?)",
            job.type,
            job.digest,
            contract,
          );
        });
      }
      for (const artifact of options.artifacts ?? []) {
        if (!this.executor) throw new Error("artifact execution requires an isolated executor");
        verifyArtifact(artifact);
        const key = encode([artifact.type, artifact.version]);
        if (this.artifacts.has(key) || this.definitions.has(key))
          throw new Error("duplicate artifact definition");
        this.store.transaction(() => {
          const previous = this.store.one<{ digest: string }>(
            "SELECT digest FROM workflow_artifacts WHERE type=? AND version=?",
            artifact.type,
            artifact.version,
          );
          if (previous && previous.digest !== artifact.digest)
            throw new Error("artifact version already registered with a different digest");
          this.store.run(
            "INSERT OR IGNORE INTO workflow_artifacts VALUES(?,?,?)",
            artifact.type,
            artifact.version,
            artifact.digest,
          );
        });
        this.artifacts.set(key, artifact);
      }
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  get asynchronous(): boolean {
    return Boolean(this.executor);
  }
  get storageAccounted(): boolean {
    return this.store.accounted;
  }
  probeStorage(): void {
    this.store.transaction(() =>
      this.store.run("UPDATE workflow_meta SET value=value WHERE key='epoch'"),
    );
  }
  get epoch(): string {
    return this.store.one<{ value: string }>("SELECT value FROM workflow_meta WHERE key='epoch'")!
      .value;
  }

  start(
    request: StartWorkflow,
    principal = "local-operator",
    policyRef?: string,
    approvedGrant?: RunGrant,
  ): WorkflowRun {
    identifier.parse(principal);
    encode(request);
    const input = startSchema.parse(request);
    if (input.type === "job" && input.version === "1") input.input = this.admitJob(input.input);
    encodePayload(input.input);
    const serialized = encode(input);
    if (input.job) {
      if (!approvedGrant)
        throw new WorkflowError(
          "JobAuthorizationRequired",
          "Run traits require an approved execution grant.",
          403,
        );
      approvedGrant = runGrantSchema.parse(approvedGrant);
      if (
        approvedGrant.revision !== 1 ||
        approvedGrant.authorizer !== principal ||
        approvedGrant.createdBy !== principal ||
        scopeFingerprint(input.job) !== scopeFingerprint(approvedGrant.job)
      )
        throw new WorkflowError(
          "InvalidGrant",
          "Approved grant does not match the submitting principal and run request.",
          403,
        );
      encodePayload(approvedGrant);
    } else if (approvedGrant)
      throw new WorkflowError("InvalidGrant", "A grant requires an explicit run request.", 400);
    return this.store.transaction(() => {
      const archived = this.store.one<{ request_hash: string; summary: string }>(
        "SELECT request_hash,summary FROM workflow_tombstones WHERE id=?",
        input.id,
      );
      if (archived) {
        const summary = JSON.parse(archived.summary) as WorkflowRun;
        if (summary.principal !== principal) throw new Error("unknown workflow");
        if (archived.request_hash !== createHash("sha256").update(serialized).digest("hex"))
          throw new Error("workflow ID already has a different start request");
        return JSON.parse(archived.summary) as WorkflowRun;
      }
      const previous = this.row(input.id);
      if (previous) {
        if (previous.principal !== principal) throw new Error("unknown workflow");
        if (previous.request !== serialized)
          throw new Error("workflow ID already has a different start request");
        return this.describe(previous);
      }
      const key = encode([input.type, input.version]),
        artifact = this.artifacts.get(key);
      if (!this.definitions.has(key) && !artifact) throw new Error("unknown workflow definition");
      if (
        this.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_runs WHERE status IN ('running','blocked')",
        )!.count >= 1000
      )
        throw new Error("open workflow admission limit reached");
      if (
        this.store.one<{ count: number }>("SELECT count(*) count FROM workflow_tombstones")!
          .count >= 1_000_000
      )
        throw new Error("run tombstone admission limit reached");
      const at = this.clock();
      this.store.admit(
        Number(
          this.store.one<{ value: string }>(
            "SELECT value FROM workflow_meta WHERE key='reserved-bytes'",
          )!.value,
        ) +
          Buffer.byteLength(serialized) * 3 +
          1_048_576,
      );
      this.store.run(
        "INSERT INTO workflow_runs(id,owner,type,version,input,request,status,started_at,deadline) VALUES(?,?,?,?,?,?,'running',?,?)",
        input.id,
        this.id,
        input.type,
        input.version,
        encode(input.input),
        serialized,
        at,
        at + input.timeoutMs,
      );
      this.store.run("UPDATE workflow_runs SET principal=? WHERE id=?", principal, input.id);
      if (approvedGrant) {
        this.store.run(
          "INSERT INTO workflow_grants VALUES(?,1,?)",
          input.id,
          encode(approvedGrant),
        );
        this.store.run("UPDATE workflow_runs SET grant_revision=1 WHERE id=?", input.id);
        this.reserve(input.id, Buffer.byteLength(encode(approvedGrant)) + 512);
      }
      if (policyRef)
        this.store.run(
          "UPDATE workflow_runs SET policy_ref=? WHERE id=?",
          identifier.parse(policyRef),
          input.id,
        );
      // Pre-reserve bounded operator receipts so cancellation remains possible at high water.
      this.reserve(input.id, Buffer.byteLength(serialized) * 3 + 1_048_576);
      if (artifact)
        this.store.run("UPDATE workflow_runs SET artifact=? WHERE id=?", artifact.digest, input.id);
      this.store.event(input.id, at, "WorkflowStarted", {
        type: input.type,
        version: input.version,
        actor: principal,
        requestId: input.id,
      });
      this.advance(this.required(input.id), at);
      return this.describe(this.required(input.id));
    });
  }

  get(id: string): WorkflowRun {
    const archived = this.store.one<{ summary: string }>(
      "SELECT summary FROM workflow_tombstones WHERE id=?",
      id,
    );
    return archived
      ? (JSON.parse(archived.summary) as WorkflowRun)
      : this.describe(this.required(id));
  }
  grant(id: string): RunGrant | undefined {
    const row = this.store.one<{ evidence: string }>(
      "SELECT g.evidence FROM workflow_grants g JOIN workflow_runs r ON r.id=g.run_id AND r.grant_revision=g.revision WHERE g.run_id=?",
      id,
    );
    return row ? runGrantSchema.parse(JSON.parse(row.evidence)) : undefined;
  }
  /** Online effect authority check. Never accepts an expired/replaced attempt. */
  effectAuthority(
    worker: string,
    token: string,
    revision: number,
  ): { task: { runId: string; stepId: string; epoch: string }; grant: RunGrant } {
    return this.store.transaction(() => {
      const command = this.activeAttempt(worker, token, this.clock());
      if (!command)
        throw new WorkflowError(
          "AttemptRevoked",
          "Attempt no longer holds execution authority.",
          403,
        );
      const grant = this.grant(command.run_id);
      if (!grant || grant.revision !== revision)
        throw new WorkflowError("GrantRevoked", "Run grant is missing or has changed.", 403);
      return { task: { runId: command.run_id, stepId: command.id, epoch: this.epoch }, grant };
    });
  }
  blockExecution(id: string, reason: string): void {
    this.store.transaction(() => {
      const run = this.required(id);
      if (run.status === "running") this.block(run, reason.slice(0, 4096), this.clock());
    });
  }
  bindSession(
    id: string,
    stepId: string,
    sessionId: string,
    turnId: string,
    state = "active",
  ): void {
    identifier.parse(id);
    identifier.parse(stepId);
    identifier.parse(sessionId);
    if (!turnId || turnId.length > 500 || !["active", "complete"].includes(state))
      throw new Error("invalid session turn binding");
    const hash = scopeFingerprint({ id, stepId, sessionId, turnId });
    this.store.transaction(() => {
      this.required(id);
      if (
        !this.grant(id) ||
        !this.store.one("SELECT 1 FROM workflow_commands WHERE run_id=? AND id=?", id, stepId)
      )
        throw new Error("session binding requires a granted workflow step");
      const previous = this.store.one<{ request_hash: string }>(
        "SELECT request_hash FROM workflow_session_bindings WHERE run_id=? AND step_id=?",
        id,
        stepId,
      );
      if (previous && previous.request_hash !== hash)
        throw new Error("session step binding conflict");
      if (!previous)
        this.reserve(id, Buffer.byteLength(encode({ stepId, sessionId, turnId })) + 512);
      this.store.run(
        "INSERT INTO workflow_session_bindings VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET state=excluded.state",
        id,
        stepId,
        hash,
        sessionId,
        turnId,
        state,
      );
      if (!previous)
        this.store.event(id, this.clock(), "SessionTurnBound", { stepId, sessionId, turnId });
    });
  }
  reauthorize(
    id: string,
    approved: RunGrant,
    requestId: string,
    expectedRevision: number,
    actor: string,
  ): WorkflowRun {
    identifier.parse(requestId);
    identifier.parse(actor);
    approved = runGrantSchema.parse(approved);
    encodePayload(approved);
    const request = encode({
      operation: "reauthorize",
      job: approved.job,
      reason: approved.reason,
      expectedRevision,
      actor,
    });
    return this.store.transaction(() => {
      const old = this.store.one<{ request: string; response: string }>(
        "SELECT request,response FROM workflow_receipts WHERE run_id=? AND id=?",
        id,
        requestId,
      );
      if (old) {
        if (old.request !== request) throw new Error("mutation request ID conflict");
        return JSON.parse(old.response) as WorkflowRun;
      }
      const run = this.required(id),
        previous = this.grant(id);
      if (
        !previous ||
        !["running", "blocked"].includes(run.status) ||
        run.revision !== expectedRevision
      )
        throw new Error("reauthorization requires a current open run");
      if (
        approved.revision !== previous.revision + 1 ||
        approved.authorizer !== actor ||
        approved.createdBy !== previous.createdBy ||
        approved.scope.identity !== previous.scope.identity ||
        approved.scope.harness !== previous.scope.harness
      )
        throw new Error("invalid grant revision or identity change");
      if (
        grantRequestHash({
          ...approved,
          job: { ...approved.job, traits: previous.job.traits },
          authorizer: previous.authorizer,
        }) !== grantRequestHash(previous)
      )
        throw new Error("reauthorization cannot change action or execution profile");
      if (
        this.store.one(
          "SELECT 1 FROM workflow_commands WHERE run_id=? AND state='leased' LIMIT 1",
          id,
        ) ||
        this.store.one(
          "SELECT 1 FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=? AND a.physical_state!='settled' LIMIT 1",
          id,
        ) ||
        this.store.one(
          "SELECT 1 FROM workflow_session_bindings WHERE run_id=? AND state!='complete' LIMIT 1",
          id,
        ) ||
        run.error?.startsWith("OutcomeUnknown")
      )
        throw new WorkflowError(
          "ReconciliationRequired",
          "Settle or reconcile outstanding work before reauthorization.",
          409,
        );
      if (
        this.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_grants WHERE run_id=?",
          id,
        )!.count >= 64 ||
        this.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_receipts WHERE run_id=?",
          id,
        )!.count >= 64
      )
        throw new Error("grant or receipt limit reached");
      this.reserve(id, Buffer.byteLength(encode(approved)) + 512);
      this.store.run(
        "INSERT INTO workflow_grants VALUES(?,?,?)",
        id,
        approved.revision,
        encode(approved),
      );
      this.store.run("UPDATE workflow_runs SET grant_revision=? WHERE id=?", approved.revision, id);
      this.store.event(id, this.clock(), "JobReauthorized", {
        actor,
        requestId,
        grantRevision: approved.revision,
        reason: approved.reason,
        scopeFingerprint: approved.scope.fingerprint,
      });
      const result = { ...this.describe(this.required(id)), input: null, outcome: null };
      this.store.run(
        "INSERT INTO workflow_receipts VALUES(?,?,?,?)",
        id,
        requestId,
        request,
        encode(result),
      );
      return result;
    });
  }
  receipt(id: string, requestId: string): WorkflowRun | null {
    const row = this.store.one<{ response: string }>(
      "SELECT response FROM workflow_receipts WHERE run_id=? AND id=?",
      id,
      identifier.parse(requestId),
    );
    return row ? (JSON.parse(row.response) as WorkflowRun) : null;
  }
  resources(id: string) {
    const run = this.required(id),
      grant = this.grant(id);
    const timing = this.store.one<{
      firstStarted: number | null;
      lastSettled: number | null;
      leased: number;
      physicalRunning: number;
      physicalUnknown: number;
    }>(
      "SELECT min(a.started_at) firstStarted,max(a.settled_at) lastSettled,sum(CASE WHEN a.state='active' THEN 1 ELSE 0 END) leased,sum(CASE WHEN a.physical_state='running' THEN 1 ELSE 0 END) physicalRunning,sum(CASE WHEN a.physical_state='unknown' THEN 1 ELSE 0 END) physicalUnknown FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?",
      id,
    )!;
    const bindings = this.store.rows<{
      stepId: string;
      sessionId: string;
      turnId: string;
      state: string;
    }>(
      "SELECT step_id stepId,session_id sessionId,turn_id turnId,state FROM workflow_session_bindings WHERE run_id=? ORDER BY step_id LIMIT 100",
      id,
    );
    const input = {
      hash: createHash("sha256").update(run.input).digest("hex"),
      bytes: Buffer.byteLength(run.input),
    };
    return {
      profile: grant?.job.profile ?? "portable",
      containmentEvidence: "not-observed",
      observedAt: this.clock(),
      queueDelayMs: timing.firstStarted === null ? null : timing.firstStarted - run.started_at,
      lastLogicalSettlementAt: timing.lastSettled,
      logicalLeases: timing.leased ?? 0,
      physicalRunning: timing.physicalRunning ?? 0,
      physicalUnknown: timing.physicalUnknown ?? 0,
      bindings,
      input,
      deadline: run.deadline,
    };
  }
  mutate(
    id: string,
    operation: "cancel" | "resume",
    requestId: string,
    expectedRevision: number,
    actor = "local-operator",
  ): WorkflowRun {
    identifier.parse(requestId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("invalid expected revision");
    const request = encode({ operation, expectedRevision, actor });
    return this.store.transaction(() => {
      const receipt = this.store.one<{ request: string; response: string }>(
        "SELECT request,response FROM workflow_receipts WHERE run_id=? AND id=?",
        id,
        requestId,
      );
      if (receipt) {
        if (receipt.request !== request) throw new Error("mutation request ID conflict");
        return JSON.parse(receipt.response) as WorkflowRun;
      }
      if (
        this.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_receipts WHERE run_id=?",
          id,
        )!.count >= 64
      )
        throw new Error("mutation receipt limit reached");
      const run = this.required(id);
      if (run.revision !== expectedRevision) throw new Error("stale workflow revision");
      if (operation === "cancel") {
        if (run.status === "running" || run.status === "blocked")
          this.finish(run, "cancelled", failed("Cancelled", "workflow cancelled"), this.clock());
      } else {
        if (run.status !== "blocked") throw new Error("only blocked workflows can resume");
        this.checkResume(run);
        this.store.run("UPDATE workflow_runs SET status='running',error=NULL WHERE id=?", id);
        this.store.event(id, this.clock(), "WorkflowResumed", { actor, requestId });
        this.reconcile(this.required(id), this.clock());
        this.advance(this.required(id), this.clock());
      }
      this.store.event(id, this.clock(), "OperatorMutation", { operation, actor, requestId });
      const described = this.describe(this.required(id));
      const result = {
        ...described,
        input: null,
        outcome: described.outcome?.ok === false ? described.outcome : null,
      };
      this.store.run(
        "INSERT INTO workflow_receipts VALUES(?,?,?,?)",
        id,
        requestId,
        request,
        encode(result),
      );
      return result;
    });
  }
  /** Retention is explicitly invoked; no open run is ever collected. At most 64 rows per child table. */
  prune(
    before: number,
    archived?: (run: { id: string; revision: number; status: string }) => boolean,
  ): boolean {
    if (!Number.isSafeInteger(before)) throw new Error("invalid retention cutoff");
    if (!this.store.accounted) return false;
    return this.store.transaction(() => {
      const run = this.store.one<RunRow>(
        "SELECT r.* FROM workflow_runs r WHERE closed_at<? AND retention_hold=0 AND NOT EXISTS(SELECT 1 FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=r.id AND a.physical_state!='settled') AND NOT EXISTS(SELECT 1 FROM workflow_session_bindings b WHERE b.run_id=r.id AND b.state!='complete') ORDER BY closed_at,id LIMIT 1",
        before,
      );
      if (!run) return false;
      if (archived && !archived(run)) return false;
      const summary = {
        ...this.describe(run),
        input: null,
        outcome: null,
        error: "RunArchived: details expired under retention policy",
      };
      this.store.run(
        "INSERT OR IGNORE INTO workflow_tombstones VALUES(?,?,?,?,?)",
        run.id,
        createHash("sha256").update(run.request).digest("hex"),
        run.principal,
        encode(summary),
        run.closed_at,
      );
      this.store.run(
        "DELETE FROM workflow_attempts WHERE token IN (SELECT a.token FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=? LIMIT 64)",
        run.id,
      );
      this.store.run(
        "DELETE FROM workflow_commands WHERE id IN (SELECT c.id FROM workflow_commands c WHERE c.run_id=? AND NOT EXISTS(SELECT 1 FROM workflow_attempts a WHERE a.command_id=c.id) AND NOT EXISTS(SELECT 1 FROM workflow_session_bindings b WHERE b.run_id=c.run_id AND b.step_id=c.id) LIMIT 64)",
        run.id,
      );
      for (const table of [
        "workflow_events",
        "workflow_signals",
        "workflow_groups",
        "workflow_receipts",
        "workflow_payloads",
        "workflow_candidate_cursor",
        "workflow_session_bindings",
      ])
        this.store.run(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE run_id=? LIMIT 64)`,
          run.id,
        );
      this.store.run("DELETE FROM workflow_due WHERE run_id=?", run.id);
      const remaining = [
        "workflow_commands",
        "workflow_events",
        "workflow_signals",
        "workflow_groups",
        "workflow_receipts",
        "workflow_payloads",
        "workflow_candidate_cursor",
        "workflow_session_bindings",
      ].some((table) => this.store.one(`SELECT 1 FROM ${table} WHERE run_id=? LIMIT 1`, run.id));
      if (!remaining) {
        this.store.run(
          "UPDATE workflow_meta SET value=CAST(max(0,CAST(value AS INTEGER)-?) AS TEXT) WHERE key='reserved-bytes'",
          run.budget_bytes,
        );
        this.store.run("DELETE FROM workflow_runs WHERE id=?", run.id);
      }
      return true;
    });
  }
  retentionHold(id: string, hold: boolean): void {
    this.store.transaction(() => {
      this.required(id);
      this.store.run("UPDATE workflow_runs SET retention_hold=? WHERE id=?", hold ? 1 : 0, id);
    });
  }
  list(
    options: {
      status?: WorkflowStatus;
      search?: string;
      limit?: number;
      offset?: number;
      metadataOnly?: boolean;
      principal?: string;
    } = {},
  ): WorkflowRun[] {
    const total = this.store.one<{ total: number }>(
      "SELECT coalesce(sum(total),0) total FROM workflow_counts WHERE scope=?",
      options.principal ? `principal:${options.principal}` : "*",
    )!.total;
    if (total > 1000)
      throw new Error("legacy list limit reached; use keyset listPage or /api/v2/runs");
    const limit = this.pageSize(options.limit ?? 100);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid offset");
    const columns = options.metadataOnly
      ? "id,owner,type,version,'null' input,'' request,status,started_at,deadline,NULL outcome,error,revision,artifact,principal,grant_revision"
      : "*";
    const rows = this.store.rows<RunRow>(
      `SELECT ${columns} FROM workflow_runs WHERE (?='' OR principal=?) AND (?='' OR status=?) AND (instr(id,?)>0 OR instr(type,?)>0) ORDER BY started_at DESC,id LIMIT ? OFFSET ?`,
      options.principal ?? "",
      options.principal ?? "",
      options.status ?? "",
      options.status ?? "",
      options.search ?? "",
      options.search ?? "",
      limit,
      offset,
    );
    return rows.map((row) => this.describe(row));
  }
  listPage(
    options: {
      status?: WorkflowStatus;
      prefix?: string;
      type?: string;
      identity?: string;
      creator?: string;
      worker?: string;
      blockingReason?:
        | "PolicyRevoked"
        | "OutcomeUnknown"
        | "SessionBusy"
        | "ReconciliationRequired"
        | "RequiredContainmentUnavailable";
      profile?: "portable" | "resource-contained";
      startedAfter?: number;
      startedBefore?: number;
      limit?: number;
      cursor?: string;
      principal?: string;
    } = {},
  ) {
    const limit = Math.min(100, this.pageSize(options.limit ?? 50));
    for (const value of [options.startedAfter, options.startedBefore])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error("invalid start time filter");
    if (
      options.startedAfter !== undefined &&
      options.startedBefore !== undefined &&
      options.startedAfter >= options.startedBefore
    )
      throw new Error("invalid start time range");
    for (const value of [options.identity, options.creator, options.worker])
      if (value !== undefined) identifier.parse(value);
    if (options.profile && !["portable", "resource-contained"].includes(options.profile))
      throw new Error("invalid execution profile filter");
    const scope = encode({
      status: options.status ?? null,
      prefix: options.prefix ?? "",
      type: options.type ?? null,
      identity: options.identity ?? null,
      creator: options.creator ?? null,
      worker: options.worker ?? null,
      blockingReason: options.blockingReason ?? null,
      profile: options.profile ?? null,
      startedAfter: options.startedAfter ?? null,
      startedBefore: options.startedBefore ?? null,
      principal: options.principal ?? null,
    });
    const clauses: string[] = [],
      values: SQLInputValue[] = [];
    if (options.principal) {
      clauses.push("principal=?");
      values.push(options.principal);
    }
    if (options.status) {
      clauses.push("status=?");
      values.push(options.status);
    }
    if (options.type) {
      clauses.push("type=?");
      values.push(options.type);
    }
    if (options.identity) {
      clauses.push("json_extract(request,'$.job.identity')=?");
      values.push(options.identity);
    }
    if (options.creator) {
      clauses.push("principal=?");
      values.push(options.creator);
    }
    if (options.worker) {
      clauses.push(
        "EXISTS (SELECT 1 FROM workflow_commands c JOIN workflow_attempts a ON a.command_id=c.id WHERE c.run_id=workflow_runs.id AND a.worker=?)",
      );
      values.push(options.worker);
    }
    if (options.blockingReason) {
      clauses.push("status='blocked' AND error LIKE ?");
      values.push(`${options.blockingReason}:%`);
    }
    if (options.profile) {
      clauses.push("json_extract(request,'$.job.profile')=?");
      values.push(options.profile);
    }
    if (options.startedAfter !== undefined) {
      clauses.push("started_at>=?");
      values.push(options.startedAfter);
    }
    if (options.startedBefore !== undefined) {
      clauses.push("started_at<?");
      values.push(options.startedBefore);
    }
    if (options.prefix) {
      clauses.push("id>=? AND id<?");
      values.push(options.prefix, `${options.prefix}\u{10ffff}`);
    }
    if (options.cursor) {
      if (options.cursor.length > 4096) throw new Error("invalid page cursor");
      const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()) as {
        scope: string;
        at: number;
        id: string;
      };
      if (
        cursor.scope !== scope ||
        !Number.isSafeInteger(cursor.at) ||
        typeof cursor.id !== "string"
      )
        throw new Error("invalid page cursor scope");
      clauses.push("(started_at<? OR (started_at=? AND id>?))");
      values.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = this.store.rows<RunRow>(
      `SELECT id,owner,type,version,'null' input,'' request,status,started_at,deadline,CASE WHEN json_extract(outcome,'$.ok')=0 THEN outcome ELSE NULL END outcome,error,revision,artifact,principal,grant_revision FROM workflow_runs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at DESC,id LIMIT ?`,
      ...values,
      limit + 1,
    );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map((row) => this.describe(row)),
      observedAt: this.clock(),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(encode({ scope, at: last.started_at, id: last.id })).toString("base64url")
          : null,
    };
  }
  overview(principal?: string): {
    owner: string;
    counts: Record<string, number>;
    definitions: { type: string; version: string }[];
    workers: (Advertisement & { id: string; active: number })[];
  } {
    return this.store.read(() => ({
      owner: this.id,
      counts: Object.fromEntries(
        this.store
          .rows<{ status: string; count: number }>(
            "SELECT status,total count FROM workflow_counts WHERE scope=?",
            principal ? `principal:${principal}` : "*",
          )
          .map((row) => [row.status, row.count]),
      ),
      definitions: [...this.definitions.values(), ...this.artifacts.values()].map(
        ({ type, version }) => ({ type, version }),
      ),
      workers: principal
        ? []
        : [...this.workers.entries()]
            .filter(([, worker]) => worker.expiresAt > this.clock())
            .map(([id, worker]) => ({
              ...worker,
              types: worker.types.slice(0, 20),
              labels: Object.fromEntries(Object.entries(worker.labels).slice(0, 8)),
              artifacts: {},
              id,
              active: this.store.one<{ count: number }>(
                "SELECT count(*) AS count FROM workflow_attempts WHERE worker=? AND state='active'",
                id,
              )!.count,
            })),
    }));
  }
  workerDetails(id: string): unknown {
    const worker = this.workers.get(id);
    if (!worker) throw new Error("unknown worker");
    return { ...worker, id, observedAt: this.clock() };
  }
  auditDenial(
    principal: string | undefined,
    operation: string,
    reason: string,
    target: string,
    requestId: string,
  ): void {
    identifier.parse(requestId);
    this.store.transaction(() => {
      const at = this.clock(),
        actor = (principal ?? "unverified").slice(0, 200),
        action = operation.slice(0, 200),
        code = reason.slice(0, 200);
      this.store.run(
        "DELETE FROM workflow_policy_denials WHERE key IN (SELECT key FROM workflow_policy_denials WHERE last_at<? ORDER BY last_at LIMIT 64)",
        at - 30 * 86_400_000,
      );
      const hash = createHash("sha256").update(target).digest("hex"),
        key = createHash("sha256")
          .update(encode([actor, action, code, hash, Math.floor(at / 60_000)]))
          .digest("hex");
      const existing = this.store.one("SELECT 1 FROM workflow_policy_denials WHERE key=?", key);
      if (
        !existing &&
        this.store.one<{ n: number }>("SELECT count(*) n FROM workflow_policy_denials")!.n >= 2047
      ) {
        // Bound adversarial cardinality; never silently lose the denial count.
        this.store.run(
          "INSERT INTO workflow_policy_denials VALUES('overflow','aggregated','any','AuditCapacity','',?,?,1,?) ON CONFLICT(key) DO UPDATE SET last_at=excluded.last_at,count=count+1,last_request_id=excluded.last_request_id",
          at,
          at,
          requestId,
        );
      } else
        this.store.run(
          "INSERT INTO workflow_policy_denials VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET last_at=excluded.last_at,count=count+1,last_request_id=excluded.last_request_id",
          key,
          actor,
          action,
          code,
          hash,
          at,
          at,
          requestId,
        );
    });
  }
  policyDenials(after = "") {
    if (after.length > 64) throw new Error("invalid audit cursor");
    const items = this.store.rows<{ key: string }>(
      "SELECT key,principal,operation,reason,target_hash targetHash,first_at firstAt,last_at lastAt,count,last_request_id lastRequestId FROM workflow_policy_denials WHERE key>? ORDER BY key LIMIT 50",
      after,
    );
    return { items, nextCursor: items.length === 50 ? items.at(-1)!.key : null };
  }
  inspect(
    id: string,
    options: { after?: string; limit?: number; metadataOnly?: boolean } = {},
  ): {
    run: WorkflowRun;
    nextCursor: string | null;
    commands: {
      id: string;
      position: number;
      slot: number;
      definition: LeafCommand;
      state: string;
      outcome: Outcome | null;
      deadline: number;
      readyAt: number;
      leaseUntil: number | null;
      attemptCount: number;
      attempts: { worker: string; attempt: number; state: string; outcome: Outcome | null }[];
    }[];
  } {
    const limit = this.pageSize(options.limit ?? (options.metadataOnly ? 50 : 500));
    const after = options.after ? Number(options.after) : -1;
    if (!Number.isSafeInteger(after) || after < -1) throw new Error("invalid command cursor");
    const columns = options.metadataOnly
      ? "id,run_id,position,slot,json_remove(definition,'$.input') definition,state,CASE WHEN json_extract(outcome,'$.ok')=0 THEN outcome ELSE NULL END outcome,deadline,ready_at,attempts,token,lease_until,attempt_deadline"
      : "*";
    return this.store.read(() => {
      const run = this.get(id);
      if (this.store.one("SELECT 1 FROM workflow_tombstones WHERE id=?", id))
        return { run, nextCursor: null, commands: [] };
      const commands = this.store.rows<CommandRow>(
        `SELECT ${columns} FROM workflow_commands WHERE run_id=? AND position*100+slot>? ORDER BY position,slot LIMIT ?`,
        id,
        after,
        limit,
      );
      return {
        run: options.metadataOnly
          ? { ...run, input: null, outcome: run.outcome?.ok === false ? run.outcome : null }
          : run,
        nextCursor:
          commands.length === limit
            ? String(commands.at(-1)!.position * 100 + commands.at(-1)!.slot)
            : null,
        commands: commands.map((command) => ({
          id: command.id,
          position: command.position,
          slot: command.slot,
          definition: JSON.parse(command.definition) as LeafCommand,
          state: command.state,
          outcome: command.outcome ? (JSON.parse(command.outcome) as Outcome) : null,
          deadline: command.deadline,
          readyAt: command.ready_at,
          leaseUntil: command.lease_until,
          attemptCount: command.attempts,
          attempts: options.metadataOnly
            ? []
            : this.store
                .rows<{ worker: string; attempt: number; state: string; outcome: string | null }>(
                  "SELECT worker,attempt,state,outcome FROM workflow_attempts WHERE command_id=? ORDER BY attempt LIMIT 100",
                  command.id,
                )
                .map((attempt) => ({
                  ...attempt,
                  outcome: attempt.outcome ? (JSON.parse(attempt.outcome) as Outcome) : null,
                })),
        })),
      };
    });
  }
  commandDetails(id: string, commandId: string, after = 0): unknown {
    this.required(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid attempt cursor");
    const command = this.store.one<CommandRow>(
      "SELECT * FROM workflow_commands WHERE run_id=? AND id=?",
      id,
      commandId,
    );
    if (!command) throw new Error("unknown command");
    const attempts = this.store.rows<{ worker: string; attempt: number; state: string }>(
      "SELECT worker,attempt,state,started_at startedAt,settled_at settledAt,json_extract(outcome,'$.error.code') errorCode FROM workflow_attempts WHERE command_id=? AND attempt>? ORDER BY attempt LIMIT 50",
      commandId,
      after,
    );
    return {
      definition: JSON.parse(command.definition),
      outcome: command.outcome ? JSON.parse(command.outcome) : null,
      attempts,
      observedAt: this.clock(),
      revision: this.required(id).revision,
      nextCursor: attempts.length === 50 ? attempts.at(-1)!.attempt : null,
    };
  }
  eligibility(id: string, after = -1, showWorkers = false) {
    const run = this.required(id),
      at = this.clock();
    if (!Number.isSafeInteger(after) || after < -1) throw new Error("invalid eligibility cursor");
    const occupancy = new Map(
      this.store
        .rows<{ worker: string; active: number }>(
          "SELECT worker,count(*) active FROM workflow_attempts WHERE state='active' GROUP BY worker",
        )
        .map((row) => [row.worker, row.active]),
    );
    const commands = this.store.rows<CommandRow>(
      "SELECT * FROM workflow_commands WHERE run_id=? AND position*100+slot>? ORDER BY position,slot LIMIT 50",
      id,
      after,
    );
    const items = commands.map((command) => {
      const definition = JSON.parse(command.definition) as LeafCommand;
      let reason =
        command.state === "done" || command.state === "cancelled"
          ? "SETTLED"
          : run.status === "blocked"
            ? "RUN_BLOCKED"
            : command.state === "leased"
              ? "RUNNING"
              : definition.kind === "signal"
                ? "WAITING_SIGNAL"
                : definition.kind === "timer"
                  ? "WAITING_TIMER"
                  : command.ready_at > at
                    ? "RETRY_BACKOFF"
                    : "READY";
      const workers =
        definition.kind === "activity"
          ? [...this.workers].map(([worker, entry]) => ({
              worker,
              reason:
                this.workerReason(
                  definition,
                  worker,
                  entry,
                  at,
                  occupancy.get(worker) ?? 0,
                  this.grant(id)?.job.profile ?? "portable",
                  this.grant(id)?.scope.bound?.nodes,
                ) ?? "ELIGIBLE",
              active: occupancy.get(worker) ?? 0,
              capacity: entry.capacity,
              expiresAt: entry.expiresAt,
            }))
          : [];
      if (reason === "READY" && !workers.some((worker) => worker.reason === "ELIGIBLE"))
        reason = workers.some((worker) => worker.reason === "REQUIRED_CONTAINMENT_UNAVAILABLE")
          ? "REQUIRED_CONTAINMENT_UNAVAILABLE"
          : workers.some((worker) => worker.reason === "CAPACITY_FULL")
            ? "CAPACITY_FULL"
            : workers.some((worker) => worker.reason === "NO_COMPATIBLE_ARTIFACT")
              ? "NO_COMPATIBLE_ARTIFACT"
              : workers.length &&
                  workers.every((worker) => worker.reason === "WORKER_JOB_SCOPE_EXCLUDED")
                ? "WORKER_JOB_SCOPE_EXCLUDED"
                : workers.length &&
                    workers.every((worker) => worker.reason === "NODE_BOUND_EXCLUDED")
                  ? "NODE_BOUND_EXCLUDED"
                  : workers.length
                    ? "NO_MATCHING_CAPABILITY"
                    : "WORKER_OFFLINE";
      return {
        commandId: command.id,
        reason,
        deadline: command.deadline,
        readyAt: command.ready_at,
        ...(showWorkers ? { workers } : {}),
      };
    });
    return {
      items,
      observedAt: at,
      revision: run.revision,
      nextCursor:
        commands.length === 50 ? commands.at(-1)!.position * 100 + commands.at(-1)!.slot : null,
    };
  }
  history(id: string, after = 0, limit = 100, metadataOnly = false): HistoryEvent[] {
    this.required(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid history cursor");
    return this.store
      .rows<{ sequence: number; at: number; type: string; details: string }>(
        `SELECT sequence,at,type,${metadataOnly ? "json_remove(details,'$.token','$.definition.input','$.outcome.value')" : "json_remove(details,'$.token')"} details FROM workflow_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
        id,
        after,
        this.pageSize(limit),
      )
      .map((event) => ({ ...event, details: JSON.parse(event.details) as Json }));
  }
  historyPage(id: string, options: { after?: number; type?: string } = {}) {
    this.required(id);
    const after = options.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid history cursor");
    if (options.type) identifier.parse(options.type);
    // Iterate instead of materializing up to 100 maximum-sized events. Keep room
    // for the envelope and always make progress even with a single large record.
    const items: HistoryEvent[] = [];
    let bytes = 128,
      more = false;
    for (const row of this.store.iterate<{
      sequence: number;
      at: number;
      type: string;
      details: string;
    }>(
      `SELECT sequence,at,type,json_remove(details,'$.token','$.definition.input','$.outcome.value') details FROM workflow_events WHERE run_id=? AND sequence>? ${options.type ? "AND type=?" : ""} ORDER BY sequence LIMIT 101`,
      id,
      after,
      ...(options.type ? [options.type] : []),
    )) {
      const event = { ...row, details: JSON.parse(row.details) as Json },
        size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (items.length === 100 || bytes + size > limits.envelope - 1024) {
        if (!items.length)
          throw new WorkflowError(
            "EventTooLarge",
            "Legacy event exceeds the public history budget; export it using the maintenance snapshot.",
            413,
          );
        more = true;
        break;
      }
      items.push(event);
      bytes += size;
    }
    return { items, nextCursor: more ? items.at(-1)!.sequence : null, observedAt: this.clock() };
  }

  signal(
    id: string,
    signalId: string,
    name: string,
    payload: Json,
    actor = "local-operator",
  ): WorkflowRun {
    identifier.parse(signalId);
    identifier.parse(name);
    const serialized = encodePayload(payload);
    return this.store.transaction(() => {
      const run = this.required(id);
      const previous = this.store.one<{ name: string; payload: string }>(
        "SELECT name,payload FROM workflow_signals WHERE run_id=? AND id=?",
        id,
        signalId,
      );
      if (previous) {
        if (previous.name !== name || previous.payload !== serialized)
          throw new Error("signal ID already has a different payload");
        return this.describe(run);
      }
      if (run.status !== "running" && run.status !== "blocked")
        throw new Error("workflow is closed");
      if (
        this.store.one<{ count: number }>(
          "SELECT count(*) AS count FROM workflow_signals WHERE run_id=?",
          id,
        )!.count >= 1000
      )
        throw new Error("signal limit reached");
      const at = this.clock();
      this.store.admit(
        Number(
          this.store.one<{ value: string }>(
            "SELECT value FROM workflow_meta WHERE key='reserved-bytes'",
          )!.value,
        ) +
          Buffer.byteLength(serialized) * 2,
      );
      this.reserve(id, Buffer.byteLength(serialized) * 2);
      this.store.run(
        "INSERT INTO workflow_signals(run_id,id,name,payload) VALUES(?,?,?,?)",
        id,
        signalId,
        name,
        serialized,
      );
      this.store.event(id, at, "SignalReceived", { id: signalId, name, actor });
      this.reconcile(run, at);
      if (this.required(id).status === "running") this.advance(this.required(id), at);
      return this.describe(this.required(id));
    });
  }

  cancel(id: string, actor = "local-operator"): WorkflowRun {
    return this.store.transaction(() => {
      const run = this.required(id);
      if (run.status === "running" || run.status === "blocked") {
        this.finish(run, "cancelled", failed("Cancelled", "workflow cancelled"), this.clock());
        this.store.event(id, this.clock(), "OperatorMutation", { operation: "cancel", actor });
      }
      return this.describe(this.required(id));
    });
  }
  resume(id: string, actor = "local-operator"): WorkflowRun {
    return this.store.transaction(() => {
      const run = this.required(id);
      if (run.status !== "blocked") throw new Error("only blocked workflows can resume");
      this.checkResume(run);
      this.store.run("UPDATE workflow_runs SET status='running',error=NULL WHERE id=?", id);
      const at = this.clock();
      this.store.event(id, at, "WorkflowResumed", { actor });
      this.reconcile(this.required(id), at);
      if (this.required(id).status === "running") this.advance(this.required(id), at);
      return this.describe(this.required(id));
    });
  }

  tick(): void {
    this.store.backfillTurn();
    const stopAt = performance.now() + 10;
    this.store.run(
      "DELETE FROM workflow_claims WHERE rowid IN (SELECT rowid FROM workflow_claims WHERE expires_at<=? LIMIT 64)",
      this.clock(),
    );
    const rows = this.executor
      ? this.store.rows<{ id: string }>(
          "SELECT run_id id FROM workflow_due WHERE due_at<=? ORDER BY due_at,run_id LIMIT 64",
          this.clock(),
        )
      : this.store.rows<{ id: string }>(
          "SELECT id FROM workflow_runs WHERE status IN ('running','blocked') ORDER BY started_at,id",
        );
    for (const { id } of rows) {
      this.store.transaction(() => {
        const run = this.required(id),
          at = this.clock();
        this.reconcile(run, at);
        if (this.required(id).status === "running") this.advance(this.required(id), at);
        if (this.executor) this.refreshDue(id);
      });
      if (this.executor && performance.now() >= stopAt) break;
    }
  }

  advertise(worker: string, advertisement: WorkerAdvertisement): void {
    identifier.parse(worker);
    encode(advertisement);
    const at = this.clock();
    for (const [id, entry] of this.workers) if (entry.expiresAt <= at) this.workers.delete(id);
    if (!this.workers.has(worker) && this.workers.size >= 100)
      throw new Error("worker limit reached");
    this.workers.set(worker, {
      ...advertisementSchema.parse(advertisement),
      expiresAt: at + 15_000,
    });
  }

  openSession(worker: string, session: string): void {
    identifier.parse(worker);
    identifier.parse(session);
    if (this.sessions.size >= 100 && !this.sessions.has(worker))
      throw new Error("worker session limit reached");
    let takeover = false;
    this.store.transaction(() => {
      const existing = this.store.one<{ retired: number }>(
        "SELECT retired FROM workflow_worker_sessions WHERE worker=? AND session=?",
        worker,
        session,
      );
      if (existing?.retired) throw new Error("obsolete worker session cannot negotiate again");
      const previous = this.store.one<{ value: string }>(
        "SELECT value FROM workflow_meta WHERE key=?",
        `session:${worker}`,
      )?.value;
      if (
        !previous &&
        this.store.one<{ count: number }>(
          "SELECT count(DISTINCT worker) count FROM workflow_worker_sessions",
        )!.count >= 100
      )
        throw new Error("registered worker limit reached");
      if (
        !existing &&
        this.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_worker_sessions WHERE worker=?",
          worker,
        )!.count >= 1024
      )
        throw new Error("retired worker session limit reached");
      if (previous && previous !== session) {
        takeover = true;
        for (const command of this.store.rows<CommandRow>(
          "SELECT c.* FROM workflow_commands c JOIN workflow_attempts a ON a.token=c.token WHERE a.worker=? AND a.state='active'",
          worker,
        )) {
          this.expireAttempt(command);
          this.retryOrResolve(
            command,
            { code: "WorkerRestarted", message: "worker session replaced", retryable: true },
            this.clock(),
          );
        }
      }
      this.store.run(
        "UPDATE workflow_worker_sessions SET retired=1 WHERE worker=? AND session<>?",
        worker,
        session,
      );
      this.store.run(
        "INSERT OR IGNORE INTO workflow_worker_sessions VALUES(?,?,0)",
        worker,
        session,
      );
      this.store.run(
        "INSERT INTO workflow_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        `session:${worker}`,
        session,
      );
      // Refusing the enrollment audit must not retire a previously live session.
      // The separate peers transaction records intent; a later workflows commit
      // failure can still leave that intent without a committed session change.
      this.onWorkerSession?.(worker, takeover);
    });
    this.sessions.set(worker, session);
  }
  assertSession(worker: string, session: string, epoch: string): void {
    if (epoch !== this.epoch || this.sessions.get(worker) !== session)
      throw new Error("worker session or recovery epoch is obsolete; negotiate again");
  }
  decline(worker: string, token: string): boolean {
    return this.store.transaction(() => {
      const command = this.activeAttempt(worker, token, this.clock());
      if (!command) return false;
      this.expireAttempt(command);
      this.retryOrResolve(
        command,
        { code: "WorkerDeclined", message: "worker declined before execution", retryable: true },
        this.clock(),
      );
      return true;
    });
  }
  claim(worker: string, requestId?: string): ActivityTask | null {
    if (!this.executor) this.tick();
    return this.store.transaction(() => {
      const at = this.clock();
      if (requestId) {
        identifier.parse(requestId);
        const receipt = this.store.one<{ task: string | null }>(
          "SELECT task FROM workflow_claims WHERE worker=? AND request_id=?",
          worker,
          requestId,
        );
        if (receipt) {
          const task = receipt.task ? (JSON.parse(receipt.task) as ActivityTask) : null;
          return task && this.permitsWorkerJob(worker, task.type)
            ? { ...task, timeoutMs: Math.max(1, task.deadline - at) }
            : null;
        }
      }
      if (!this.store.accounted) return null;
      if (
        this.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_claims WHERE worker=?",
          worker,
        )!.count >= 1024
      )
        throw new Error("claim receipt capacity reached");
      if (!this.workers.has(worker)) return null;
      const cursor = this.executor
        ? (this.store.one<{ last_run: string }>(
            "SELECT last_run FROM workflow_dispatch_cursor WHERE worker=?",
            worker,
          )?.last_run ?? "")
        : "";
      // At most one candidate per run in a round. The durable cursor also moves
      // past incompatible runs, so restarting does not starve the queue tail.
      const candidates = this.store.rows<CommandRow>(
        "SELECT c.* FROM workflow_commands c JOIN workflow_runs r ON r.id=c.run_id WHERE r.status='running' AND r.deadline>? AND c.state='pending' AND c.ready_at<=? AND c.deadline>? AND r.id>? AND json_extract(c.definition,'$.kind')='activity' AND c.id=(SELECT x.id FROM workflow_commands x LEFT JOIN workflow_candidate_cursor f ON f.run_id=x.run_id AND f.worker=? WHERE x.run_id=r.id AND x.state='pending' AND x.ready_at<=? AND x.deadline>? AND json_extract(x.definition,'$.kind')='activity' ORDER BY CASE WHEN x.position*100+x.slot>coalesce(f.position,-1) THEN 0 ELSE 1 END,x.position,x.slot LIMIT 1) ORDER BY r.id LIMIT 64",
        at,
        at,
        at,
        cursor,
        worker,
        at,
        at,
      );
      const progress = (run: string) => {
        if (this.executor)
          this.store.run(
            "INSERT INTO workflow_dispatch_cursor VALUES(?,?,'') ON CONFLICT(worker) DO UPDATE SET last_run=excluded.last_run",
            worker,
            run,
          );
      };
      const occupancy = new Map(
        this.store
          .rows<{ worker: string; active: number }>(
            "SELECT worker,count(*) active FROM workflow_attempts WHERE state='active' GROUP BY worker",
          )
          .map((row) => [row.worker, row.active]),
      );
      for (const command of candidates) {
        progress(command.run_id);
        this.store.run(
          "INSERT INTO workflow_candidate_cursor VALUES(?,?,?) ON CONFLICT(worker,run_id) DO UPDATE SET position=excluded.position",
          worker,
          command.run_id,
          command.position * 100 + command.slot,
        );
        const definition = JSON.parse(command.definition) as LeafCommand;
        const run = this.required(command.run_id);
        if (
          definition.kind === "activity" &&
          this.authorize &&
          !this.authorize({ ...run, authorizer: this.grant(run.id)?.authorizer }, definition.type)
        ) {
          this.block(
            run,
            "PolicyRevoked: current authorizing identity policy no longer permits this workflow",
            at,
          );
          continue;
        }
        const preferred =
          this.executor && at - command.ready_at >= 2000
            ? {
                ...definition,
                placement:
                  definition.kind === "activity"
                    ? { ...definition.placement, preferNodes: [], prefer: {} }
                    : undefined,
              }
            : definition;
        if (
          definition.kind !== "activity" ||
          !(preferred && preferred.kind === "activity") ||
          this.chooseWorker(
            preferred as ActivityCommand,
            at,
            worker,
            this.executor !== undefined && at - command.ready_at >= 2000,
            occupancy,
            this.grant(run.id)?.job.profile ?? "portable",
            this.grant(run.id)?.scope.bound?.nodes,
          ) !== worker
        )
          continue;
        const token = randomUUID(),
          attempt = command.attempts + 1;
        const deadline = Math.min(command.deadline, at + definition.attemptTimeoutMs);
        this.store.run(
          "INSERT INTO workflow_attempts(token,command_id,worker,attempt,state,physical_state) VALUES(?,?,?,?,'active','running')",
          token,
          command.id,
          worker,
          attempt,
        );
        this.store.run("UPDATE workflow_attempts SET started_at=? WHERE token=?", at, token);
        this.store.run(
          "UPDATE workflow_commands SET state='leased',token=?,attempts=?,attempt_deadline=?,lease_until=? WHERE id=?",
          token,
          attempt,
          deadline,
          Math.min(deadline, at + definition.heartbeatTimeoutMs),
          command.id,
        );
        this.store.event(command.run_id, at, "ActivityClaimed", {
          activityId: command.id,
          attempt,
          token,
          worker,
        });
        const task: ActivityTask = {
          owner: this.id,
          runId: command.run_id,
          activityId: command.id,
          idempotencyKey: command.id,
          type: definition.type,
          input: definition.input,
          attempt,
          token,
          deadline,
          timeoutMs: deadline - at,
          ...(this.activityArtifacts[definition.type]
            ? { artifact: this.activityArtifacts[definition.type] }
            : {}),
          ...(run.grant_revision ? { grantRevision: run.grant_revision } : {}),
          heartbeatMs: Math.max(
            1,
            Math.floor(Math.min(definition.heartbeatTimeoutMs, definition.attemptTimeoutMs) / 3),
          ),
        };
        if (requestId)
          this.store.run(
            "INSERT INTO workflow_claims VALUES(?,?,?,?)",
            worker,
            requestId,
            encode(task),
            deadline + 60_000,
          );
        return task;
      }
      if (!candidates.length) progress("");
      if (requestId)
        this.store.run(
          "INSERT INTO workflow_claims VALUES(?,?,NULL,?)",
          worker,
          requestId,
          at + 60_000,
        );
      return null;
    });
  }

  heartbeat(worker: string, token: string): boolean {
    return this.store.transaction(() => {
      const command = this.activeAttempt(worker, token, this.clock());
      if (!command) return false;
      const definition = JSON.parse(command.definition) as ActivityCommand;
      this.store.run(
        "UPDATE workflow_commands SET lease_until=? WHERE id=?",
        Math.min(command.attempt_deadline!, this.clock() + definition.heartbeatTimeoutMs),
        command.id,
      );
      return true;
    });
  }

  complete(worker: string, token: string, outcome: Outcome): boolean {
    const status = this.completeStatus(worker, token, outcome);
    return status === "accepted" || status === "alreadyAccepted";
  }
  completeStatus(
    worker: string,
    token: string,
    outcome: Outcome,
  ): "accepted" | "alreadyAccepted" | "conflict" | "stale" {
    if (outcome.ok) encodePayload(outcome.value);
    const serialized = encode(outcomeSchema.parse(JSON.parse(encode(outcome))));
    return this.store.transaction(() => {
      const previous = this.store.one<AttemptRow>(
        "SELECT * FROM workflow_attempts WHERE token=? AND worker=?",
        token,
        worker,
      );
      if (previous?.state === "accepted")
        return previous.outcome === serialized ? "alreadyAccepted" : "conflict";
      const at = this.clock(),
        command = this.activeAttempt(worker, token, at);
      if (previous) this.settlePhysical(worker, token);
      if (!command) return "stale";
      this.store.run(
        "UPDATE workflow_attempts SET state='accepted',outcome=?,settled_at=? WHERE token=?",
        serialized,
        at,
        token,
      );
      const accepted = JSON.parse(serialized) as Outcome;
      const rejection = accepted.ok ? this.rejectedOutput(command, accepted.value) : undefined;
      if (rejection) {
        // The attempt keeps what the worker sent; the step fails, and is not retried: the job's own code answered wrongly.
        this.store.event(command.run_id, at, "JobOutputRejected", {
          command: command.id,
          error: rejection,
        });
        this.resolve(
          command,
          { ok: false, error: { code: "InvalidOutput", message: rejection, retryable: false } },
          at,
        );
      } else if (accepted.ok) this.resolve(command, accepted, at);
      else this.retryOrResolve(command, accepted.error, at);
      this.advance(this.required(command.run_id), at);
      return "accepted";
    });
  }

  /** The contract pinned for a job type, whether or not this boot registered it. */
  jobContract(type: string): JobContract | undefined {
    const row = this.store.one<{ contract: string }>(
      "SELECT contract FROM workflow_job_contracts WHERE type=?",
      type,
    );
    return row ? jobContractSchema.parse(JSON.parse(row.contract)) : undefined;
  }
  /** Check a `job@1` start against the job's pinned contract before any run exists. */
  private admitJob(value: Json): Json {
    const parsed = jobRunInputSchema.safeParse(value);
    if (!parsed.success)
      throw new WorkflowError(
        "InvalidInput",
        `job@1 input must be { job, input, placement? }: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        400,
      );
    const contract = this.jobContract(parsed.data.job);
    if (!contract)
      throw new WorkflowError(
        "UnknownJob",
        `no worker of this owner has registered job ${parsed.data.job}`,
        400,
      );
    if (contract.inputSchema) {
      const result = validateAgainstSchema(contract.inputSchema, parsed.data.input);
      if (!result.ok)
        throw new WorkflowError(
          "InvalidInput",
          `input does not match ${contract.type}: ${result.errors.join("; ")}`.slice(0, 4096),
          400,
        );
    }
    return JSON.parse(
      encode({
        ...parsed.data,
        ...(contract.timeoutMs ? { attemptTimeoutMs: contract.timeoutMs } : {}),
      }),
    ) as Json;
  }
  /** Why a job step's output breaks its contract, or undefined when it holds (or the step is not a job). */
  private rejectedOutput(command: CommandRow, value: Json): string | undefined {
    const definition = JSON.parse(command.definition) as LeafCommand;
    if (definition.kind !== "activity") return undefined;
    const schema = this.jobContract(definition.type)?.outputSchema;
    if (!schema) return undefined;
    const result = validateAgainstSchema(schema, value);
    return result.ok
      ? undefined
      : `output does not match ${definition.type}: ${result.errors.join("; ")}`.slice(0, 4096);
  }

  /** A worker acknowledges only after its activity has actually returned. Lease expiry is not evidence. */
  settlePhysical(worker: string, token: string): boolean {
    if (
      !this.store.one("SELECT 1 FROM workflow_attempts WHERE token=? AND worker=?", token, worker)
    )
      return false;
    this.store.run(
      "UPDATE workflow_attempts SET physical_state='settled' WHERE token=? AND worker=?",
      token,
      worker,
    );
    return true;
  }

  close(): void {
    if (this.closed) return;
    if (this.pumping) throw new Error("drain owner evaluation before closing storage");
    this.closed = true;
    this.store.close();
  }
  async drain(): Promise<void> {
    await this.executor?.close();
    await this.pumping;
  }

  /** Explicit operator-only migration step; ordinary resume never guesses a legacy digest. */
  async verifyLegacyArtifact(id: string, expectedRevision: number): Promise<WorkflowRun> {
    this.store.assertAccounted();
    const run = this.required(id),
      artifact = this.artifacts.get(encode([run.type, run.version]));
    if (
      !this.executor ||
      !artifact ||
      run.artifact ||
      run.status !== "blocked" ||
      run.revision !== expectedRevision
    )
      throw new Error(
        "legacy artifact verification requires an unchanged blocked, unpinned run and installed code",
      );
    const snapshot = this.store.read((): ReplaySnapshot => {
      const bytes = this.store.one<{ bytes: number }>(
        "SELECT coalesce(sum(length(CAST(definition AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0) bytes FROM workflow_commands WHERE run_id=?",
        id,
      )!.bytes;
      if (bytes + Buffer.byteLength(run.input) > limits.replay)
        throw new Error("legacy replay budget exceeded");
      return {
        input: JSON.parse(run.input) as Json,
        groups: this.store
          .rows<{ position: number; definition: string }>(
            "SELECT position,definition FROM workflow_groups WHERE run_id=? ORDER BY position",
            id,
          )
          .map((group) => ({
            definition: group.definition,
            outcomes: this.store
              .rows<{ outcome: string | null }>(
                "SELECT outcome FROM workflow_commands WHERE run_id=? AND position=? ORDER BY slot",
                id,
                group.position,
              )
              .map((row) => (row.outcome ? (JSON.parse(row.outcome) as Outcome) : null)),
          })),
      };
    });
    boundedEncode(snapshot, limits.replay);
    const first = validateProposal(await this.executor.evaluate(artifact, snapshot), snapshot),
      second = validateProposal(await this.executor.evaluate(artifact, snapshot), snapshot);
    if (first.kind === "blocked" || first.kind === "failed" || encode(first) !== encode(second))
      throw new Error("legacy artifact did not pass compatible double replay");
    return this.store.transaction(() => {
      const current = this.required(id);
      if (current.revision !== expectedRevision || current.artifact || current.status !== "blocked")
        throw new Error("stale workflow revision");
      this.store.run("UPDATE workflow_runs SET artifact=? WHERE id=?", artifact.digest, id);
      this.store.event(id, this.clock(), "LegacyArtifactVerified", {
        actor: "local-operator",
        digest: artifact.digest,
      });
      return this.describe(this.required(id));
    });
  }

  /** Bounded maintenance followed by at most two evaluations outside every SQLite transaction. */
  pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    if (this.closed) return Promise.reject(new Error("owner closed"));
    this.tick();
    if (!this.executor) return Promise.resolve();
    this.pumping = this.evaluateDue().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }
  private refreshDue(id: string): void {
    const run = this.required(id);
    if (run.status !== "running" && run.status !== "blocked") {
      this.store.run("DELETE FROM workflow_due WHERE run_id=?", id);
      return;
    }
    const next = this.store.one<{ due: number | null }>(
      "SELECT min(CASE WHEN state='leased' THEN min(deadline,lease_until) WHEN ?='running' AND json_extract(definition,'$.kind')='signal' AND EXISTS(SELECT 1 FROM workflow_signals s WHERE s.run_id=c.run_id AND s.name=json_extract(c.definition,'$.name') AND s.consumed=0) THEN ? ELSE deadline END) due FROM workflow_commands c WHERE run_id=? AND state IN ('pending','leased')",
      run.status,
      this.clock(),
      id,
    )?.due;
    this.store.run(
      "UPDATE workflow_due SET due_at=CASE WHEN dirty=1 AND ?='running' THEN due_at ELSE ? END WHERE run_id=?",
      run.status,
      Math.min(run.deadline, next ?? run.deadline),
      id,
    );
  }
  private async evaluateDue(): Promise<void> {
    const candidates = this.store.rows<{ run_id: string }>(
      "SELECT d.run_id FROM workflow_due d JOIN workflow_runs r ON r.id=d.run_id WHERE r.status='running' AND d.dirty=1 AND d.due_at<=? AND d.reserved_until<=? ORDER BY d.due_at,d.run_id LIMIT 2",
      this.clock(),
      this.clock(),
    );
    const results = await Promise.allSettled(
      candidates.map(async ({ run_id: id }) => {
        const captured = this.store.transaction(() => {
          const run = this.required(id),
            at = this.clock();
          const due = this.store.one<{ reserved_until: number }>(
            "SELECT reserved_until FROM workflow_due WHERE run_id=?",
            id,
          );
          if (!due || due.reserved_until > at || run.status !== "running") return null;
          const artifact = this.artifacts.get(encode([run.type, run.version]));
          if (!artifact || artifact.digest !== run.artifact) {
            this.block(
              run,
              "ArtifactUnavailable: restore the pinned artifact; legacy runs require explicit verification",
              at,
            );
            this.refreshDue(id);
            return null;
          }
          const token = randomUUID();
          this.store.run(
            "UPDATE workflow_due SET token=?,reserved_until=? WHERE run_id=?",
            token,
            at + 10_000,
            id,
          );
          return { run, artifact, token };
        });
        if (!captured) return;
        const { run, artifact, token } = captured;
        // Storage faults must never be classified as evaluator failures.
        const snapshot = this.store.read((): ReplaySnapshot | null => {
          const size = this.store.one<{ bytes: number }>(
            "SELECT coalesce(sum(length(CAST(definition AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)),0) bytes FROM workflow_commands WHERE run_id=?",
            id,
          )!.bytes;
          if (size + Buffer.byteLength(run.input) > limits.replay) return null;
          const groups = this.store.rows<{ position: number; definition: string }>(
            "SELECT position,definition FROM workflow_groups WHERE run_id=? ORDER BY position",
            id,
          );
          return {
            input: JSON.parse(run.input) as Json,
            groups: groups.map((group) => ({
              definition: group.definition,
              outcomes: this.store
                .rows<{ outcome: string | null }>(
                  "SELECT outcome FROM workflow_commands WHERE run_id=? AND position=? ORDER BY slot",
                  id,
                  group.position,
                )
                .map((row) => (row.outcome ? (JSON.parse(row.outcome) as Outcome) : null)),
            })),
          };
        });
        let proposal: Proposal;
        try {
          if (!snapshot)
            throw new ExecutionFault("ReplayBudgetExceeded", "replay byte limit reached");
          boundedEncode(snapshot, limits.replay);
          proposal = validateProposal(await this.executor!.evaluate(artifact, snapshot), snapshot);
          boundedEncode(proposal, limits.record);
        } catch (error) {
          this.store.transaction(() => {
            const current = this.required(id);
            const due = this.store.one<{ token: string; failures: number }>(
              "SELECT token,failures FROM workflow_due WHERE run_id=?",
              id,
            );
            if (!due || due.token !== token || current.status !== "running") return;
            if (current.revision !== run.revision) {
              this.store.run(
                "UPDATE workflow_due SET token=NULL,reserved_until=0,failures=0 WHERE run_id=?",
                id,
              );
              return;
            }
            if (
              (error instanceof ExecutionFault && error.code.endsWith("BudgetExceeded")) ||
              due.failures >= 2
            )
              this.block(
                current,
                `${error instanceof ExecutionFault ? error.code : "EvaluationUnavailable"}: ${errorMessage(error)}`,
                this.clock(),
              );
            this.store.run(
              "UPDATE workflow_due SET token=NULL,reserved_until=0,failures=failures+1,due_at=? WHERE run_id=?",
              this.clock() + 1000 * 2 ** due.failures,
              id,
            );
            this.refreshDue(id);
          });
          return;
        }
        this.store.transaction(() => {
          const current = this.required(id),
            at = this.clock();
          const due = this.store.one<{ token: string }>(
            "SELECT token FROM workflow_due WHERE run_id=?",
            id,
          );
          if (!due || due.token !== token) return;
          this.store.run("UPDATE workflow_due SET token=NULL,reserved_until=0 WHERE run_id=?", id);
          this.reconcile(current, at);
          const latest = this.required(id);
          if (latest.status !== "running" || latest.revision !== run.revision) {
            this.refreshDue(id);
            return;
          }
          if (proposal.kind === "group") {
            const serialized = encodeCommand(JSON.parse(proposal.definition));
            const count = this.store.one<{ count: number }>(
              "SELECT count(*) count FROM workflow_groups WHERE run_id=?",
              id,
            )!.count;
            const command = JSON.parse(serialized) as ReturnType<typeof commandSchema.parse>;
            const leaves = command.kind === "all" ? command.commands : [command];
            const existing = this.store.one<{ count: number }>(
              "SELECT count(*) count FROM workflow_commands WHERE run_id=?",
              id,
            )!.count;
            const estimate = this.store.one<{ bytes: number }>(
              "SELECT coalesce(sum(length(CAST(definition AS BLOB)) + CASE WHEN outcome IS NULL THEN 262144 ELSE length(CAST(outcome AS BLOB)) END),0) bytes FROM workflow_commands WHERE run_id=?",
              id,
            )!.bytes;
            const reserve =
              Buffer.byteLength(serialized) * 3 +
              leaves.reduce(
                (sum, leaf) =>
                  sum +
                  (leaf.kind === "activity"
                    ? limits.payload * 3 + leaf.retry.maxAttempts * 16_384
                    : leaf.kind === "signal"
                      ? limits.payload * 2
                      : 1024),
                0,
              );
            const total = Number(
              this.store.one<{ value: string }>(
                "SELECT value FROM workflow_meta WHERE key='reserved-bytes'",
              )!.value,
            );
            const pending = this.store.one<{ count: number }>(
              "SELECT count(*) count FROM workflow_commands WHERE state IN ('pending','leased')",
            )!.count;
            if (
              leaves.some((leaf) => leaf.kind === "activity" && !this.activityArtifacts[leaf.type])
            )
              this.block(
                latest,
                "ActivityArtifactUnavailable: register the expected activity digest before dispatch",
                at,
              );
            else if (
              proposal.position !== count ||
              existing + leaves.length > 1000 ||
              pending + leaves.length > 10_000 ||
              estimate + Buffer.byteLength(serialized) + leaves.length * 262144 > limits.replay ||
              total + reserve > 1_073_741_824 ||
              latest.budget_bytes + reserve > 67_108_864
            )
              this.block(
                latest,
                "proposal exceeds command, replay or retained-storage admission budget",
                at,
              );
            else {
              this.reserve(id, reserve);
              this.store.run("INSERT INTO workflow_groups VALUES(?,?,?)", id, count, serialized);
              leaves.forEach((leaf, slot) => this.schedule(latest, count, slot, leaf, at));
              this.reconcile(this.required(id), at);
            }
          } else if (proposal.kind === "waiting")
            this.store.run("UPDATE workflow_due SET dirty=0,failures=0 WHERE run_id=?", id);
          else if (proposal.kind === "complete") {
            encodePayload(proposal.value);
            this.finish(latest, "completed", { ok: true, value: proposal.value }, at);
          } else if (proposal.kind === "blocked")
            this.block(latest, proposal.message.slice(0, 4096), at);
          else if (proposal.kind === "failed")
            this.finish(
              latest,
              "failed",
              failed("WorkflowFailed", proposal.message.slice(0, 4096)),
              at,
            );
          else throw new Error("invalid evaluator proposal");
          this.refreshDue(id);
        });
      }),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }

  private pageSize(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error("page size must be between 1 and 500");
    return limit;
  }
  private reserve(id: string, bytes: number): void {
    const total = Number(
      this.store.one<{ value: string }>(
        "SELECT value FROM workflow_meta WHERE key='reserved-bytes'",
      )!.value,
    );
    if (total + bytes > 1_073_741_824) throw new Error("retained storage admission limit reached");
    if (this.required(id).budget_bytes + bytes > 67_108_864)
      throw new Error("per-run retained storage admission limit reached");
    this.store.run(
      "UPDATE workflow_meta SET value=CAST(CAST(value AS INTEGER)+? AS TEXT) WHERE key='reserved-bytes'",
      bytes,
    );
    this.store.run("UPDATE workflow_runs SET budget_bytes=budget_bytes+? WHERE id=?", bytes, id);
  }
  private checkResume(run: RunRow): void {
    this.store.assertAccounted();
    if (run.error?.startsWith("OutcomeUnknown"))
      throw new WorkflowError(
        "ReconciliationRequired",
        "Reconcile the uncertain effect before resuming this run.",
        409,
      );
    if (
      this.store.one(
        "SELECT 1 FROM workflow_session_bindings WHERE run_id=? AND state!='complete' LIMIT 1",
        run.id,
      )
    )
      throw new WorkflowError(
        "ReconciliationRequired",
        "Reconcile the session turn before resuming this run.",
        409,
      );
    if (run.budget_bytes > 67_108_864)
      throw new WorkflowError(
        "CapacityExceeded",
        "Legacy run exceeds the supported retained byte budget; export or cancel it before migrating its work.",
        429,
      );
    const key = encode([run.type, run.version]);
    if (
      this.executor ? this.artifacts.get(key)?.digest !== run.artifact : !this.definitions.has(key)
    )
      throw new Error("compatible pinned workflow artifact must be installed before resume");
  }
  private row(id: string): RunRow | undefined {
    return this.store.one<RunRow>("SELECT * FROM workflow_runs WHERE id=?", id);
  }
  private required(id: string): RunRow {
    if (this.store.one("SELECT 1 FROM workflow_tombstones WHERE id=?", id))
      throw new WorkflowError(
        "RunArchived",
        "Run details were archived; this ID cannot be reused.",
        410,
      );
    const row = this.row(id);
    if (!row) throw new Error("unknown workflow");
    return row;
  }
  private describe(row: RunRow): WorkflowRun {
    const grant = row.grant_revision ? this.grant(row.id) : undefined;
    return {
      id: row.id,
      owner: row.owner,
      type: row.type,
      version: row.version,
      input: JSON.parse(row.input) as Json,
      status: row.status,
      startedAt: row.started_at,
      deadline: row.deadline,
      outcome: row.outcome ? (JSON.parse(row.outcome) as Outcome) : null,
      error: row.error,
      revision: row.revision,
      artifact: row.artifact,
      principal: row.principal,
      ...(grant
        ? {
            job: {
              ...grant.job,
              grantRevision: grant.revision,
              authorizer: grant.authorizer,
              createdBy: grant.createdBy,
            },
          }
        : {}),
    };
  }
  private activeAttempt(worker: string, token: string, at: number): CommandRow | undefined {
    const command = this.store.one<CommandRow>(
      `SELECT c.* FROM workflow_commands c
      JOIN workflow_attempts a ON a.token=c.token JOIN workflow_runs r ON r.id=c.run_id
      WHERE a.worker=? AND a.token=? AND a.state='active' AND c.state='leased'
      AND c.lease_until>? AND c.attempt_deadline>? AND c.deadline>? AND r.deadline>? AND r.status='running'`,
      worker,
      token,
      at,
      at,
      at,
      at,
    );
    if (
      command &&
      !this.permitsWorkerJob(worker, (JSON.parse(command.definition) as ActivityCommand).type)
    )
      return undefined;
    if (command && this.authorize) {
      const run = this.required(command.run_id),
        definition = JSON.parse(command.definition) as ActivityCommand;
      if (
        !this.authorize({ ...run, authorizer: this.grant(run.id)?.authorizer }, definition.type)
      ) {
        this.block(run, "PolicyRevoked: attempt authority revoked", at);
        return undefined;
      }
    }
    return command;
  }
  private chooseWorker(
    command: ActivityCommand,
    at: number,
    claimant?: string,
    ignorePreference = false,
    occupancy?: Map<string, number>,
    profile = "portable",
    runNodes?: { allow?: string[]; deny?: string[] },
  ): string | undefined {
    const { preferNodes, prefer } = command.placement;
    const eligible = [...this.workers.entries()].filter(([id, worker]) => {
      const active = occupancy
        ? (occupancy.get(id) ?? 0)
        : this.store.one<{ count: number }>(
            "SELECT count(*) AS count FROM workflow_attempts WHERE worker=? AND state='active'",
            id,
          )!.count;
      return this.workerReason(command, id, worker, at, active, profile, runNodes) === null;
    });
    const score = (id: string, worker: Advertisement) => {
      const index = preferNodes.indexOf(id);
      return (
        (index < 0 ? 0 : (preferNodes.length - index) * (Object.keys(prefer).length + 1)) +
        Object.entries(prefer).filter(([key, value]) => worker.labels[key] === value).length
      );
    };
    eligible.sort(
      ([a, first], [b, second]) =>
        score(b, second) - score(a, first) || first.load - second.load || a.localeCompare(b),
    );
    return ignorePreference && eligible.some(([id]) => id === claimant)
      ? claimant
      : eligible[0]?.[0];
  }
  /** Whether a node bound (the step's own, or the run's granted one) keeps this worker out. */
  private nodeExcluded(id: string, bound?: { allow?: string[]; deny?: string[] }): boolean {
    if (!bound) return false;
    const names = (references: string[]) =>
      references.map((reference) =>
        reference === "local" ? this.id : this.resolveNode(reference),
      );
    return (
      (bound.deny !== undefined && names(bound.deny).includes(id)) ||
      (bound.allow !== undefined && !names(bound.allow).includes(id))
    );
  }
  private workerReason(
    command: ActivityCommand,
    id: string,
    worker: Advertisement,
    at: number,
    active: number,
    profile = "portable",
    runNodes?: { allow?: string[]; deny?: string[] },
  ): string | null {
    if (worker.expiresAt <= at) return "WORKER_OFFLINE";
    if (!this.permitsWorkerJob(id, command.type)) return "WORKER_JOB_SCOPE_EXCLUDED";
    if (this.nodeExcluded(id, command.placement.nodes) || this.nodeExcluded(id, runNodes))
      return "NODE_BOUND_EXCLUDED";
    if (!(this.workerProfiles[id] ?? ["portable"]).includes(profile))
      return "REQUIRED_CONTAINMENT_UNAVAILABLE";
    if (
      (command.placement.node && command.placement.node !== id) ||
      !worker.types.includes(command.type) ||
      !Object.entries(command.placement.requires).every(
        ([key, value]) => worker.labels[key] === value,
      )
    )
      return "NO_MATCHING_CAPABILITY";
    if (
      this.activityArtifacts[command.type] &&
      worker.artifacts[command.type] !== this.activityArtifacts[command.type]
    )
      return "NO_COMPATIBLE_ARTIFACT";
    return active >= worker.capacity ? "CAPACITY_FULL" : null;
  }

  private reconcile(run: RunRow, at: number): void {
    if (run.status !== "running" && run.status !== "blocked") return;
    if (run.deadline <= at) {
      this.finish(run, "timed_out", failed("WorkflowTimeout", "workflow deadline passed"), at);
      return;
    }
    for (const command of this.store.rows<CommandRow>(
      `SELECT * FROM workflow_commands c WHERE run_id=? AND state IN ('pending','leased') ${this.executor ? "AND (deadline<=? OR (state='leased' AND lease_until<=?) OR (?='running' AND json_extract(definition,'$.kind')='signal' AND EXISTS(SELECT 1 FROM workflow_signals s WHERE s.run_id=c.run_id AND s.name=json_extract(c.definition,'$.name') AND s.consumed=0)))" : ""} ORDER BY position,slot LIMIT ${this.executor ? 64 : 1000}`,
      run.id,
      ...(this.executor ? [at, at, run.status] : []),
    )) {
      const definition = JSON.parse(command.definition) as LeafCommand;
      if (definition.kind === "timer") {
        if (command.deadline <= at) this.resolve(command, { ok: true, value: null }, at);
      } else if (command.deadline <= at) {
        this.expireAttempt(command);
        this.resolve(command, failed("CommandTimeout", "command deadline passed"), at);
      } else if (definition.kind === "signal") {
        if (run.status === "blocked") continue;
        const received = this.store.one<{ sequence: number; id: string; payload: string }>(
          "SELECT sequence,id,payload FROM workflow_signals WHERE run_id=? AND name=? AND consumed=0 ORDER BY sequence LIMIT 1",
          run.id,
          definition.name,
        );
        if (received) {
          this.store.run(
            "UPDATE workflow_signals SET consumed=1 WHERE sequence=?",
            received.sequence,
          );
          this.store.event(run.id, at, "SignalConsumed", { id: received.id, command: command.id });
          this.resolve(command, { ok: true, value: JSON.parse(received.payload) as Json }, at);
        }
      } else if (
        definition.kind === "activity" &&
        command.state === "leased" &&
        command.lease_until! <= at
      ) {
        this.expireAttempt(command);
        this.retryOrResolve(
          command,
          { code: "AttemptTimeout", message: "activity lease expired", retryable: true },
          at,
        );
      }
    }
  }
  private expireAttempt(command: CommandRow): void {
    if (command.token)
      this.store.run(
        "UPDATE workflow_attempts SET state='expired',physical_state='unknown',settled_at=? WHERE token=? AND state='active'",
        this.clock(),
        command.token,
      );
  }
  private resolve(command: CommandRow, outcome: Outcome, at: number): void {
    this.store.run(
      "UPDATE workflow_commands SET state='done',outcome=?,token=NULL,lease_until=NULL WHERE id=?",
      encode(outcome),
      command.id,
    );
    this.store.event(command.run_id, at, "CommandResolved", { command: command.id, outcome });
  }
  private retryOrResolve(command: CommandRow, error: Failure, at: number): void {
    const definition = JSON.parse(command.definition) as ActivityCommand;
    const delay = Math.min(
      definition.retry.maxDelayMs,
      definition.retry.initialDelayMs * 2 ** (command.attempts - 1),
    );
    if (
      error.retryable &&
      command.attempts < definition.retry.maxAttempts &&
      at + delay < command.deadline
    ) {
      this.store.run(
        "UPDATE workflow_commands SET state='pending',token=NULL,lease_until=NULL,ready_at=? WHERE id=?",
        at + delay,
        command.id,
      );
      this.store.event(command.run_id, at, "ActivityRetryScheduled", {
        command: command.id,
        attempt: command.attempts,
        readyAt: at + delay,
        error,
      });
    } else this.resolve(command, { ok: false, error }, at);
  }
  private finish(run: RunRow, status: WorkflowStatus, outcome: Outcome, at: number): void {
    this.store.run("UPDATE workflow_runs SET closed_at=? WHERE id=?", at, run.id);
    this.store.run(
      "UPDATE workflow_runs SET status=?,outcome=?,error=NULL WHERE id=?",
      status,
      encode(outcome),
      run.id,
    );
    this.store.run(
      "UPDATE workflow_attempts SET state='expired' WHERE state='active' AND command_id IN (SELECT id FROM workflow_commands WHERE run_id=?)",
      run.id,
    );
    this.store.run(
      "UPDATE workflow_commands SET state='cancelled',token=NULL WHERE run_id=? AND state IN ('pending','leased')",
      run.id,
    );
    this.store.event(run.id, at, "WorkflowClosed", { status, outcome });
    this.settleBudget(run.id);
  }
  private settleBudget(id: string): void {
    const run = this.required(id);
    let bytes = Buffer.byteLength(encode(run)) + 1_048_576;
    for (const [table, expression] of [
      ["workflow_groups", "length(CAST(definition AS BLOB))+256"],
      [
        "workflow_commands",
        "length(CAST(definition AS BLOB))+coalesce(length(CAST(outcome AS BLOB)),0)+512",
      ],
      ["workflow_events", "length(CAST(details AS BLOB))+256"],
      ["workflow_signals", "length(CAST(payload AS BLOB))+256"],
      ["workflow_payloads", "bytes+256"],
      ["workflow_grants", "length(CAST(evidence AS BLOB))+512"],
      ["workflow_session_bindings", "512"],
    ])
      bytes += this.store.one<{ bytes: number }>(
        `SELECT coalesce(sum(${expression}),0) bytes FROM ${table} WHERE run_id=?`,
        id,
      )!.bytes;
    bytes += this.store.one<{ bytes: number }>(
      "SELECT coalesce(sum(coalesce(length(CAST(a.outcome AS BLOB)),0)+512),0) bytes FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?",
      id,
    )!.bytes;
    this.store.run("UPDATE workflow_runs SET budget_bytes=? WHERE id=?", bytes, id);
    this.store.run(
      "UPDATE workflow_meta SET value=CAST(max(0,CAST(value AS INTEGER)+?) AS TEXT) WHERE key='reserved-bytes'",
      bytes - run.budget_bytes,
    );
  }
  private block(run: RunRow, error: string, at: number): void {
    this.store.run("UPDATE workflow_runs SET status='blocked',error=? WHERE id=?", error, run.id);
    for (const command of this.store.rows<CommandRow>(
      "SELECT * FROM workflow_commands WHERE run_id=? AND state='leased'",
      run.id,
    )) {
      this.expireAttempt(command);
      this.retryOrResolve(
        command,
        {
          code: "RunBlocked",
          message: "workflow interpretation blocked; attempt revoked",
          retryable: true,
        },
        at,
      );
    }
    this.store.event(run.id, at, "WorkflowBlocked", { error });
  }

  private advance(run: RunRow, at: number): void {
    if (this.executor) return;
    if (run.status !== "running") return;
    const definition = this.definitions.get(encode([run.type, run.version]));
    if (!definition) {
      this.block(run, "workflow definition is unavailable", at);
      return;
    }
    const groups = this.store.rows<{ position: number; definition: string }>(
      "SELECT position,definition FROM workflow_groups WHERE run_id=? ORDER BY position",
      run.id,
    );
    let position = 0;
    let generator: Generator<unknown, unknown, Json> | undefined;
    try {
      generator = authored(() => definition.run(JSON.parse(run.input) as Json));
      if (!generator || typeof generator.next !== "function" || Symbol.asyncIterator in generator)
        throw new ReplayMismatch("workflow must return a synchronous generator");
      let step = authored(() => generator!.next());
      while (!step.done) {
        if (position >= 1000) throw new ReplayMismatch("workflow command limit reached");
        let serialized: string;
        try {
          serialized = encodeCommand(step.value);
        } catch (error) {
          throw new ReplayMismatch(errorMessage(error));
        }
        const command = JSON.parse(serialized) as ReturnType<typeof commandSchema.parse>;
        const group = groups[position];
        if (group && group.definition !== serialized)
          throw new ReplayMismatch(`command ${position} differs from history`);
        if (!group) {
          const leaves = command.kind === "all" ? command.commands : [command];
          const count = this.store.one<{ count: number }>(
            "SELECT count(*) AS count FROM workflow_commands WHERE run_id=?",
            run.id,
          )!.count;
          if (count + leaves.length > 1000)
            throw new ReplayMismatch("workflow command limit reached");
          this.store.run("INSERT INTO workflow_groups VALUES(?,?,?)", run.id, position, serialized);
          leaves.forEach((leaf, slot) => this.schedule(run, position, slot, leaf, at));
          this.reconcile(run, at);
        }
        const commands = this.store.rows<CommandRow>(
          "SELECT * FROM workflow_commands WHERE run_id=? AND position=? ORDER BY slot",
          run.id,
          position,
        );
        if (commands.some((leaf) => leaf.state !== "done")) return;
        const outcomes = commands.map((leaf) => JSON.parse(leaf.outcome!) as Outcome);
        const failure = outcomes.find((outcome) => !outcome.ok);
        position++;
        if (failure && !failure.ok)
          step = authored(() =>
            generator!.throw(new ActivityFailure(failure.error.message, failure.error.code)),
          );
        else {
          const values = outcomes.map((outcome) => (outcome.ok ? outcome.value : null));
          step = authored(() => generator!.next(command.kind === "all" ? values : values[0]));
        }
      }
      if (position < groups.length)
        throw new ReplayMismatch(`workflow returned before recorded command ${position}`);
      const value = authored(() => JSON.parse(encodePayload(step.value)) as Json);
      this.finish(run, "completed", { ok: true, value }, at);
    } catch (error) {
      if (!(error instanceof AuthoredFault) && !(error instanceof ReplayMismatch)) throw error;
      if (error instanceof ReplayMismatch || position < groups.length)
        this.block(run, errorMessage(error), at);
      else this.finish(run, "failed", failed("WorkflowFailed", errorMessage(error)), at);
    }
    // Do not call return(): a generator's finally block can yield or perform effects.
    // Dropping this instance preserves the same replay boundary on the next tick.
  }

  private schedule(
    run: RunRow,
    position: number,
    slot: number,
    definition: LeafCommand,
    at: number,
  ): void {
    const id = createHash("sha256")
      .update(encode([this.id, run.id, position, slot]))
      .digest("hex");
    const deadline = Math.min(
      run.deadline,
      at +
        (definition.kind === "timer"
          ? definition.delayMs
          : "timeoutMs" in definition
            ? definition.timeoutMs
            : 0),
    );
    this.store.run(
      "INSERT INTO workflow_commands(id,run_id,position,slot,definition,state,deadline,ready_at) VALUES(?,?,?,?,?,'pending',?,?)",
      id,
      run.id,
      position,
      slot,
      encode(definition),
      deadline,
      at,
    );
    this.store.event(run.id, at, "CommandScheduled", {
      command: id,
      position,
      slot,
      definition,
      deadline,
    });
    if (definition.kind === "now" || definition.kind === "random") {
      this.resolve(
        this.store.one<CommandRow>("SELECT * FROM workflow_commands WHERE id=?", id)!,
        {
          ok: true,
          value: definition.kind === "now" ? at : randomInt(2 ** 48 - 1) / (2 ** 48 - 1),
        },
        at,
      );
    }
  }
}
