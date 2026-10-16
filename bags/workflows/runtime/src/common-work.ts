import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundFingerprint, mergeBounds, approvedBoundsSchema, type ApprovedBounds, type Bound } from "@barry-rocks/sdk/bounds";
import {
  WorkArtifactStore, WorkResourceBroker, WorkDelegationIssuer, WorkDelegationVerifier, WorkAdmissionService,
  createProcessWorkWorker, connectWorkOwnerV3, inspectArtifact, verifyArtifact, unmetRequirement, boundToNodeFlags, readWorkDelegationKeys, workDelegationSigningKey, readBoundedFile, WorkflowError,
  type WorkSubmission, type WorkAuthority, type WorkPolicyDispatcher, type WorkflowOwner, type WorkResolution, type createRunBoundRefresh, type InstalledJob,
  assertProcessProgramScope,
} from "@barry-rocks/sdk/internal/workflows";
import { commonAgentType, resolveCommonAgent } from "./common-agents.js";
import type { WorkAgentCatalog, InstalledWorkAgent } from "@barry-rocks/sdk/internal/workflows";
import { validateActionInputs } from "@barry-rocks/sdk/internal/actions";
import type { InstalledScript, WorkProcessProgram, WorkExecutionStart } from "@barry-rocks/sdk/internal/workflows";

export function jobScope(scope: ApprovedBounds, bound: Bound): ApprovedBounds {
  const { fingerprint: _fingerprint, ...evidence } = scope;
  const candidate = { ...evidence, bound: mergeBounds(scope.bound, bound) };
  return approvedBoundsSchema.parse({ ...candidate, fingerprint: boundFingerprint(candidate) });
}

const hostConfiguration = z.strictObject({ version: z.literal(1), mode: z.enum(["embedded", "external"]), worker_ids: z.array(z.uuid()).max(16) })
  .refine(value => new Set(value.worker_ids).size === value.worker_ids.length && (value.mode !== "external" || value.worker_ids.length > 0));
export function readCommonHosts(path?: string): z.infer<typeof hostConfiguration> {
  if (!path) return { version: 1, mode: "embedded", worker_ids: [] };
  try {
    if (!isAbsolute(path)) throw new Error("absolute host configuration path required");
    return hostConfiguration.parse(JSON.parse(readBoundedFile(path, 16384).toString("utf8")));
  } catch { throw new WorkflowError("WorkHostConfigurationInvalid", "Shared local process host configuration is unreadable or invalid.", 503); }
}

/** Installed ownership for common work. Admission is configured explicitly; the
 * retained worker/journal keeps recovering existing work when admission is disabled. */
export function localCommonWork(options: {
  installation: string; directory: string; builtin: string; capacity: number;
  jobWorkflow?: string;
  jobs?: readonly InstalledJob[];
  jobBound?: (job: InstalledJob) => Promise<Bound | null>;
  agents?: { catalog: WorkAgentCatalog; agents: InstalledWorkAgent[]; catalogSource: import("@barry-rocks/sdk/internal/workflows").WorkArtifactRef }; retainedAgents?: InstalledWorkAgent[]; retainedAgentCatalogs?: WorkAgentCatalog[]; agentWorkflow?: string;
  scriptWorkflow?: string; scripts?: readonly InstalledScript[];
  scriptTraits?: string[];
  retainedScripts?: Record<string, string>; maxArtifactBytes?: number;
  resolveProcessSecrets?: (start: WorkExecutionStart) => Promise<Record<string, string>>;
  checkProcessSecrets?: (program: WorkProcessProgram) => Promise<void>;
  labels: Record<string, string>; keyRingPath?: string;
  refresh: ReturnType<typeof createRunBoundRefresh>;
  policy: WorkPolicyDispatcher;
  hosts?: ReturnType<typeof readCommonHosts>;
  permitsHost?: (worker: string, type: string) => boolean;
  onError: (error: unknown) => void;
}) {
  const workerId = `${options.installation}:common`;
  const hosts = options.hosts ?? readCommonHosts(), external = new Set(hosts.worker_ids);
  const jobs = new Map((options.jobs ?? []).filter(job => !unmetRequirement(job, options.labels)).map(job => [job.type, job]));
  const agents = new Map((options.agents?.agents ?? []).map(agent => [agent.profile.reference, agent]));
  const allAgents = new Map([...(options.retainedAgents ?? []), ...agents.values()].map(agent => [commonAgentType(agent), agent]));
  const agentActivities = Object.fromEntries([...allAgents].map(([type, agent]) => [type, agent.source.digest]));
  const deployments = [...(options.retainedAgentCatalogs ?? []), ...(options.agents ? [options.agents.catalog] : [])];
  const agentWorkers = new Set(deployments.map(deployment => deployment.worker_id));
  const agentPermitted = (worker: string, type: string) => allAgents.has(type) && deployments.some(deployment => deployment.worker_id === worker && deployment.profiles.some(profile => profile.digest === allAgents.get(type)!.source.digest)) && options.permitsHost?.(worker, type) === true;
  const scripts = new Map((options.scripts ?? []).map(script => [script.action.qualifiedName, script]));
  const scriptActivities = { ...options.retainedScripts, ...Object.fromEntries([...scripts.values()].map(script => [script.type, script.source.digest])) };
  const permits = (worker: string, type: string) => agentPermitted(worker, type) || (type === "echo@1" || jobs.has(type) || Object.hasOwn(scriptActivities, type)) && (worker === workerId ||
    external.has(worker) && options.permitsHost?.(worker, type) === true);
  const artifacts = new WorkArtifactStore(join(options.directory, "work-artifacts"), options.maxArtifactBytes);
  for (const script of scripts.values()) for (const source of script.sources) artifacts.retainExecutor(source);
  const broker = new WorkResourceBroker({ path: join(options.directory, "work-resources.db"), broker: options.installation,
    limits: { [options.installation]: { kind: "host" } } });
  const endpointBrokers = new Map<string, WorkResourceBroker>(), endpointDefinitions = new Map<string, string>();
  for (const deployment of deployments) {
    const endpoint = deployment.endpoint_broker, fingerprint = boundFingerprint(endpoint);
    if (endpoint.id === broker.id || endpoint.path === join(options.directory, "work-resources.db")
      || endpointDefinitions.has(endpoint.id) && endpointDefinitions.get(endpoint.id) !== fingerprint) throw new Error("WorkAgentEndpointBrokerConflict");
    if (!endpointBrokers.has(endpoint.id)) {
      endpointBrokers.set(endpoint.id, new WorkResourceBroker({ path: endpoint.path, broker: endpoint.id, limits: endpoint.limits }));
      endpointDefinitions.set(endpoint.id, fingerprint);
    }
  }
  const agentWorkflow = options.agentWorkflow ? inspectArtifact(options.agentWorkflow, "action-agent", "1") : undefined;
  const agentWrapper = agentWorkflow ? artifacts.stage(verifyArtifact(agentWorkflow), { owner_identity: null, purpose: "source", media_type: "text/javascript" }) : undefined;
  for (const agent of allAgents.values()) for (const source of agent.sources) artifacts.retainExecutor(source);
  const source = artifacts.stage(readFileSync(options.builtin), { owner_identity: null, purpose: "source", media_type: "text/javascript" });
  const workflow = inspectArtifact(options.builtin, "echo", "1");
  const jobWorkflow = options.jobWorkflow ? inspectArtifact(options.jobWorkflow, "job", "1") : undefined;
  const jobWrapper = jobWorkflow ? artifacts.stage(verifyArtifact(jobWorkflow), { owner_identity: null, purpose: "source", media_type: "text/javascript" }) : undefined;
  const jobSources = new Map([...jobs.values()].map(job => [job.type, artifacts.stage(verifyArtifact({ path: job.main, digest: job.contract.digest, abi: workflow.abi, type: job.type, version: "activity" }), { owner_identity: null, purpose: "source", media_type: "text/javascript" })]));
  const scriptWorkflow = options.scriptWorkflow ? inspectArtifact(options.scriptWorkflow, "action-script", "2") : undefined;
  const scriptWrapper = scriptWorkflow ? artifacts.stage(verifyArtifact(scriptWorkflow), { owner_identity: null, purpose: "source", media_type: "text/javascript" }) : undefined;
  const operatorIssuerName = "workflows.runtime.operator";
  const readKeys = () => options.keyRingPath ? readWorkDelegationKeys(options.keyRingPath) : {};
  const operatorKey = () => workDelegationSigningKey(readKeys()[operatorIssuerName] ?? []);
  readKeys(); // Refuse malformed installation configuration before becoming ready.
  return {
    workerId, artifacts, permits, scriptActivities, agentActivities, externalHost: (worker: string) => external.has(worker) || agentWorkers.has(worker),
    resources: { brokers: new Map([[broker.id, broker], ...endpointBrokers]), host: (_work: unknown, worker: string) => {
      if (worker !== workerId && !external.has(worker) && !agentWorkers.has(worker)) throw new WorkflowError("WorkResourcesUnavailable", "This installation has no resource adapter for the selected remote worker.", 409);
      return { broker: broker.id, resource: options.installation };
    } },
    attach(owner: WorkflowOwner) {
      const verifier = new WorkDelegationVerifier({ installation: options.installation,
        keys: issuer => { const keys = readKeys(); return Object.hasOwn(keys, issuer) ? keys[issuer] : []; },
        authorizeIssuer: record => {
          const { namespace, origin, run_identity } = record.authority;
          if (origin.producer_ref || origin.occurrence_id || origin.parent_work_id) return false;
          if (record.issuer === "workflows.sessions.identity")
            return record.source_kind === "session" && namespace.principal_kind === "identity"
              && origin.trigger === "invocation" && ["sessions-work-api", "sessions-agent-work-api"].includes(origin.entry_point)
              && namespace.caller_session_id !== null && namespace.identity_id !== null;
          const entry = record.issuer === operatorIssuerName ? "work-api"
            : record.issuer === "workflows.cli.operator" ? "work-cli" : null;
          return entry !== null && record.source_kind === "operator" && namespace.principal_kind === "operator"
            && namespace.principal_id === "local-operator" && namespace.identity_id === null
            && namespace.caller_session_id === null && run_identity === null
            && origin.trigger === "manual" && origin.entry_point === entry;
        },
        currentPolicy: async record => {
          if (record.authority.namespace.principal_kind === "service") throw new WorkflowError("WorkAuthorityUnavailable", "No service-principal policy is installed.", 403);
          const original = record.authority.caller_ceiling;
          return options.refresh({ identity: original.identity, bags: original.bags, bounds: original.bounds, traits: original.traits, harness: original.harness, profile: "portable" }, record.authority.namespace.principal_id,
            record.authority.namespace.principal_kind === "identity" ? { identity: record.authority.namespace.principal_id, bags: original.bags, bounds: original.bounds, traits: original.traits, harness: original.harness } : undefined).catch((error: unknown) => { options.onError(error); throw error; });
        } });
      const admission = options.keyRingPath ? new WorkAdmissionService({ owner, authenticate: verifier.authenticate.bind(verifier),
        resolve: async (request, authority): Promise<WorkResolution> => {
          if (request.definition.kind === "action" && !request.overrides && agents.has(request.definition.reference)) {
            const agent = agents.get(request.definition.reference)!;
            if (!agentWorkflow || !agentWrapper || !options.agents || !endpointBrokers.has(options.agents.catalog.endpoint_broker.id) || request.definition.catalog_namespace !== agent.profile.reference.split(":")[0])
              throw new WorkflowError("WorkDefinitionUnavailable", "Installed agent definition is unavailable.", 422);
            return resolveCommonAgent(agent, request, authority, options.installation, agentWorkflow, agentWrapper, options.agents.catalog.endpoint_broker.id, options.agents.catalogSource);
          }
          if (request.definition.kind === "action" && !request.overrides) {
            if (authority.origin.entry_point === "sessions-agent-work-api") throw new WorkflowError("WorkDefinitionUnavailable", "No retained agent definition is installed for this action.", 422);
            const script = scripts.get(request.definition.reference);
            if (!script || !scriptWorkflow || !scriptWrapper || request.definition.catalog_namespace !== script.action.bag)
              throw new WorkflowError("WorkDefinitionUnavailable", "Installed script definition is unavailable.", 422);
            if (script.action.context === "session" && authority.namespace.caller_session_id === null)
              throw new WorkflowError("WorkActionContextUnavailable", "This action requires its original calling session.", 409);
            const inputs = z.record(z.string(), z.json()).parse(request.inputs), invalid = validateActionInputs(script.action, inputs);
            if (invalid.length) throw new WorkflowError("InvalidInputs", invalid.join(" "), 422, false, "not-accepted");
            const scope = authority.caller_ceiling, program: WorkProcessProgram = { ...script.program, scope, input_digest: boundFingerprint(inputs),
              credential_owner: authority.namespace.identity_id ? { kind: "identity", identity: authority.namespace.identity_id } : authority.namespace.principal_kind === "operator" ? { kind: "installation", installation: options.installation } : { kind: "none" } };
            assertProcessProgramScope(program);
            if (program.secret_names.length) {
              try { if (!options.checkProcessSecrets) throw new Error("No selected credential resolver."); await options.checkProcessSecrets(program); }
              catch { throw new WorkflowError("WorkCredentialsUnavailable", "Declared script credentials are unavailable from the selected owner.", 409, false, "not-accepted"); }
            }
            const grant = { version: 2 as const, grant_ref: `grant_${randomUUID()}`, revision: 1, namespace: authority.namespace,
              authorizer: authority.namespace.principal_id, created_by: authority.namespace.principal_id, approved_at: Date.now(), original_caller_ceiling: scope, effective_scope: scope,
              definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "installed-script-v1" };
            const budget = (script.action.timeout ?? 600) * 1000, input = { activity_type: script.type, input: inputs, execution_budget_ms: budget };
            return { grant, title: script.action.name, workflow_input: input, plan: {
              version: 2, definition: request.definition, workflow: { type: "action-script", version: "2", artifact_digest: scriptWorkflow.digest, runtime_abi: scriptWorkflow.abi, input_digest: boundFingerprint(input) },
              source_closure: [scriptWrapper, ...script.sources], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable",
              effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: script.action.outputSchema ? { mode: "json-schema", schema: z.record(z.string(), z.json()).parse(script.action.outputSchema) } : { mode: "none" }, process_program: program,
              resources: { executor: "process", lane: authority.origin.trigger === "schedule" ? "scheduled" : authority.origin.trigger === "internal" ? "internal" : "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: null },
              workspace: { kind: "host-bound", installation: options.installation, resource_ref: boundFingerprint(program.cwd), mapping_version: 1 },
              selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: budget, dispatch_budget_ms: 120000,
            } };
          }
          if (request.definition.kind === "job" && !request.overrides) {
            const job = jobs.get(request.definition.reference), retained = jobSources.get(request.definition.reference);
            if (!job || !retained || !jobWorkflow || !jobWrapper) throw new WorkflowError("WorkDefinitionUnavailable", "Registered job is unavailable on this installation.", 422);
            const bound = options.jobBound ? await options.jobBound(job) : job.bound;
            if (!bound) throw new WorkflowError("WorkDefinitionUnavailable", "Registered job definition bounds are unavailable.", 409);
            const scope = jobScope(authority.caller_ceiling, bound);
            if ("refused" in boundToNodeFlags(scope.bound)) throw new WorkflowError("UnsupportedNodeJob", "The complete caller and job scope cannot be enforced by the node-job adapter.", 409);
            const grant = { version: 2 as const, grant_ref: `grant_${randomUUID()}`, revision: 1, namespace: authority.namespace,
              authorizer: authority.namespace.principal_id, created_by: authority.namespace.principal_id, approved_at: Date.now(),
              original_caller_ceiling: authority.caller_ceiling, effective_scope: scope, definition_bounds_digest: boundFingerprint(bound), policy_revision: "installed-node-job-v1" };
            const input = { job: job.type, input: request.inputs, placement: { requires: job.requires.labels } };
            return { grant, title: job.type, workflow_input: input, plan: {
              version: 2, definition: request.definition, workflow: { type: "job", version: "1", artifact_digest: jobWorkflow.digest, runtime_abi: jobWorkflow.abi, input_digest: boundFingerprint(input) },
              source_closure: [jobWrapper, retained], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2",
              execution_profile: "portable", effect_policy: { class: "non-repeatable", max_attempts: 1 },
              validation: job.contract.outputSchema ? { mode: "json-schema", schema: z.record(z.string(), z.json()).parse(job.contract.outputSchema) } : { mode: "none" },
              node_job: { activity_type: job.type, source_digest: job.contract.digest, scope, output: job.contract.outputSchema ? "json" : "none" },
              resources: { executor: "process", lane: authority.origin.trigger === "schedule" ? "scheduled" : authority.origin.trigger === "internal" ? "internal" : "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: null }, workspace: { kind: "none" },
              selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: job.contract.timeoutMs ?? 60000, dispatch_budget_ms: 120000,
            } };
          }
          if (request.definition.kind !== "workflow" || request.definition.reference !== "echo" || request.definition.version !== "1" || request.overrides)
            throw new WorkflowError("WorkDefinitionUnavailable", "This adapter supports echo and eligible registered node jobs without overrides.", 422);
          const input = z.strictObject({ message: z.json(), delayMs: z.number().int().min(0).max(60000).optional() }).parse(request.inputs);
          const scope = authority.caller_ceiling;
          const grant = { version: 2 as const, grant_ref: `grant_${randomUUID()}`, revision: 1, namespace: authority.namespace,
            authorizer: authority.namespace.principal_id, created_by: authority.namespace.principal_id, approved_at: Date.now(),
            original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "installed-echo-v1" };
          return { grant, title: "Echo", workflow_input: input, plan: {
            version: 2, definition: request.definition, workflow: { type: workflow.type, version: workflow.version, artifact_digest: workflow.digest, runtime_abi: workflow.abi, input_digest: boundFingerprint(input) },
            source_closure: [source], grant_ref: grant.grant_ref, grant_revision: grant.revision, grant_digest: boundFingerprint(grant), executor_generation: "work-v2",
            execution_profile: "portable", effect_policy: { class: "pure", max_attempts: 1, retry_budget_ms: 30000 }, validation: { mode: "none" },
            resources: { executor: "process", lane: "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: null }, workspace: { kind: "none" },
            selection: { requested_model: null, resolved_model: null, endpoint: null, requested_harness: null, resolved_harness: null, provenance: "definition" }, execution_budget_ms: 30000, dispatch_budget_ms: 120000,
          } };
        } }) : undefined;
      const operatorIssuer = options.keyRingPath ? new WorkDelegationIssuer({ path: join(options.directory, "work-operator-issuer.db"), issuer: operatorIssuerName, signingKey: () => {
        const key = operatorKey(); if (!key) throw new WorkflowError("OperatorAdmissionUnavailable", "Operator work admission is not configured with an active dedicated key.", 503);
        return key;
      } }) : undefined;
      const start = admission && operatorIssuer ? async (input: Pick<WorkSubmission, "version" | "request_id" | "idempotency_key" | "definition" | "inputs" | "recovery_epoch">) => {
        if (!operatorKey()) throw new WorkflowError("OperatorAdmissionUnavailable", "Operator work admission is not configured with an active dedicated key.", 503);
        const origin = { entry_point: "work-api", trigger: "manual" as const };
        const authority: WorkAuthority = { namespace: { installation: options.installation, principal_kind: "operator", principal_id: "local-operator", identity_id: null, caller_session_id: null },
          origin, run_identity: null, caller_ceiling: await options.refresh({ bags: input.definition.kind === "action" ? options.scriptTraits ?? [] : [], traits: input.definition.kind === "action" ? options.scriptTraits ?? [] : [], profile: "portable" }, "local-operator") };
        const prepared = operatorIssuer.prepare({ ...input, origin }, authority, { kind: "operator", definition_owner_session: null, background_parent: false });
        return admission.submitWithReceipt(prepared.request, operatorIssuer.issue(prepared.request, authority));
      } : undefined;
      const catalog = () => ({ enabled: Boolean(start && operatorKey()) && owner.recoveryAdmission?.active !== false, definitions: [...[...agents.values()].map(agent => ({ kind: "action", reference: agent.profile.reference, catalog_namespace: agent.profile.reference.split(":")[0], title: agent.profile.title, description: "Run one retained tool-free agent turn. Inference reservations do not cap provider billing.", input_schema: agent.profile.input_schema ?? { type: "object", additionalProperties: false } })), { kind: "workflow", reference: "echo", version: "1", title: "Echo", description: "Return a message using an isolated process, after an optional delay.",
        input_schema: { type: "object", properties: { message: {}, delayMs: { type: "integer", minimum: 0, maximum: 60000 } }, required: ["message"], additionalProperties: false } }, ...[...jobs.values()].map(job => ({ kind: "job", reference: job.type, title: job.type, description: "Run the registered bounded node job.", input_schema: job.contract.inputSchema ?? {} })),
        ...[...scripts.values()].map(script => ({ kind: "action", reference: script.action.qualifiedName, catalog_namespace: script.action.bag, title: script.action.name, description: script.action.description, input_schema: script.action.inputSchema ?? { type: "object", additionalProperties: false } }))] });
      const worker = createProcessWorkWorker({ installation: options.installation, journalPath: join(options.directory, "work-executor.db"), artifactRoot: artifacts.root,
        connections: [{ owner: options.installation, client: connectWorkOwnerV3(options.installation, request => options.policy.dispatch(owner, workerId, request)) }],
        advertisement: { types: ["echo@1", ...jobs.keys(), ...Object.keys(scriptActivities)], artifacts: { "echo@1": source.digest, ...Object.fromEntries([...jobs.values()].map(job => [job.type, job.contract.digest])), ...scriptActivities }, labels: options.labels },
        maxArtifactBytes: options.maxArtifactBytes, resolveProcessSecrets: options.resolveProcessSecrets, capacity: options.capacity, onError: options.onError });
      if (hosts.mode === "external") worker.worker.stopClaims();
      return { admission, start, catalog, worker,
        dispatch: (worker: string, request: unknown) => {
          if ((external.has(worker) || agentWorkers.has(worker)) && !z.object({ version: z.literal(3) }).safeParse(request).success)
            throw new WorkflowError("WorkExecutorUnsupported", "Configured common hosts require the v3 common-work protocol.", 409);
          return options.policy.dispatch(owner, worker, request);
        }, close: () => { operatorIssuer?.close(); for (const endpointBroker of endpointBrokers.values()) endpointBroker.close(); broker.close(); artifacts.close(); } };
    },
  };
}
