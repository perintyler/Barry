#!/usr/bin/env node
import { startBagBuildMaintenance } from "@barry-rocks/sdk/internal/bags";
import { createLogger, setupGracefulShutdown } from "@barry-rocks/sdk/logging";
import { validateEnv, LOOPBACK, assignedPort, listenOnAssignedPort, barryAdaptersPath, barryRunDir, bagDataDir } from "@barry-rocks/sdk/services";
import { join } from "node:path";

import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";

import { createServer } from "http";
import { hostname } from "os";
import { sessionsApi } from "./app.js";

import { dispatchBarryHooks, setEventHookDispatcher, setEventPublisher } from "@barry-rocks/events-bag";
import { corsOrigins } from "@barry-rocks/sdk/services/http";
// Same seam, generalized beyond events: any topic, any process. The events bag
// keeps its own because its announce path is already a published contract.
import { setInProcessPublisher as setBusPublisher } from "@barry-rocks/sdk/events";
import { publishToTopic } from "./bus-registry.js";
import { startSchedulerWatchdog } from "./scheduler-watchdog.js";
import { sessionRuntime } from "./session-runtime.js";
import { transcriptReadersOf, setInstalledTranscriptReaders } from "./transcript-readers.js";
import { startTranscriptSweeper } from "./transcript-sweeper.js";
import { createWebSocketServer } from "./websocket.js";
// Composition root: this entry point is where the shipped harnesses and
// vendors are named. Everything under it — session-runtime, the actions
// route, the bags it hosts — reads the seams set here.
import { actions } from "@barry-rocks/actions-bag";
import { events } from "@barry-rocks/events-bag";
import { identities, bags } from "@barry-rocks/identities-bag";
import { schedules } from "@barry-rocks/schedules-bag";
import { Barry } from "@barry-rocks/sdk";
import { findInstalled, type SessionMode, type StartEngine } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { createModels, installModels, installedModels, assembleVendors, mergeVendorFactories } from "@barry-rocks/sdk/adapters/models";


import { LiveContinuation, executionHash, runStructured, structuredOutputFor, type SessionConfig } from "@barry-rocks/sdk/sessions";
import type { TranscriptSource } from "@barry-rocks/sdk/transcripts";
import { sessions } from "@barry-rocks/sessions-bag";
import { hostDelivery } from "@barry-rocks/sessions-bag/client";
import { ownedEngines } from "@barry-rocks/sessions-bag/engines";
import { tracker } from "@barry-rocks/tracker-bag";
import { openHosted, setAgentRuntime, withRoutedEndpoint } from "./agent-runtime.js";
import { startCleanupRecovery } from "./cleanup-recovery.js";
import { createDelivery } from "./delivery.js";
import { closeAgUiStreams } from "./routes/ag-ui.js";
import { selectedVendorFactories, shippedVendorRows } from "./shipped-vendors.js";
import { closeTurnExecutions, maintainTurnExecutions, turnExecutionService } from "./turn-execution.js";
import { InstalledWorkflowSessions, installWorkflowSessions } from "./workflow-installed-sessions.js";
import { publishWorkflowAgentProfiles } from "./workflow-agent-profiles.js";
import { createWorkflowWorkWorker } from "./workflow-work-worker.js";
import { registerInstalledWorkflowRuntimes } from "./workflow-runtime-installation.js";

// The subjects a session's grants are composed from, answered in-process.
Barry.use(identities, bags, sessions, actions, events, schedules, tracker);

// This process holds the delivery state (listeners, wake budget, prompt
// waits): its own code asks it in-process, every other process over HTTP.
const delivery = createDelivery();
hostDelivery(delivery);

// Load only the session adapters selected for this installation.
const adapters = loadAdapters({ file: barryAdaptersPath() });

// Every model this process and the bags it hosts reach — summaries, scoring,
// the model picker, bookkeeping — resolves through this one install. What it
// installs is named here because naming it is this root's job: the shipped
// catalog plus installed adapters' vendor code, loaded from their records.
const installedVendorCode = await adapters.loadVendorCode();
const selectedVendors = await selectedVendorFactories();
installModels(
  createModels(
    assembleVendors([...(await shippedVendorRows()), ...adapters.installed().filter((r) => !r.bag).flatMap((r) => r.vendorCode?.vendors ?? [])], mergeVendorFactories(selectedVendors.factories, installedVendorCode.factories)),
  ),
);

// A hosted session's engine lives as long as the session does, and every
// session here lives in this process: they go when it does. Its socket sits
// in the instance's runtime directory, short enough for the OS's socket limit.
const engines = ownedEngines({ baseDir: barryRunDir() });
process.once("exit", () => engines.stopAll());
const startHarnessEngine: StartEngine = (spec) => engines.start(spec);

async function hostedMode(harness: string): Promise<SessionMode> {
  const hosted = (await adapters.load(harness)).modes.hosted;
  if (!hosted) throw new Error(`${harness} has no hosted mode, so it cannot run an API session`);
  return hosted;
}

/** A session config with its routed model's endpoint, as the installed record routes it. */
function routed(harness: string, config: SessionConfig): SessionConfig {
  return withRoutedEndpoint(findInstalled(adapters.installed(), harness), config, installedModels().vendors());
}

setAgentRuntime({
  openContinuation: async (provider, config) => {
    const hosted = await hostedMode(provider);
    if (hosted.openContinuation) return hosted.openContinuation(routed(provider, config), startHarnessEngine);
    if (hosted.approvalContinuation !== "live") throw new Error(`${provider} does not support approval continuation`);
    const fingerprint = executionHash({ sessionId: config.sessionId, cwd: config.cwd, model: config.model ?? null, systemPrompt: config.systemPrompt ?? null, deniedTools: config.deniedTools ?? [] });
    return LiveContinuation.open(provider, fingerprint, routed(provider, config), (input) => hosted.start(input, startHarnessEngine));
  },
  createSession: async (harness, config, options) =>
    openHosted(await hostedMode(harness), routed(harness, config), startHarnessEngine, options),
  runStructured: async ({ harness, prompt, schema, config, signal }) => {
    const hosted = await hostedMode(harness);
    const harnessVendor = findInstalled(adapters.installed(), harness)?.vendor;
    return runStructured({
      prompt,
      schema,
      structuredOutput: structuredOutputFor(hosted, { harnessVendor, model: config.model, models: installedModels() }),
      ...(signal ? { signal } : {}),
      // One structured answer, never resumed: nothing of it need outlive the run.
      start: () => hosted.start({ ...routed(harness, config), ephemeral: true }, startHarnessEngine),
    });
  },
  describeAdapter: (harness) => findInstalled(adapters.installed(), harness),
});

import { startTtlCleanup, stopTtlCleanup } from "./ttl-cleanup.js";

const log = createLogger("barry-server");
for (const [id, problems] of installedVendorCode.refused) log.error("models.vendor-code-refused", { adapter: id, problems });
for (const [packageName, problems] of selectedVendors.refused) log.error("models.provider-refused", { packageName, problems });
// The service toolkit declares the logger shape and takes the factory as an
// injection, so it depends on no logging implementation. This is the
// composition root, so naming one here is its job.


const envCheck = validateEnv({ service: "api" });
if (!envCheck.ok) {
  for (const m of envCheck.missing) log.error("env.required", { var: m.name, description: m.description });
  process.exit(1);
}
if (!process.env.BARRY_SECRET) {
  log.error("env.required", { var: "BARRY_SECRET", description: "Authenticates API and WebSocket clients" });
  process.exit(1);
}

// Trusted opt-in installation preparation. It publishes verified generations
// only; existing interactive/action producers keep their current owners.
if ((process.env.BARRY_WORKFLOW_AGENT_PROFILES || process.env.BARRY_WORKFLOW_SESSIONS_WORKER) && !process.env.BARRY_WORKFLOW_RUNTIME_REGISTRATION) throw new Error("WorkSessionsRuntimeRegistrationRequired");
const workflowRuntimeInstallation = process.env.BARRY_WORKFLOW_RUNTIME_REGISTRATION
  ? await registerInstalledWorkflowRuntimes({ configuration: process.env.BARRY_WORKFLOW_RUNTIME_REGISTRATION,
    directory: join(bagDataDir("sessions"), "workflow-runtimes"), adapters }) : undefined;
let workflowSessions: InstalledWorkflowSessions | undefined;
let workflowWorkWorker: Awaited<ReturnType<typeof createWorkflowWorkWorker>> | undefined;
let workflowWorkTick: ReturnType<typeof setInterval> | undefined;
try {
  if (workflowRuntimeInstallation) {
    workflowSessions = new InstalledWorkflowSessions({ installation: workflowRuntimeInstallation,
      directory: join(bagDataDir("sessions"), "workflow-authorities") });
    installWorkflowSessions(workflowSessions);
    if (process.env.BARRY_WORKFLOW_AGENT_PROFILES) await publishWorkflowAgentProfiles(process.env.BARRY_WORKFLOW_AGENT_PROFILES, workflowRuntimeInstallation);
    if (process.env.BARRY_WORKFLOW_SESSIONS_WORKER) {
      workflowWorkWorker = await createWorkflowWorkWorker(process.env.BARRY_WORKFLOW_SESSIONS_WORKER, workflowRuntimeInstallation,
        error => log.error("sessions.work_worker_failed", { error: error instanceof Error && /^Work[A-Za-z]+$/.test(error.message) ? error.message : error instanceof Error ? error.name : "WorkWorkerFailure" }));
      workflowWorkTick = setInterval(() => { void workflowWorkWorker!.worker.tick().catch(error => log.error("sessions.work_worker_tick_failed", { error: error instanceof Error && /^Work[A-Za-z]+$/.test(error.message) ? error.message : error instanceof Error ? error.name : "WorkWorkerFailure" })); }, 100);
      workflowWorkTick.unref();
    }
  }
} catch (error) {
  try { workflowRuntimeInstallation?.close(); }
  catch (cleanup) { throw new AggregateError([error, cleanup], "WorkflowSessionsInstallationFailed"); }
  throw error;
}
for (const row of workflowRuntimeInstallation?.registrations ?? []) log.info("sessions.workflow_runtime_registered", { harness: row.harness, generation: row.generation, digest: row.runtime.digest });

/**
 * Hand the events bag its way onto the bus.
 *
 * The payload is a signal, not the event: clients refetch through `GET /events`
 * so their own filters and paging apply, and the envelope matches the
 * `identities` topic so every bus message has one shape.
 *
 * Both halves are wired here. `setEventPublisher` serves the cross-process
 * producers that POST /announce; `setInProcessPublisher` short-circuits the
 * API's own writes, which would otherwise HTTP themselves over loopback.
 */
function announceEventOnBus(eventId: string): number {
  return publishToTopic("events", {
    type: "bus",
    topic: "events",
    id: eventId,
    kind: "created",
  });
}
setEventPublisher(announceEventOnBus);

/**
 * Let other bags run code when an event is created.
 *
 * Registered HERE rather than inside the events bag because running a hook
 * means scanning the bag registry and spawning a process, and most event
 * writers must not pay that: `barry events emit` and `barry notify` are
 * one-shot CLI processes, and the launchd jobs shell out to them. This service
 * is long-lived and already the in-process publisher, so it is the one place
 * where that cost is amortized rather than paid per invocation.
 *
 * The consequence is deliberate and worth knowing: a hook fires for events
 * created HERE, not for every row that reaches events.db. Widening that means
 * crossing the process boundary the way announce does, and that is a decision
 * about who should be running another bag's code, not an oversight.
 */
setEventHookDispatcher(dispatchBarryHooks);

/**
 * The same two halves, generalized to every other topic.
 *
 * This service owns the sockets, so it registers the in-process publisher and
 * `announce()` short-circuits for its own writes. A producer in ANOTHER process
 * — which is what the identity routes become once this API splits — falls
 * through to POSTing the endpoint below.
 *
 * Registering only this half is the trap: it passes every in-process test and
 * is silent for any producer that does not happen to run here.
 */
setBusPublisher((topic, id, kind) => publishToTopic(topic, { type: "bus", topic, id, kind }));

const { app } = sessionsApi(delivery);

// Assigned by the supervisor; refusing to start without it beats guessing one.
const port = assignedPort();

const httpServer = createServer(app);
createWebSocketServer(httpServer);
sessionRuntime.setExecutionGuard((id) => withStoreContext({ identity: sessionIdentity(id) }, () => !!turnExecutionService().store.active(id)));

sessionRuntime.reconcileStaleSessions().catch((err) => {
  log.error("reconcile.error", { error: err instanceof Error ? err.message : String(err) });
});

// Boot reconciliation only covers the restart itself. This closes sessions
// whose process dies while the server keeps running, which would otherwise
// claim to be live until the next restart.
sessionRuntime.startCrashedSessionSweep();
sessionRuntime.startWarmSweep();
turnExecutionService().maintain();
const turnMaintenance = setInterval(() => {
  try { maintainTurnExecutions(); }
  catch (error) { log.error("turn.maintenance_failed", { error: String(error) }); }
}, 1000);
turnMaintenance.unref();

// Deliver to sessions resting here without waiting for a human to poke them.
// Every session this API hosts is reachable from this process, so this is the
// surface that makes a cross-session message arrive in seconds.
sessionRuntime.startInboxRelay();


startTtlCleanup();

// Alert when the schedules service stops writing its heartbeat — nothing it
// runs can report its death, so the observer lives here.
startSchedulerWatchdog();

// Read what the vendors write. `sweepTranscripts` existed and was called by
// nothing, so the `transcript` capture channel recorded no rows at all — and
// a sweep that never runs reports the same zero counters as one with nothing
// to read.
//
// Composed here because this is the composition root: the readers are the
// installed adapters' own transcript sources, the sessions and the store come
// from this bag.
let readersOnce: Promise<Record<string, TranscriptSource>> | null = null;

function transcriptReaders(): Promise<Record<string, TranscriptSource>> {
  readersOnce ??= transcriptReadersOf(adapters, (adapter, err) =>
    log.error("sessions.transcript_reader_unavailable", { adapter, error: err instanceof Error ? err.message : String(err) }),
  );
  return readersOnce;
}

setInstalledTranscriptReaders(transcriptReaders);

startTranscriptSweeper({
  sweep: async () => {
    const [
      { sweepTranscripts },
      readers,
      { getActiveSessions },
      { persistTranscriptEntry },
      { getProviderSessionsBySession },
      { toSweepSession },
    ] = await Promise.all([
      import("@barry-rocks/sessions-bag/capture"),
      transcriptReaders(),
      import("./db.js"),
      import("./transcript-persist.js"),
      import("@barry-rocks/sessions-bag/client"),
      import("./sweep-sessions.js"),
    ]);

    return sweepTranscripts({
      listSessions: async () =>
        Promise.all(
          (await getActiveSessions()).filter(session => !sessionRuntime.getActiveSession(session.id)).map((session) =>
            toSweepSession(session, getProviderSessionsBySession),
          ),
        ),
      resolveReader: (provider) => readers[provider],
      persist: persistTranscriptEntry,
      report: (line) => log.warn("sessions.transcript_sweep_problem", { detail: line }),
      summarize: (line) => log.debug("sessions.transcript_sweep_summary", { detail: line }),
    });
  },
  report: (line) => log.error("sessions.transcript_sweep_failed", { detail: line }),
});

let cleanupRecovery: { stop(): void } | undefined;
listenOnAssignedPort(httpServer).then(
  () => {
    cleanupRecovery = startCleanupRecovery((detail) => log.warn("sessions.process_cleanup_recovery", { detail }));
    httpServer.once("close", startBagBuildMaintenance());
    log.info("server.start", {
      port,
      host: LOOPBACK,
      machine: hostname(),
      corsOrigins: corsOrigins().length > 0 ? corsOrigins() : "localhost only",
    });
  },
  (err: Error) => {
    log.error("server.listen_failed", { port, error: err.message });
    process.exit(1);
  },
);

let draining: Promise<void> | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    clearInterval(turnMaintenance);
    stopTtlCleanup();
    cleanupRecovery?.stop();
    sessionRuntime.stopCrashedSessionSweep();
    sessionRuntime.stopWarmSweep();
    closeAgUiStreams();
    draining ??= closeTurnExecutions().then(async () => {
      if (!await sessionRuntime.drainPersistence()) log.error("session.persistence_shutdown_timeout", {});
    }).finally(() => engines.stopAll());
  });
}
setupGracefulShutdown(httpServer, log, { forceExitTimeout: 35000, onShutdown: async () => {
  const failures: unknown[] = [];
  clearInterval(workflowWorkTick); workflowWorkWorker?.worker.stopClaims();
  try { await workflowWorkWorker?.close(); } catch (error) { failures.push(error); }
  try { await draining; } catch (error) { failures.push(error); }
  try { await sessionRuntime.stopInboxRelay(); } catch (error) { failures.push(error); }
  try {
    await Promise.all(sessionRuntime.getActiveSessionIds().map(async id => {
      const active = sessionRuntime.getActiveSession(id);
      if (active && (active.warm || active.warming) && active.lastSequence < 0 && !active.pendingTurns) await sessionRuntime.dropResident(id, { force: true });
    }));
  } catch (error) { failures.push(error); }
  try { await workflowSessions?.close(); } catch (error) { failures.push(error); }
  try { workflowRuntimeInstallation?.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "SessionsShutdownFailed");
} });
