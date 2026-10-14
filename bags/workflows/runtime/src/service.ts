import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { platform, arch } from "node:os";
import { z } from "zod";
import { Barry } from "@barry-rocks/sdk";
import { identities } from "@barry-rocks/identities-bag";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { listenOnAssignedPort, bagDataDir } from "@barry-rocks/sdk/services";
import { createLogger } from "@barry-rocks/sdk/logging";

import { migratedStorePath } from "@barry-rocks/sdk/stores";
import { ActivityWorker, WorkflowOwner, ProcessExecutor, StorageHealth, ClockDiagnostics, WorkflowMaintenance, inspectArtifact, readBoundedFile, connectOwnerV2, dispatchWorkerRequest, ownerCall, jobActivity, unmetRequirement, workerLabels, type Activity } from "@barry-rocks/sdk/internal/workflows";
import { installationJobs } from "./jobs.js";
import { createWorkflowServer, builtinArtifact, jobArtifact } from "@barry-rocks/workflows-bag";
import { instanceRunAuthorization, instanceRunScopeRefresh } from "./run-authorization.js";

const log = createLogger("workflows.runtime", { transport: "stderr" });
const errorFields = (error: unknown) => ({
  error: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
});

async function main(): Promise<void> {
  // A run's identity bound is composed by the identities subject, answered in-process.
  Barry.use(identities);
  const workerOnly = process.env.BARRY_WORKFLOW_WORKER_ONLY === "1";
  const secret = process.env.BARRY_SECRET;
  if (!secret) throw new Error("BARRY_SECRET is required");
  const profile = z.enum(["portable", "hardened"]).parse(process.env.BARRY_WORKFLOW_PROFILE ?? "portable");
  const evaluator = new ProcessExecutor({ maxChildren: 2, profile });
  const activityExecutor = new ProcessExecutor({ maxChildren: 100, heapMiB: 256, profile });
  const builtin = builtinArtifact;
  const artifacts = [inspectArtifact(builtin, "echo", "1"), inspectArtifact(jobArtifact, "job", "1")];
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
  const owner = new WorkflowOwner({ id: peers.id, path: database, now: ownerNow, artifacts, activityArtifacts, jobs: jobs.jobs.map(job => job.contract), permitsWorkerJob: (worker, type) => worker === peers.id || peers.permitsJob(worker, type), onWorkerSession: (worker, takeover) => { if (worker !== peers.id) peers.recordHello(worker, takeover); }, executor: evaluator, resolveNode: reference => peers.workers().find(worker => worker.name === reference)?.id ?? reference, authorize: run => { const principal = run.authorizer ?? run.principal, policy = principal === "local-operator" ? undefined : grants()[principal]; return principal === "local-operator" || (policy?.types.includes(run.type) === true && policy.operations.includes("start")); } });
  const maintenance = process.env.BARRY_WORKFLOW_ARCHIVE_DIR ? new WorkflowMaintenance({ owner, database, archiveDirectory: process.env.BARRY_WORKFLOW_ARCHIVE_DIR, artifacts: archiveArtifacts }) : undefined;
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
  const runAuthorization = instanceRunAuthorization(peers);
  const ready = () => !stopping && owner.storageAccounted && performance.now() - lastTick < 30_000;
  const server = workerOnly ? createServer((request, response) => {
    const live = request.url === "/live";
    const health = request.url === "/ready" || request.url === "/health";
    if (!live && !health) { response.writeHead(404); response.end(); return; }
    const ok = live || (ready() && storageHealth.ready);
    response.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok, workerOnly: true }));
  }) : createWorkflowServer({ owner, secret, authenticateWorker: credential => peers.authenticate(credential), runAuthorization, currentRunScope: instanceRunScopeRefresh(peers), storageHealth, clockDiagnostics: () => clockDiagnostics.status(), maintenance: () => maintenance?.status() ?? { enabled: false }, readActorKey: async () => (await installationSecrets(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] })).BARRY_WORKFLOW_ACTOR_KEY, grants, healthy: ready, draining: () => stopping });
  await owner.pump(); lastTick = performance.now();
  await listenOnAssignedPort(server);
  const timer = setInterval(() => {
    if (stopping) return;
    clockDiagnostics.sample();
    storageHealth.probe(() => owner.probeStorage());
    if (!storageHealth.ready) return;
    try { maintenance?.tick(); } catch (error) { storageHealth.observe(error); log.error("workflows.maintenance_failed", errorFields(error)); }
    void Promise.resolve().then(() => owner.pump()).then(() => { lastTick = performance.now(); }).catch(error => { storageHealth.observe(error); log.error("workflows.owner_failed", errorFields(error)); });
    void worker.tick().catch(error => log.error("workflows.worker_failed", errorFields(error)));
  }, 250);
  const stop = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    const hardStop = setTimeout(() => process.exit(1), drainMs + 5000); hardStop.unref();
    const drained = await worker.drain(drainMs);
    await maintenance?.close();
    await activityExecutor.close(); await owner.drain();
    if (!drained) { log.error("workflows.incomplete_drain", { recovery: "leases on restart" }); process.exit(1); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    owner.close(); peers.close(); clearTimeout(hardStop);
  };
  process.once("SIGTERM", () => { void stop().catch(() => process.exit(1)); }); process.once("SIGINT", () => { void stop().catch(() => process.exit(1)); });
  process.stdout.write("workflows: runs console and runtime ready\n");
}
void main().catch(error => { log.error("workflows.start_failed", errorFields(error)); process.exitCode = 1; });
