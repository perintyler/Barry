import { currentStoreContext, withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { classify, readProcessStartTime } from "@barry-rocks/sessions-bag/process-liveness";
import { Processes } from "@barry-rocks/sessions-bag/client";
import { TurnExecution, type PermissionRequest } from "@barry-rocks/sdk/sessions";
import { TurnContinuations, ExecutionConflict } from "@barry-rocks/sessions-bag/store/turn-continuations";
import { getSessionsSqlite, sessionsDbPath } from "@barry-rocks/sessions-bag/store/sessions-db";
import { getSessionRecord } from "./db.js";
import { openContinuation } from "./agent-runtime.js";
import { sessionRuntime, type ActiveSession } from "./session-runtime.js";
import { projectTurnHistory } from "./turn-history.js";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { sessionGrants } from "@barry-rocks/sessions-bag";
import { requestCaller } from "@barry-rocks/sdk";
import { sessionMcpServers } from "./mcp-config.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("sessions.turns", { transport: "stderr" });

import { getDescribeAdapter } from "./agent-runtime.js";
import { sessionReviewPolicy } from "./review-policy.js";

interface Service { store: TurnContinuations; execution: TurnExecution; maintain(): void; close(): Promise<void> }
const services = new Map<string, Service>();

export async function prepareTurnSession(sessionId: string, principal?: AuthPrincipal): Promise<ActiveSession> {
  if (principal) principal = await authorizeSessionExecution(principal, { sessionId });
  const active = sessionRuntime.getActiveSession(sessionId);
  if (active?.pendingTurns || active?.session?.status() === "active") throw new ExecutionConflict("A legacy turn is still executing");
  return active ?? residentSession(sessionId, principal);
}

/**
 * The session as this process holds it, prepared from its record when it is
 * not held yet: no turn, no harness. Refused while another process drives it.
 */
export async function residentSession(sessionId: string, principal?: AuthPrincipal): Promise<ActiveSession> {
  const active = sessionRuntime.getActiveSession(sessionId);
  if (active) return active;
  const row = await getSessionRecord(sessionId);
  if (!row || row.state !== "open") throw new ExecutionConflict("Session is not open");
  const liveProcess = await Processes.getLive(sessionId);
  if (liveProcess && liveProcess.pid !== process.pid) {
    const liveness = classify({ pid: liveProcess.pid, pid_started_at: liveProcess.pidStartedAt, hostname: liveProcess.hostname });
    if (liveness.state !== "dead") throw new ExecutionConflict("Another session process is live or its liveness is unknown");
  }
  const metadata = row.metadata ?? {};
  const cwd = metadata.working_directory;
  if (typeof cwd !== "string" || !cwd) throw new ExecutionConflict("Session has no working directory");
  const traitNames = row.traits ?? [];
  const mcpServers = await sessionMcpServers(sessionId, await sessionGrants(sessionId, requestCaller(principal)));
  return sessionRuntime.startSession({
    sessionId, prompt: "", repoPath: cwd, prepareOnly: true,
    identityId: row.identity_id, traits: traitNames, mcpServers,
    ...(typeof metadata.provider === "string" ? { provider: metadata.provider } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.model_provider === "string" ? { modelProvider: metadata.model_provider } : {}),
  }, principal);
}

/** Explicit per-store assembly. Timers and service startup belong to the entrypoint. */
export function turnExecutionService(): Service {
  const path = sessionsDbPath();
  const existing = services.get(path); if (existing) return existing;
  const context = currentStoreContext() ?? {};
  const store = new TurnContinuations(getSessionsSqlite(), undefined, {
    pid: process.pid, pid_started_at: readProcessStartTime(process.pid), hostname: hostname(),
  });
  const execution = new TurnExecution({
    store,
    acquire: () => sessionRuntime.acquireTurnSlot(),
    openHarness: (sessionId) => withStoreContext(context, async () => {
      const active = await prepareTurnSession(sessionId);
      if (active.session) {
        await active.session.close(); active.session = null;
      }
      const config = await sessionRuntime.prepareHarnessConfiguration(active, undefined, undefined, false);
      const conversation = store.conversation(sessionId);
      if (conversation?.format === "barry.live.history") {
        const previousId = (conversation.payload as { harnessSessionId?: unknown })?.harnessSessionId;
        if (typeof previousId !== "string" || !previousId) throw new ExecutionConflict("Invalid live conversation reference");
        config.resume = { harnessSessionId: previousId };
      }
      return openContinuation(active.provider, config);
    }),
    authorize: (sessionId: string, call: PermissionRequest) => withStoreContext(context, () => sessionRuntime.authorizeContinuationTool(sessionId, call)),
  });
  let projection: Promise<void> | undefined;
  const service: Service = { store, execution, close: () => withStoreContext(context, async () => {
    await execution.close();
    await projection;
    while (store.pendingHistory(1).length) await projectTurnHistory(store);
  }), maintain: () => withStoreContext(context, () => {
    store.reconcileOwners(classify);
    store.expireDue();
    for (const item of store.runnable()) execution.recover(item.turn, item.input, item.restoring);
    if (!projection) {
      projection = projectTurnHistory(store).catch((error) => {
        diagnostics.error("sessions.history_projection_failed", { detail: "Session execution history projection failed; retained for retry", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      }).finally(() => { projection = undefined; });
    }
  }) };
  services.set(path, service);
  return service;
}

export function maintainTurnExecutions(): void { for (const service of services.values()) service.maintain(); }

export async function admitCompatibilityTurn(sessionId: string, text: string, attachmentIds: string[] | undefined, principal: AuthPrincipal): Promise<void> {
  const active = await prepareTurnSession(sessionId, principal);
  const hosted = getDescribeAdapter()?.(active.provider)?.modes.hosted;
  if (hosted?.guarantees.gating !== "per-call" || (hosted.approvalContinuation !== "live" && hosted.approvalContinuation !== "durable")) throw new ExecutionConflict("This adapter cannot provide per-call approval runs");
  const row = await getSessionRecord(sessionId);
  const prefix = attachmentIds?.length ? await sessionRuntime.prepareTurnAttachments(active, attachmentIds) : "";
  const requestId = randomUUID();
  turnExecutionService().execution.admit({ sessionId, requestId, runId: requestId, actor: `${principal.kind}:${principal.actorId}:${principal.credentialId}`,
    content: { text: prefix ? `${prefix}\n\n${text}` : text, message: { content: text }, attachmentIds: attachmentIds ?? [] },
    policy: sessionReviewPolicy(row?.metadata?.review_policy ?? { mode: "automatic" }), ifActive: "queue" });
}

export function pendingTurnRulings(sessionId: string): Array<{ requestId: string; tool: string; input: unknown; description?: string }> {
  const { store } = turnExecutionService();
  const turn = store.active(sessionId);
  if (!turn || turn.state !== "waiting_for_input") return [];
  return store.pendingRulings(sessionId, turn.id).map((interrupt) => ({ requestId: interrupt.id, tool: interrupt.call.tool, input: interrupt.call.input, ...(interrupt.call.description ? { description: interrupt.call.description } : {}) }));
}

/** The v1 request ID projects a v2 interrupt; no second approval queue exists. */
export async function submitTurnRuling(sessionId: string, requestId: string, decision: "allow" | "deny", reason: string | undefined, principal: AuthPrincipal): Promise<boolean> {
  await authorizeSessionExecution(principal, { sessionId });
  const { store, execution } = turnExecutionService();
  const turn = store.active(sessionId);
  const interrupt = turn?.interrupts.find((item) => item.id === requestId);
  if (!turn || !interrupt) return false;
  if (decision === "allow") await prepareTurnSession(sessionId, principal);
  const ruling = decision === "allow" ? await sessionRuntime.authorizeContinuationTool(sessionId, interrupt.call) : { allow: false as const, reason: reason ?? "Denied by user/app" };
  try {
    const resumed = store.recordRuling({ sessionId, turnId: turn.id, interruptId: requestId, decision: ruling, actor: `${principal.kind}:${principal.actorId}:${principal.credentialId}` });
    if (resumed.state === "running") execution.recover(resumed, undefined, true);
    return true;
  } catch (error) {
    if (error instanceof ExecutionConflict) return false;
    throw error;
  }
}
export async function closeTurnExecutions(): Promise<void> {
  const results = await Promise.allSettled([...services.values()].map((service) => service.close()));
  services.clear();
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Session execution drain was incomplete");
}
