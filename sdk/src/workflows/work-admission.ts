import { assertRecoveryAdmission } from "./recovery-admission.js";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { artifactAbi, inspectArtifact, type WorkflowArtifact } from "./artifacts.js";
import { assertProcessProgramScope, assertProcessProgramDirectory, assertProcessProgramRuntime, assertProcessProgramBundle } from "./work-process-program.js";
import { boundToNodeFlags } from "./job-launcher.js";
import { WorkflowError } from "./errors.js";
import type { RunApproval } from "./approvals.js";
import type { WorkflowStore } from "./workflow-store.js";
import {
  encode as encodePayload,
  encodeEnvelope,
  jobRunInputSchema,
  type Json,
  type StartWorkflow,
  type WorkflowRun,
  type JobContract,
} from "./types.js";
import {
  workAdmissionSchema,
  workPlanSchema,
  workSubmissionSchema,
  workNamespaceSchema,
  workIntentHash,
  workPlanHash,
  type WorkSubmission,
  type WorkPlan,
  type WorkNamespace,
  type WorkAdmission,
} from "./work-contracts.js";
import { workDelegationRecordSchema } from "./work-delegation.js";
import { validateWorkGrant, type WorkAuthority, type WorkGrant } from "./work-authority.js";
import type { WorkArtifactStore } from "./work-artifacts.js";
import { readCanonicalWork } from "./work-projection.js";
import { indexCanonicalWork } from "./work-read.js";

export interface WorkResolution {
  plan: WorkPlan;
  grant: WorkGrant;
  title: string;
  workflow_input: Json;
}
const namespaceHash = (namespace: WorkNamespace) =>
  boundFingerprint(workNamespaceSchema.parse(namespace));
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

/** Owner-private database composition; transport callers use WorkAdmissionService. */
export class OwnerWorkAdmission {
  constructor(
    private readonly options: {
      id: string;
      store: WorkflowStore;
      artifacts?: WorkArtifactStore;
      verifiedEvaluator: () => boolean;
      now: () => number;
      artifact: (type: string, version: string) => WorkflowArtifact | undefined;
      job?: (type: string) => JobContract | undefined;
      retainWorkflow: (artifact: WorkflowArtifact) => void;
      prepareStart: (
        request: StartWorkflow,
        principal: string,
        grant: RunApproval,
      ) => { input: Json; accept: () => WorkflowRun };
      reserve: (run: string, bytes: number) => void;
    },
  ) {}
  lookup(namespace: WorkNamespace, key: string): WorkAdmission | null {
    const row = this.options.store.one<{ work_id: string }>(
      "SELECT work_id FROM workflow_work_admissions WHERE namespace_hash=? AND idempotency_key=?",
      namespaceHash(namespace),
      key,
    );
    return row ? readCanonicalWork(this.options.store, namespace, row.work_id) : null;
  }
  private consumeDelegation(
    request: WorkSubmission,
    authority: WorkAuthority,
    admission: WorkAdmission,
  ): void {
    const proof = authority.delegation;
    if (!proof) return; // Trusted owner-local callers still pass the normal authorization boundary.
    if (proof.expires_at <= this.options.now() || proof.request_hash !== admission.request_hash)
      throw new WorkflowError(
        "InvalidDelegation",
        "Delegation expired or differs from accepted intent.",
        403,
      );
    const evidence = workDelegationRecordSchema.parse(proof.evidence);
    if (
      boundFingerprint(evidence) !== proof.record_digest ||
      evidence.request_hash !== admission.request_hash ||
      boundFingerprint(evidence.authority.namespace) !== namespaceHash(authority.namespace)
    )
      throw new WorkflowError(
        "InvalidDelegation",
        "Transferred evidence differs from verified delegation.",
        403,
      );
    const binding = {
      namespace_hash: namespaceHash(authority.namespace),
      idempotency_key: request.idempotency_key,
      request_hash: admission.request_hash,
      work_id: admission.work_id,
      record_digest: proof.record_digest,
    };
    const existing = this.options.store.one<{ binding: string }>(
      "SELECT binding FROM workflow_work_nonces WHERE issuer=? AND nonce=?",
      proof.issuer,
      proof.nonce,
    );
    if (existing && existing.binding !== encodeEnvelope(binding))
      throw new WorkflowError(
        "NonceReplay",
        "Delegation nonce already identifies another request.",
        403,
      );
    if (!existing) {
      if (
        this.options.store.one<{ count: number }>(
          "SELECT count(*) count FROM workflow_work_nonces",
        )!.count >= 1000000
      )
        throw new WorkflowError(
          "NonceQuota",
          "Delegation nonce retention quota is exhausted.",
          429,
        );
      const retained = this.options.store.one(
        "SELECT 1 FROM workflow_work_delegations WHERE run_id=? AND record_digest=?",
        admission.workflow_id,
        proof.record_digest,
      );
      if (!retained) {
        this.options.reserve(
          admission.workflow_id,
          Buffer.byteLength(encodeEnvelope(evidence)) + 512,
        );
        this.options.store.run(
          "INSERT INTO workflow_work_delegations VALUES(?,?,?)",
          admission.workflow_id,
          proof.record_digest,
          encodeEnvelope(evidence),
        );
      }
      this.options.reserve(admission.workflow_id, Buffer.byteLength(encodeEnvelope(binding)) + 512);
      this.options.store.run(
        "INSERT INTO workflow_work_nonces VALUES(?,?,?,?,?,?)",
        proof.issuer,
        proof.nonce,
        admission.workflow_id,
        encodeEnvelope(binding),
        proof.assertion_hash,
        proof.expires_at,
      );
    }
  }
  acknowledge(request: WorkSubmission, authority: WorkAuthority): WorkAdmission {
    return this.options.store.transaction(() => {
      const admission = this.lookup(authority.namespace, request.idempotency_key);
      if (!admission || admission.request_hash !== workIntentHash(request, authority.namespace))
        throw new WorkflowError("IdempotencyConflict", "Accepted work binding differs.", 409);
      this.consumeDelegation(request, authority, admission);
      return admission;
    });
  }
  collectStaging(before = this.options.now() - 86_400_000): number {
    const artifacts = this.options.artifacts,
      store = this.options.store;
    if (!artifacts) return 0;
    if (!Number.isSafeInteger(before) || before > this.options.now() - 86_400_000)
      throw new Error("staging cleanup requires at least 24 hours of grace");
    const protectedSource = (namespace: string, digest: string) =>
      Boolean(
        artifacts.executorRetained(namespace, digest) || store.one(
          "SELECT 1 FROM workflow_work_sources WHERE namespace_hash=? AND digest=? LIMIT 1",
          namespace,
          digest,
        ) || store.one("SELECT 1 FROM workflow_artifacts WHERE digest=? LIMIT 1", digest),
      );
    for (const candidate of artifacts.scanStaging(64)) {
      if (candidate.modified_at > before) continue;
      store.transaction(() => {
        if (!protectedSource(candidate.namespace_hash, candidate.file))
          store.run(
            "INSERT OR IGNORE INTO workflow_work_artifact_gc VALUES(?,?,?,?)",
            candidate.namespace_hash,
            candidate.file,
            candidate.identity,
            this.options.now(),
          );
      });
    }
    let deleted = 0;
    for (const mark of store.rows<{ namespace_hash: string; file: string; file_identity: string }>(
      "SELECT * FROM workflow_work_artifact_gc LIMIT 64",
    )) {
      store.transaction(() => {
        if (!protectedSource(mark.namespace_hash, mark.file)) {
          const current = artifacts.candidate(mark.namespace_hash, mark.file);
          if (current && current.identity === mark.file_identity) {
            rmSync(current.path);
            deleted++;
          }
        }
        store.run(
          "DELETE FROM workflow_work_artifact_gc WHERE namespace_hash=? AND file=?",
          mark.namespace_hash,
          mark.file,
        );
      });
    }
    return deleted;
  }
  close(): void {
    this.options.artifacts?.close();
  }
  releaseSettled(): void {
    this.options.store.run(
      "UPDATE workflow_work_reservations SET state='released' WHERE rowid IN (SELECT q.rowid FROM workflow_work_reservations q JOIN workflow_runs r ON r.id=q.run_id WHERE q.state='reserved' AND r.status NOT IN ('running','blocked') AND NOT EXISTS(SELECT 1 FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=r.id AND a.physical_state!='settled') AND NOT EXISTS(SELECT 1 FROM workflow_session_bindings b WHERE b.run_id=r.id AND b.state!='complete') LIMIT 64)",
    );
  }
  commit(
    request: WorkSubmission,
    authority: WorkAuthority,
    resolution: WorkResolution,
    creation?: { created: boolean },
  ): WorkAdmission {
    request = workSubmissionSchema.parse(request);
    const namespace = workNamespaceSchema.parse(authority.namespace);
    if (namespace.principal_kind !== "operator" && namespace.principal_id === "local-operator") throw new WorkflowError("InvalidAuthority", "Reserved operator identity cannot be delegated.", 403);
    const hash = workIntentHash(request, namespace),
      store = this.options.store;
    if (namespace.installation !== this.options.id)
      throw new WorkflowError(
        "InvalidAuthority",
        "Authority belongs to another installation.",
        403,
      );
    return store.transaction(() => {
      const previous = this.lookup(namespace, request.idempotency_key);
      if (previous) {
        if (previous.request_hash !== hash)
          throw new WorkflowError(
            "IdempotencyConflict",
            "This key already identifies different work.",
            409,
          );
        this.consumeDelegation(request, authority, previous);
        return previous;
      }
      assertRecoveryAdmission(store, request.idempotency_key, request.recovery_epoch);
      const artifacts = this.options.artifacts;
      if (!this.options.verifiedEvaluator())
        throw new WorkflowError("UnsupportedWorkRuntime", "Common work requires the verified artifact evaluator; synchronous definitions cannot run during acceptance.", 409);
      if (!artifacts)
        throw new WorkflowError(
          "ArtifactStoreUnavailable",
          "Retained source storage is not configured.",
          503,
          true,
        );
      const grant = validateWorkGrant(resolution.grant, authority);
      const plan = workPlanSchema.parse(resolution.plan);
      const registeredJob = plan.definition.kind === "job" ? this.options.job?.(plan.definition.reference) : undefined;
      if (plan.workflow.type === "action-script" && !plan.process_program)
        throw new WorkflowError("UnsupportedProcessProgram", "Script wrappers require an explicit retained process declaration.", 409);
      if (registeredJob && !plan.node_job)
        throw new WorkflowError("UnsupportedNodeJob", "Registered node jobs require an explicit retained process declaration.", 409);
      if (
        boundFingerprint(request.definition) !== boundFingerprint(plan.definition) ||
        plan.grant_ref !== grant.grant_ref ||
        plan.grant_revision !== grant.revision ||
        plan.grant_digest !== boundFingerprint(grant)
      )
        throw new WorkflowError(
          "InvalidPlan",
          "Resolved plan differs from the authorized definition or grant.",
          403,
        );
      if (boundFingerprint(request.origin) !== boundFingerprint(authority.origin))
        throw new WorkflowError("InvalidOrigin", "Trigger provenance is not authorized.", 403);
      if (plan.node_job) {
        const job = plan.node_job, source = plan.source_closure.find(item => item.purpose === "source" && item.digest === job.source_digest);
        const input = jobRunInputSchema.safeParse(resolution.workflow_input);
        if (plan.definition.kind !== "job" || job.activity_type !== plan.definition.reference ||
          plan.workflow.type !== "job" || plan.workflow.version !== "1" ||
          !input.success || input.data.job !== job.activity_type || boundFingerprint(input.data.input) !== boundFingerprint(request.inputs) ||
          !registeredJob || registeredJob.digest !== job.source_digest ||
          registeredJob.timeoutMs !== undefined && plan.execution_budget_ms > registeredJob.timeoutMs ||
          (registeredJob.outputSchema ? job.output !== "json" || plan.validation?.mode !== "json-schema" || boundFingerprint(plan.validation.schema) !== boundFingerprint(registeredJob.outputSchema) : job.output !== "none" || plan.validation?.mode !== "none") ||
          plan.resources.executor !== "process" || plan.resources.endpoint !== null || plan.workspace.kind !== "none" || !plan.validation ||
          job.output === "none" && plan.validation.mode !== "none" ||
          boundFingerprint(job.scope) !== boundFingerprint(grant.effective_scope) ||
          !job.scope.bound?.files?.allow || job.scope.bound.files.allow.length !== 0 ||
          "refused" in boundToNodeFlags(job.scope.bound) || !source ||
          inspectArtifact(artifacts.path(source), job.activity_type, "activity", false).digest !== job.source_digest)
          throw new WorkflowError("UnsupportedNodeJob", "Node job requires its retained no-files scope, installed source and explicit output validation contract.", 409);
      }
      if (plan.process_program) {
        const program = plan.process_program;
        assertProcessProgramScope(program); assertProcessProgramDirectory(program); assertProcessProgramRuntime(program);
        const runtime = plan.source_closure.find(source => boundFingerprint(source) === boundFingerprint(program.runtime));
        const inputMatches = plan.workflow.version === "1"
          ? program.input_digest === undefined && boundFingerprint(resolution.workflow_input) === boundFingerprint(request.inputs) && plan.workflow.input_digest === boundFingerprint(request.inputs)
          : plan.workflow.version === "2" && program.input_digest === boundFingerprint(request.inputs) &&
            boundFingerprint(resolution.workflow_input) === boundFingerprint({ activity_type: program.activity_type, input: request.inputs, execution_budget_ms: plan.execution_budget_ms }) &&
            plan.workflow.input_digest === boundFingerprint(resolution.workflow_input);
        if (plan.node_job || plan.definition.kind !== "action" || plan.workflow.type !== "action-script" || !inputMatches ||
          program.credential_owner.kind === "installation" && authority.namespace.principal_kind !== "operator" ||
          program.installation !== authority.namespace.installation || boundFingerprint(program.scope) !== boundFingerprint(grant.effective_scope) ||
          plan.resources.executor !== "process" || plan.resources.endpoint !== null || plan.execution_profile !== "portable" ||
          plan.effect_policy.class !== "non-repeatable" || plan.effect_policy.max_attempts !== 1 ||
          plan.workspace.kind !== "host-bound" || plan.workspace.installation !== program.installation ||
          plan.workspace.resource_ref !== boundFingerprint(program.cwd) || plan.workspace.mapping_version !== 1 ||
          !runtime || !program.argv.some(value => typeof value !== "string") && program.source_digest !== program.runtime.digest || !plan.source_closure.some(source => source.purpose === "source" && source.digest === program.source_digest) ||
          !plan.validation || (program.output === "json" ? plan.validation.mode !== "json-schema" : plan.validation.mode !== "none"))
          throw new WorkflowError("UnsupportedProcessProgram", "Process program needs exact retained authority, source/runtime, inputs and local workspace mapping.", 409);
        artifacts.verify(runtime);
        for (const command of Object.values(program.commands ?? {})) {
          if (!command) continue;
          if (!plan.source_closure.some(source => boundFingerprint(source) === boundFingerprint(command.runtime)))
            throw new WorkflowError("WorkSourceManifestInvalid", "Command runtime is absent from the retained source closure.", 409);
          artifacts.verify(command.runtime);
          const declared = { ...program, runtime: command.runtime, runtime_path: command.runtime_path, cwd: command.cwd };
          assertProcessProgramDirectory(declared); assertProcessProgramRuntime(declared);
        }
        if (program.bundle) {
          if (!plan.source_closure.some(source => boundFingerprint(source) === boundFingerprint(program.bundle!.source)))
            throw new WorkflowError("WorkSourceManifestInvalid", "The program bundle is absent from its retained source closure.", 409);
          assertProcessProgramBundle(program, artifacts.verify(program.bundle.source));
        }
      }
      const lane =
        authority.origin.trigger === "schedule"
          ? "scheduled"
          : authority.origin.trigger === "internal"
            ? "internal"
            : "unscheduled";
      if (
        plan.resources.lane !== lane ||
        plan.resources.host_reservation !== null ||
        plan.resources.endpoint?.reservation
      )
        throw new WorkflowError(
          "InvalidResources",
          "Admission cannot mint physical or protected-lane authority.",
          403,
        );
      const registered = this.options.artifact(plan.workflow.type, plan.workflow.version);
      const source = plan.source_closure.find(
        (item) => item.digest === registered?.digest && item.purpose === "source",
      );
      if (
        !registered ||
        !source ||
        registered.digest !== plan.workflow.artifact_digest ||
        plan.workflow.runtime_abi !== artifactAbi
      )
        throw new WorkflowError(
          "UnsupportedDefinition",
          "Work requires its registered, retained workflow artifact.",
          409,
        );
      for (const reference of plan.source_closure) {
        if (
          reference.owner_identity !== namespace.identity_id &&
          !(reference.owner_identity === null && reference.purpose === "source")
        )
          throw new WorkflowError(
            "ArtifactForbidden",
            "Source closure belongs to another identity.",
            403,
          );
        if (
          store.one(
            "SELECT 1 FROM workflow_work_artifact_gc WHERE namespace_hash=? AND file=?",
            boundFingerprint(reference.owner_identity),
            reference.digest,
          )
        )
          throw new WorkflowError(
            "ArtifactCollectionPending",
            "Source collection is pending; restage after collection completes.",
            503,
            true,
          );
        artifacts.verify(reference);
      }
      if (
        store.one<{ count: number }>("SELECT count(*) count FROM workflow_work_admissions")!
          .count >= 1_000_000
      )
        throw new WorkflowError(
          "TombstoneQuota",
          "Work idempotency retention quota is exhausted.",
          429,
        );
      this.releaseSettled();
      const caller = boundFingerprint([
        namespace.principal_kind,
        namespace.principal_id,
        namespace.caller_session_id,
      ]);
      const count = (condition: string, ...args: string[]) =>
        store.one<{ count: number }>(
          `SELECT count(*) count FROM workflow_work_reservations WHERE state='reserved' AND ${condition}`,
          ...args,
        )!.count;
      if (
        plan.resources.executor === "agent" &&
        (count("executor='agent' AND caller=?", caller) >= 4 ||
          (lane === "scheduled"
            ? count("executor='agent' AND lane='scheduled'") >= 4
            : count("executor='agent' AND lane!='scheduled'") >= 16))
      )
        throw new WorkflowError("executor_busy", "Detached agent admission capacity is full.", 429);
      if (plan.resources.executor === "process" && count("executor='process'") >= 200)
        throw new WorkflowError("script_capacity", "Process work admission capacity is full.", 429);
      if (plan.resources.executor === "tool" && count("executor='tool'") >= 8)
        throw new WorkflowError("tool_capacity", "Scoped tool admission capacity is full.", 429);
      const workId = id("work"),
        workflowId = request.recovery_epoch ? `${request.recovery_epoch}:${id("awf")}` : id("awf"),
        at = this.options.now();
      plan.resources.logical_reservation = id("quota");
      const job = {
        traits: grant.effective_scope.traits,
        ...(grant.effective_scope.identity ? { identity: grant.effective_scope.identity } : {}),
        ...(grant.effective_scope.harness ? { harness: grant.effective_scope.harness } : {}),
        profile: plan.execution_profile,
      };
      const legacy: RunApproval = {
        version: 2,
        revision: 1,
        authorizer: grant.authorizer,
        createdBy: grant.created_by,
        approvedAt: grant.approved_at,
        reason: "Work admitted",
        scope: grant.effective_scope,
        job,
      };
      // Retained bytes replace the mutable registration path without changing its pinned digest.
      this.options.retainWorkflow({ ...registered, path: artifacts.path(source) });
      const prepared = this.options.prepareStart(
        {
          id: workflowId,
          ...(request.recovery_epoch ? { recoveryEpoch: request.recovery_epoch } : {}),
          type: plan.workflow.type,
          version: plan.workflow.version,
          input: resolution.workflow_input,
          timeoutMs: plan.overall_budget_ms ?? Math.min(31_536_000_000, plan.dispatch_budget_ms + plan.execution_budget_ms),
          job,
        },
        grant.authorizer,
        legacy,
      );
      plan.workflow.input_digest = boundFingerprint(JSON.parse(encodePayload(prepared.input)));
      const admission = workAdmissionSchema.parse({
        version: 2,
        request_id: request.request_id,
        idempotency_key: request.idempotency_key,
        namespace,
        work_id: workId,
        workflow_id: workflowId,
        action_id: plan.definition.kind === "action" ? id("arn") : null,
        job_run_id: plan.definition.kind === "job" ? id("jrn") : null,
        request_hash: hash,
        plan_digest: workPlanHash(plan),
        plan,
        grant_ref: grant.grant_ref,
        grant_revision: grant.revision,
        origin: authority.origin,
        title: resolution.title,
        accepted_at: at,
        dispatch_deadline: at + plan.dispatch_budget_ms,
        first_started_at: null,
        execution_deadline: null,
        revision: 1,
        facts: {
          coordinator: "running",
          phase: "queued",
          wait: "none",
          physical: "not-started",
          effect: "not-started",
          stop_requested: false,
          has_result: false,
          can_continue: false,
          can_retry_step: false,
          can_respond: false,
        },
        reason: null,
        receipt_ref: null,
        projection: { desired_revision: 1, applied_revision: 0 },
        notification: { desired_revision: 0, applied_revision: 0 },
      });
      prepared.accept();
      const record = encodeEnvelope(admission),
        evidence = encodeEnvelope(grant);
      store.run(
        "INSERT INTO workflow_work_admissions VALUES(?,?,?,?,?,?,?)",
        workId,
        workflowId,
        namespaceHash(namespace),
        request.idempotency_key,
        hash,
        record,
        at,
      );
      store.run(
        "INSERT INTO workflow_work_grants VALUES(?,?,?,?,?)",
        workflowId,
        grant.grant_ref,
        grant.revision,
        boundFingerprint(grant),
        evidence,
      );
      indexCanonicalWork(store, admission);
      for (const reference of plan.source_closure)
        store.run(
          "INSERT OR IGNORE INTO workflow_work_sources VALUES(?,?,?,?,?)",
          workflowId,
          boundFingerprint(reference.owner_identity),
          reference.digest,
          reference.bytes,
          reference.purpose,
        );
      store.run(
        "INSERT INTO workflow_work_reservations VALUES(?,?,?,?,?, 'reserved')",
        workflowId,
        plan.resources.logical_reservation,
        plan.resources.executor,
        lane,
        caller,
      );
      // Full initial projection is intentional; notification payloads are added
      // later from access-controlled summary fields, never from raw inputs.
      store.run(
        "INSERT INTO workflow_work_outbox VALUES(?,'projection',1,0,?)",
        workflowId,
        record,
      );
      this.options.reserve(
        workflowId,
        Buffer.byteLength(record) * 2 +
          Buffer.byteLength(evidence) +
          plan.source_closure.length * 256 +
          3072,
      );
      this.consumeDelegation(request, authority, admission);
      if (creation) creation.created = true;
      return admission;
    });
  }
}

/** Authenticated admission lookup always precedes mutable catalog resolution. */
export class WorkAdmissionService<Credentials> {
  private readonly pending = new Map<string, Promise<WorkAdmission>>();
  constructor(
    private readonly options: {
      owner: {
        admitWorkWithReceipt?(
          request: WorkSubmission,
          authority: WorkAuthority,
          resolution: WorkResolution,
        ): { work: WorkAdmission; created: boolean };
        assertWorkAdmission?(request: WorkSubmission): void;
        acknowledgeWork?(request: WorkSubmission, authority: WorkAuthority): WorkAdmission;
        workByKey(namespace: WorkNamespace, key: string): WorkAdmission | null;
        admitWork(
          request: WorkSubmission,
          authority: WorkAuthority,
          resolution: WorkResolution,
        ): WorkAdmission;
      };
      authenticate: (
        request: WorkSubmission,
        credentials: Credentials,
        operation: "lookup" | "admit",
      ) => Promise<WorkAuthority>;
      resolve: (request: WorkSubmission, authority: WorkAuthority) => Promise<WorkResolution>;
    },
  ) {}
  async submit(input: WorkSubmission, credentials: Credentials): Promise<WorkAdmission> {
    return this.submitRecord(input, credentials, () => {});
  }
  async submitWithReceipt(
    input: WorkSubmission,
    credentials: Credentials,
  ): Promise<{ work: WorkAdmission; created: boolean }> {
    let created = false;
    const work = await this.submitRecord(input, credentials, (value) => {
      created = value;
    });
    return { work, created };
  }
  private async submitRecord(
    input: WorkSubmission,
    credentials: Credentials,
    created: (value: boolean) => void,
  ): Promise<WorkAdmission> {
    const request = workSubmissionSchema.parse(input);
    const authority = await this.options.authenticate(request, credentials, "lookup");
    if (
      boundFingerprint(request.origin) !== boundFingerprint(authority.origin) ||
      (request.origin.caller_session_id ?? null) !== authority.namespace.caller_session_id
    )
      throw new WorkflowError("InvalidOrigin", "Trigger provenance is not authorized.", 403);
    const hash = workIntentHash(request, authority.namespace);
    const previous = this.options.owner.workByKey(authority.namespace, request.idempotency_key);
    if (previous) {
      if (previous.request_hash !== hash)
        throw new WorkflowError(
          "IdempotencyConflict",
          "This key already identifies different work.",
          409,
        );
      if (authority.delegation && !this.options.owner.acknowledgeWork)
        throw new WorkflowError(
          "DelegationUnsupported",
          "Owner cannot durably consume delegation.",
          503,
        );
      return this.options.owner.acknowledgeWork?.(request, authority) ?? previous;
    }
    const key = boundFingerprint([authority.namespace, request.idempotency_key, hash]);
    const pending = this.pending.get(key);
    if (pending) {
      const accepted = await pending;
      const current = await this.options.authenticate(request, credentials, "lookup");
      if (boundFingerprint(current.namespace) !== boundFingerprint(accepted.namespace))
        throw new WorkflowError("AuthorityChanged", "Read authority changed while waiting.", 403);
      return this.options.owner.acknowledgeWork?.(request, current) ?? accepted;
    }
    const admissionAuthority = await this.options.authenticate(request, credentials, "admit");
    if (boundFingerprint(admissionAuthority) !== boundFingerprint(authority))
      throw new WorkflowError("AuthorityChanged", "Authority changed before resolution.", 409);
    this.options.owner.assertWorkAdmission?.(request);
    const joined = this.pending.get(key);
    if (joined) {
      const accepted = await joined;
      const current = await this.options.authenticate(request, credentials, "lookup");
      if (boundFingerprint(current.namespace) !== boundFingerprint(accepted.namespace))
        throw new WorkflowError("AuthorityChanged", "Read authority changed while waiting.", 403);
      return this.options.owner.acknowledgeWork?.(request, current) ?? accepted;
    }
    const acceptance = (async () => {
      const resolution = await this.options.resolve(request, authority);
      // Resolution can await catalog/storage operations. Policy must still
      // authorize this same namespace and ceiling immediately before commit.
      const current = await this.options.authenticate(request, credentials, "admit");
      if (boundFingerprint(current) !== boundFingerprint(authority))
        throw new WorkflowError(
          "AuthorityChanged",
          "Authority changed during resolution; submit after refreshing policy.",
          409,
        );
      if (this.options.owner.admitWorkWithReceipt) {
        const accepted = this.options.owner.admitWorkWithReceipt(request, current, resolution);
        created(accepted.created);
        return accepted.work;
      }
      const accepted = this.options.owner.admitWork(request, current, resolution);
      created(true);
      return accepted;
    })();
    this.pending.set(key, acceptance);
    try {
      return await acceptance;
    } finally {
      if (this.pending.get(key) === acceptance) this.pending.delete(key);
    }
  }
}
