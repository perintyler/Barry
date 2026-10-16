import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { platform, arch } from "node:os";
import { z } from "zod";
import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords } from "@barry-rocks/identities-bag";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { identityEnvironmentForId, setIdentityStore } from "@barry-rocks/sdk/internal/env";
import { listenOnAssignedPort, bagDataDir } from "@barry-rocks/sdk/services";
import { createLogger } from "@barry-rocks/sdk/logging";

import { migratedStorePath } from "@barry-rocks/sdk/stores";
import { ActivityWorker, WorkControlService, WorkReadService, WorkflowError, WorkflowOwner, ProcessExecutor, StorageHealth, ClockDiagnostics, WorkflowMaintenance, inspectArtifact, readBoundedFile, connectOwnerV2, dispatchWorkerRequest, ownerCall, jobActivity, unmetRequirement, workerLabels, type Activity } from "@barry-rocks/sdk/internal/workflows";
import { WorkArtifactStore, installationScripts, retainedScriptActivities, retainedScriptArchive, retainedWorkAgents, retainedWorkAgentCatalogs, type WorkProcessProgram } from "@barry-rocks/sdk/internal/workflows";
import { agentArchive, commonAgentScope, commonAgentType, installedCommonAgents } from "./common-agents.js";
import { localCommonWork, readCommonHosts } from "./common-work.js";
import { actionProjectionPublication } from "./action-projections.js";
import { installationJobs } from "./jobs.js";
import { createWorkflowServer, builtinArtifact, jobArtifact, processArtifact, agentArtifact } from "@barry-rocks/workflows-bag";
import { instanceRunAuthorization, instanceRunScopeRefresh, instanceWorkPolicy, currentJobBound } from "./run-authorization.js";

const log = createLogger("workflows.runtime", { transport: "stderr" });
const errorFields = (error: unknown) => ({
  error: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
});

async function main(): Promise<void> {
  // A run's identity bound is composed by the identities subject, answered in-process.
  Barry.use(identities);
  setIdentityStore({ get: identityRecords.row, resolveConfig: identityRecords.config, touchLastUsed: identityRecords.touch });
  const workerOnly = process.env.BARRY_WORKFLOW_WORKER_ONLY === "1";
  const secret = process.env.BARRY_SECRET;
  if (!secret) throw new Error("BARRY_SECRET is required");
  const profile = z.enum(["portable", "hardened"]).parse(process.env.BARRY_WORKFLOW_PROFILE ?? "portable");
  const evaluator = new ProcessExecutor({ maxChildren: 2, profile });
  const activityExecutor = new ProcessExecutor({ maxChildren: 100, heapMiB: 256, profile });
  const builtin = builtinArtifact;
  const artifacts = [inspectArtifact(builtin, "echo", "1"), inspectArtifact(jobArtifact, "job", "1"), inspectArtifact(processArtifact, "action-script", "2"), inspectArtifact(agentArtifact, "action-agent", "1")];
  const activityArtifacts: Record<string, string> = { "echo@1": inspectArtifact(builtin, "echo@1", "1", false).digest };
  const archiveArtifacts = [...artifacts, inspectArtifact(builtin, "echo@1", "1", false)];
  const activities: Record<string, Activity> = { "echo@1": activityExecutor.activity(inspectArtifact(builtin, "echo@1", "1", false)) };
  const modulePath = process.env.BARRY_WORKFLOW_MODULE;
  if (modulePath) {
    if (!isAbsolute(modulePath)) throw new Error("BARRY_WORKFLOW_MODULE must be an absolute path to trusted local code");
    const entry = z.strictObject({ path: z.string(), type: z.string(), version: z.string() });
    const manifest = z.strictObject({ workflows: z.array(entry).max(100), activities: z.array(entry).max(100) }).parse(JSON.parse(readBoundedFile(modulePath, 262_144).toString("utf8")));
    for (const item of manifest.workflows) { const artifact = inspectArtifact(item.path, item.type, item.version); artifacts.push(artifact); archiveArtifacts.push(artifact); }
    for (const item of manifest.activities) {
      if (Object.hasOwn(activities, item.type)) throw new Error("duplicate activity type");
      activities[item.type] = activityExecutor.activity(inspectArtifact(item.path, item.type, item.version, false));
      activityArtifacts[item.type] = inspectArtifact(item.path, item.type, item.version, false).digest;
      archiveArtifacts.push(inspectArtifact(item.path, item.type, item.version, false));
    }
  }
  // Installed bag jobs: the owner pins every one's contract; this machine's
  // worker advertises those whose requirements it meets.
  const labels = workerLabels(process.env.BARRY_WORKFLOW_LABELS, { os: platform(), arch: arch() });
  const jobs = await installationJobs();
  const workerArtifacts = { ...activityArtifacts };
  for (const job of jobs.jobs) {
    // Backups cover every owner-pinned job, including jobs this worker cannot run.
    archiveArtifacts.push(inspectArtifact(job.main, job.type, job.type.slice(job.type.lastIndexOf("@") + 1), false));
    const unmet = unmetRequirement(job, labels);
    if (unmet) { log.error("workflows.job_requirements_unmet", { jobType: job.type, reason: unmet }); continue; }
    if (Object.hasOwn(activities, job.type)) throw new Error(`duplicate activity type ${job.type}`);
    activities[job.type] = jobActivity(job);
    workerArtifacts[job.type] = job.contract.digest;
  }
  for (const skipped of jobs.skipped) log.error("workflows.job_not_available", { jobType: skipped.type, reason: skipped.reason });
  // Disposable fault tests can advance owner time without waiting for lease expiry.
  const testClockPath = process.env.NODE_ENV === "test" ? process.env.BARRY_WORKFLOW_TEST_CLOCK : undefined;
  const ownerNow = testClockPath ? () => z.number().int().nonnegative().parse(Number(readFileSync(testClockPath, "utf8"))) : Date.now;
  const peers = new NodeRegistry(undefined, ownerNow);
  // Owners this machine joined with `barry workers join`; read once, so a join takes effect on restart.
  const remoteOwners = peers.owners();
  const capacity = z.coerce.number().int().min(1).max(100).parse(process.env.BARRY_WORKFLOW_CAPACITY ?? "4");
  const drainMs = z.coerce.number().int().min(100).max(30_000).parse(process.env.BARRY_WORKFLOW_DRAIN_MS ?? "30000");
  const database = migratedStorePath("workflows", "workflows", () => join(bagDataDir("workflows"), "workflows.db"), "workflows", "node");
  if (database !== ":memory:") mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const maxArtifactBytes = z.coerce.number().int().min(1).max(536870912).parse(process.env.BARRY_WORKFLOW_ARTIFACT_BYTES ?? "33554432");
  const scriptArtifacts = new WorkArtifactStore(join(bagDataDir("workflows"), "work-artifacts"), maxArtifactBytes);
  const scripts = process.env.BARRY_WORKFLOW_SCRIPT_RESOURCES ? await installationScripts(process.env.BARRY_WORKFLOW_SCRIPT_RESOURCES, scriptArtifacts, peers.id) : [];
  const retainedAgents = retainedWorkAgents(database, scriptArtifacts);
  const retainedAgentCatalogs = retainedWorkAgentCatalogs(database, scriptArtifacts);
  const agents = process.env.BARRY_WORKFLOW_AGENT_CATALOG ? installedCommonAgents(process.env.BARRY_WORKFLOW_AGENT_CATALOG, scriptArtifacts, peers.id) : undefined;
  if (agents) {
    peers.worker(agents.catalog.worker_id);
    if (agents.agents.some(agent => !peers.permitsJob(agents.catalog.worker_id, commonAgentScope(agent.profile.reference)))) throw new WorkflowError("WorkAgentWorkerUnavailable", "The installed Sessions worker lacks an invited agent activity scope.", 503);

  }
  const allAgents = [...new Map([...retainedAgents, ...(agents?.agents ?? [])].map(agent => [commonAgentType(agent), agent])).values()];
  archiveArtifacts.push(...agentArchive(allAgents, scriptArtifacts, artifacts[0]!.abi));
  Object.assign(activityArtifacts, Object.fromEntries(allAgents.map(agent => [commonAgentType(agent), agent.source.digest])));
  const retainedScripts = retainedScriptActivities(database, scriptArtifacts);
  archiveArtifacts.push(...new Map([...retainedScriptArchive(database, scriptArtifacts), ...scripts.map(script => ({ type: script.type, version: "activity", digest: script.source.digest, path: scriptArtifacts.path(script.source), abi: artifacts[0]!.abi, kind: "program" as const, bytes: script.source.bytes }))].map(artifact => [artifact.type, artifact])).values());
  scriptArtifacts.close();
  Object.assign(activityArtifacts, retainedScripts, Object.fromEntries(scripts.map(script => [script.type, script.source.digest])));
  const workPolicy = instanceWorkPolicy(peers, jobs.jobs);
  const scriptSecrets = async (program: WorkProcessProgram) => {
    const names = program.secret_names, owner = program.credential_owner;
    if (owner.kind === "installation" && owner.installation === peers.id) return installationSecrets(names);
    if (owner.kind === "identity" && owner.identity === program.scope.identity) {
      const { vars } = await identityEnvironmentForId(peers.legacyIdentityId(owner.identity), { names });
      return Object.fromEntries(names.filter(name => vars[name] !== undefined).map(name => [name, vars[name]!]));
    }
    throw new Error("Selected credential owner is unavailable.");
  };
  const commonHosts = readCommonHosts(process.env.BARRY_WORKFLOW_COMMON_HOSTS);
  for (const worker of commonHosts.worker_ids) {
    peers.worker(worker);
    if (!["workflows:echo@1", ...jobs.jobs.map(job => job.type), ...Object.keys(retainedScripts), ...scripts.map(script => script.type)].some(type => peers.permitsJob(worker, type))) throw new WorkflowError("WorkHostConfigurationInvalid", "Configured common host lacks a registered common activity scope.", 503);
  }
  const common = localCommonWork({ installation: peers.id, directory: bagDataDir("workflows"), builtin, jobWorkflow: jobArtifact, jobs: jobs.jobs, jobBound: currentJobBound, capacity, labels,
    agents, retainedAgents, retainedAgentCatalogs, agentWorkflow: agentArtifact, scriptWorkflow: processArtifact, scripts, retainedScripts, maxArtifactBytes,
    scriptTraits: process.env.BARRY_WORKFLOW_SCRIPT_TRAITS ? z.array(z.string().min(1).max(200)).max(100).parse(JSON.parse(process.env.BARRY_WORKFLOW_SCRIPT_TRAITS)) : [],
    resolveProcessSecrets: async start => { if (!start.process_program) throw new Error("Missing retained credential owner."); return scriptSecrets(start.process_program); },
    checkProcessSecrets: async program => { const values = await scriptSecrets(program); if (program.secret_names.some(name => !values[name])) throw new Error("Selected script secret is unavailable."); },
    hosts: commonHosts, permitsHost: (worker, type) => peers.permitsJob(worker, allAgents.find(agent => commonAgentType(agent) === type) ? commonAgentScope(allAgents.find(agent => commonAgentType(agent) === type)!.profile.reference) : type === "echo@1" ? "workflows:echo@1" : type),
    keyRingPath: process.env.BARRY_WORKFLOW_DELEGATION_KEYS, refresh: instanceRunScopeRefresh(peers), policy: workPolicy,
    onError: error => log.error("workflows.common_worker_failed", errorFields(error)) });
  const owner = new WorkflowOwner({ id: peers.id, path: database, now: ownerNow, workArtifacts: common.artifacts, workResources: common.resources, artifacts, activityArtifacts, jobs: jobs.jobs.map(job => job.contract), permitsWorkerJob: (worker, type) => common.externalHost(worker) ? common.permits(worker, type) : worker === peers.id || common.permits(worker, type) || peers.permitsJob(worker, type), onWorkerSession: (worker, takeover) => { if (worker !== peers.id && worker !== common.workerId) peers.recordHello(worker, takeover); }, executor: evaluator, workerNode: worker => worker === common.workerId || common.externalHost(worker) ? peers.id : worker, resolveNode: reference => peers.workers().find(worker => worker.name === reference)?.id ?? reference, authorizeWork: (work, worker, activity) => common.permits(worker, activity) ? workPolicy.current(work, worker, activity) : null, authorize: run => { const principal = run.authorizer ?? run.principal, policy = principal === "local-operator" ? undefined : grants()[principal]; return principal === "local-operator" || (policy?.types.includes(run.type) === true && policy.operations.includes("start")); } });
  const commonService = common.attach(owner);
  const actionProjections = actionProjectionPublication({ owner, path: process.env.BARRY_WORKFLOW_ACTION_PROJECTIONS, onError: error => log.error("workflows.action_projection_failed", errorFields(error)) });
  const maintenance = process.env.BARRY_WORKFLOW_ARCHIVE_DIR ? new WorkflowMaintenance({ owner, database, archiveDirectory: process.env.BARRY_WORKFLOW_ARCHIVE_DIR, artifacts: archiveArtifacts, workArtifactRoot: common.artifacts.root }) : undefined;
  const connections = [
    ...(workerOnly ? [] : [connectOwnerV2(peers.id, async request => dispatchWorkerRequest(owner, peers.id, request))]),
    ...remoteOwners.map(remote => connectOwnerV2(remote.id, ownerCall(remote.url, peers.ownerCredential(remote.id)))),
  ];
  const clockOffset = process.env.NODE_ENV === "test" ? z.coerce.number().int().parse(process.env.BARRY_WORKFLOW_CLOCK_OFFSET_MS ?? "0") : 0;
  const worker = new ActivityWorker({ now: () => performance.now() + clockOffset, connections, activities, artifacts: workerArtifacts, capacity, labels, onError: error => log.error("workflows.worker_failed", errorFields(error)) });
  let lastTick = 0, stopping = false;
  const storageHealth = new StorageHealth();
  const clockDiagnostics = new ClockDiagnostics(); clockDiagnostics.sample();
  const grants = () => {
    const path = process.env.BARRY_WORKFLOW_POLICY;
    if (!path) return {};
    const contents = readBoundedFile(path, 65_536).toString("utf8");
    return z.record(z.string(), z.strictObject({ types: z.array(z.string()).max(100), operations: z.array(z.enum(["start", "get", "list", "history", "signal", "cancel", "resume", "reauthorize"])), payloadRead: z.boolean().default(false) })).parse(JSON.parse(contents));
  };
  const workReadScope = (principal: string | null) => {
    if (principal === null) return { kind: "installation" as const, installation: peers.id };
    try { peers.legacyIdentityId(principal); } catch { throw new WorkflowError("WorkReadDenied", "Work identity is unavailable.", 403); }
    if (!grants()[principal]?.types.length) throw new WorkflowError("Forbidden", "Work identity is no longer granted.", 403);
    return { kind: "identity" as const, installation: peers.id, identity_id: principal };
  };
  const runAuthorization = instanceRunAuthorization(peers);
  const ready = () => !stopping && owner.storageAccounted && performance.now() - lastTick < 30_000;
  const server = workerOnly ? createServer((request, response) => {
    const live = request.url === "/live";
    const health = request.url === "/ready" || request.url === "/health";
    if (!live && !health) { response.writeHead(404); response.end(); return; }
    const ok = live || (ready() && storageHealth.ready);
    response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok, workerOnly: true }));
  }) : createWorkflowServer({ owner, secret, workArtifacts: common.artifacts, workAdmission: commonService.admission, workStart: commonService.start, workCatalog: () => ({ ...commonService.catalog(), action_projections: actionProjections?.status() ?? { enabled: false } }), workerDispatch: commonService.dispatch, workReads: new WorkReadService<string | null>({ owner, authorize: async principal => {
    const scope = workReadScope(principal), policy = principal === null ? null : grants()[principal];
    return { scope, controls: ["inspect", ...(principal === null ? ["reconcile" as const] : []), ...(principal === null || policy?.payloadRead ? ["result" as const] : []), ...(principal === null || policy?.operations.includes("cancel") ? ["stop" as const] : [])] };
  } }), workControls: new WorkControlService<string | null>({ owner, authorize: async (principal, _workId, operation) => {
    const scope = workReadScope(principal);
    if (operation === "reconcile") {
      if (principal !== null) throw new WorkflowError("Forbidden", "Reconciliation requires the local operator.", 403);
      return { scope, actor: "local-operator", controls: ["reconcile"] };
    }
    if (principal !== null && !grants()[principal]?.operations.includes("cancel")) throw new WorkflowError("Forbidden", "Work stop is not granted.", 403);
    return { scope, actor: principal ?? "local-operator", controls: ["stop"] };
  } }), authenticateWorker: credential => peers.authenticate(credential), runAuthorization, currentRunScope: instanceRunScopeRefresh(peers), storageHealth, clockDiagnostics: () => clockDiagnostics.status(), maintenance: () => maintenance?.status() ?? { enabled: false }, readActorKey: async () => (await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] })).BARRY_WORKFLOW_ACTOR_KEY, grants, healthy: ready, draining: () => stopping });
  await owner.pump(); lastTick = performance.now();
  await listenOnAssignedPort(server);
  const timer = setInterval(() => {
    if (stopping) return;
    clockDiagnostics.sample();
    storageHealth.probe(() => owner.probeStorage());
    if (!storageHealth.ready) return;
    try { maintenance?.tick(); } catch (error) { storageHealth.observe(error); log.error("workflows.maintenance_failed", errorFields(error)); }
    void Promise.resolve().then(() => owner.pump()).then(() => { lastTick = performance.now(); }).catch(error => { storageHealth.observe(error); log.error("workflows.owner_failed", errorFields(error)); });
    try { owner.reconcileWorkResources(); } catch (error) { storageHealth.observe(error); log.error("workflows.work_resources_failed", errorFields(error)); }
    void actionProjections?.tick();
    void commonService.worker.worker.tick().catch(error => log.error("workflows.common_worker_failed", errorFields(error)));
    void worker.tick().catch(error => log.error("workflows.worker_failed", errorFields(error)));
  }, 250);
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer); commonService.worker.worker.stopClaims();
    const hardStop = setTimeout(() => process.exit(1), drainMs + 5000); hardStop.unref();
    const drained = await worker.drain(drainMs);
    await maintenance?.close();
    await commonService.worker.close();
    await activityExecutor.close(); await owner.drain();
    if (!drained) { log.error("workflows.incomplete_drain", { recovery: "leases on restart" }); process.exit(1); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await actionProjections?.close();
    owner.close(); commonService.close(); peers.close(); clearTimeout(hardStop);
  };
  process.once("SIGTERM", () => { void stop().catch(() => process.exit(1)); }); process.once("SIGINT", () => { void stop().catch(() => process.exit(1)); });
  process.stdout.write("workflows: runs console and runtime ready\n");
}
void main().catch(error => { log.error("workflows.start_failed", errorFields(error)); process.exitCode = 1; });
