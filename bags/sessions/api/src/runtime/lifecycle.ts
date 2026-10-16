import { removeWarmAssets } from "./warm.js";
// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import type {ActiveSession} from "../session-runtime.js";
import {SessionRuntime, log} from "../session-runtime.js";
import {forgetSession, getSessionRecord, listSessionRecords, updateSessionMetadata, updateSessionRecord} from "../db.js";
import {Events} from "@barry-rocks/events-bag";
import {type AuthPrincipal} from "@barry-rocks/sdk/internal/auth";
import {endProviderSessionByProviderId} from "@barry-rocks/sessions-bag/client";
import {authorizeSessionExecution} from "@barry-rocks/sessions-bag/execution-authorization";
import {endSession as endSessionLifecycle} from "@barry-rocks/sessions-bag/lifecycle";
import {rmSync} from "fs";

function finalizeAfterDrain(rt:SessionRuntime,active:ActiveSession,reason:"stopped"|"evicted"|"removed"):void {
  active.finalization??=(async()=>{
    while(!(await Promise.all([active.persistence?.flush(1000)??true,active.statePersistence?.flush(1000)??true])).every(Boolean)){/* Preserve accepted writes while the worker retries. */}
    await endSessionLifecycle({session_id:active.id,reason});
    if(active.sessionId)await endProviderSessionByProviderId(active.sessionId).catch(()=>{});
    await updateSessionRecord(active.id,{status:reason==="evicted"?"pending":reason==="removed"?"cancelled":"completed",...(reason==="evicted"?{}:{completed_at:new Date()})});
    if(reason==="stopped") {
      const row=await getSessionRecord(active.id);
      if(row?.metadata?.use_worktree && row.metadata.worktree_status==="active")await updateSessionMetadata(active.id,{worktree_status:"ready_to_merge"});
    }
  })().catch(error=>log.warn("session.end_delayed",{sessionId:active.id,error:String(error)}));
  rt.retainPersistence(active);
}

  /**
   * On startup, mark any DB sessions stuck in "running" as "pending".
   * These sessions had their SDK query lost when the server restarted.
   * Setting them to "pending" keeps them visible in the session list
   * and lets users resume by sending a new message.
   */
export async function rt_reconcileStaleSessions(rt: SessionRuntime): Promise<void> {
    // No small limit here: this is a full sweep of rows stuck in "running", and
    // any row left out stays stuck until the next restart (nothing else
    // reconciles status between boots).
    const staleSessions = await listSessionRecords({ status: "running", limit: 1000 });
    const { parseMetadata: parseSessionMetadata } = await import("@barry-rocks/sessions-bag/store/session-helpers");
    const { classify: classifyProcessLiveness } = await import("@barry-rocks/sessions-bag/process-liveness");
    for (const ps of staleSessions) {
      if (rt.executionGuard?.(ps.id)) continue;
      if (rt.activeSessions.has(ps.id)) continue;

      // `activeSessions` only ever held sessions this process spawned, so a CLI
      // session — how nearly every session here starts — was never in it. Reading
      // absence as staleness rewrote the status of *live* CLI sessions to
      // "pending" on every API restart, which is what left the macOS status dot
      // orange for sessions that were actively streaming.
      //
      // Same tiebreaker the active-session sweep below already uses: a recorded
      // pid still alive on this host means the session is running, whoever
      // spawned it. An off-host pid is unprovable here, so leave it for the idle
      // sweep rather than guessing — guessing wrong rewrites live state.
      const liveness = classifyProcessLiveness(parseSessionMetadata(ps.metadata));
      if (liveness.state === "alive") continue;
      // EVERY "unknown" is skipped, not just other-host. `no-pid` means this
      // host cannot tell whether the session is running — and acting on it
      // rewrote live sessions to `pending` mid-tool-call, the same failure the
      // comment above describes for CLI sessions. classifyProcessLiveness
      // already says which verdicts are provable; the caller's job is to
      // believe it. "Unknown" belongs to the idle TTL sweep, which uses time
      // rather than a guess (bags/sessions/src/process-liveness.ts).
      if (liveness.state === "unknown") continue;

      log.info("reconcile.stale_session", { sessionId: ps.id, prompt: ps.system_prompt?.slice(0, 50) });
      await updateSessionRecord(ps.id, { status: "pending" });
    }
    if (staleSessions.length > 0) {
      log.info("reconcile.done", { staleCount: staleSessions.length });
    }

    // End any sessions stuck as "active" that aren't tracked in memory
    // (e.g. from previous server runs that didn't clean up)
    try {
      // Reconcile through the sessions seam, using proven process liveness.
      const { parseMetadata: parseSessionMetadata } = await import("@barry-rocks/sessions-bag/store/session-helpers");
      const { classify: classifyProcessLiveness } = await import("@barry-rocks/sessions-bag/process-liveness");
      const { getActiveSessions } = await import("@barry-rocks/sessions-bag/client");
      const staleSessions = await getActiveSessions();

      let endedCount = 0;
      let liveElsewhere = 0;
      let unprovable = 0;
      for (const session of staleSessions) {
        if (rt.executionGuard?.(session.id)) continue;
        // Check if any in-memory session owns this session (by Barry canonical ID)
        let owned = rt.activeSessions.has(session.id);
        if (!owned) {
          // Also check by SDK session ID for backwards compatibility
          for (const activeSession of rt.activeSessions.values()) {
            if (activeSession.sessionId === session.id) {
              owned = true;
              break;
            }
          }
        }
        if (owned) continue;
        // A hosted draft has not begun a turn. Losing its resident process
        // across a restart does not end the user's durable draft.
        if (session.status === "pending" && !session.started_at && session.metadata?.mode === "hosted") continue;

        // In-memory ownership only ever covered sessions this process drives.
        // CLI sessions are child processes of `barry start` and were NEVER in
        // that map, so this loop closed every live CLI session on every API
        // restart — 47 rows in 30 days, while their agents kept running.
        //
        // The process table is the tiebreaker: a session whose recorded pid is
        // still alive on this host is running, whoever spawned it.
        const liveness = classifyProcessLiveness(parseSessionMetadata(session.metadata));
        if (liveness.state === "alive") {
          liveElsewhere++;
          continue;
        }
        // A pid from another machine says nothing about whether that session is
        // running, and this host cannot find out. Leave it to the idle sweep
        // instead of guessing — the one case where "unknown" must not be acted
        // on, because acting on it means closing someone else's live session.
        if (liveness.state === "unknown" && liveness.reason === "other-host") {
          unprovable++;
          continue;
        }

        // Everything else — proven dead, or no pid recorded at all — is closed,
        // exactly as before. Narrowing the test from "not in memory" to "not
        // alive" IS the fix; a session that never recorded a pid is no more
        // trustworthy than it was yesterday, so it keeps its old treatment
        // rather than being granted a new immunity that would strand orphans.
        await endSessionLifecycle({ session_id: session.id, reason: "server_restart" });
        endedCount++;
      }
      // Report nonempty reconciliation batches even when no session can be ended.
      if (staleSessions.length > 0) {
        log.info(
          `reconcile.stale_sessions considered=${staleSessions.length} ended=${endedCount} ` +
            `liveElsewhere=${liveElsewhere} unprovable=${unprovable}`,
        );
      }
    } catch (err) {
      log.warn("reconcile.session_cleanup_error", { error: err instanceof Error ? err.message : String(err) });
    }
  }

export async function rt_stopSession(rt: SessionRuntime, sessionId: string, principal?: AuthPrincipal, reason: "stopped" | "evicted" = "stopped"): Promise<void> {
    if (principal) await authorizeSessionExecution(principal, { sessionId });
    const activeSession = rt.activeSessions.get(sessionId);
    if (activeSession && reason === "evicted" && (activeSession.warm || activeSession.warming) && activeSession.lastSequence < 0 && !activeSession.pendingTurns) {
      await rt.dropResident(sessionId);
      return;
    }
    if (activeSession) {
      // Bumped FIRST, synchronously, before any await below — this is what a
      // turn still queued behind this stop (or waiting on the execution
      // semaphore) sees when its staleness check runs, closing the
      // resurrection bug where a queued turn found `session === null` (from
      // the close() below) and created a FRESH provider session instead of
      // staying stopped (, defect D).
      activeSession.generation++;

      await rt.forceTurn(activeSession);
      try {
      if (activeSession.warm && activeSession.lastSequence < 0) removeWarmAssets(activeSession);
      activeSession.status = "complete";
      rt.sweepToolTimers(sessionId);
      forgetSession(sessionId);
      const duration_ms = Date.now() - activeSession.createdAt.getTime();
      // identityName/identityId ride in the message: they were rejected as
      // columns ("adding 'identityName' to dataset fields would exceed the
      // column limit of 257"), which silently drops this whole line at the
      // sink. sessionId and duration stay as fields — this dataset already has
      // both, so they cost nothing.
      log.info(
        `session.stopped identity=${activeSession.identityName ?? "-"}#${activeSession.identityId ?? "-"} ` +
          `sdkSessionId=${activeSession.sessionId ?? "-"}`,
        { sessionId, duration: duration_ms },
      );
      rt.broadcastToSession(sessionId, reason === "evicted"
        ? { type: "session_evicted", sessionId, status: "pending" }
        : { type: "status", sessionId, status: "complete" });

      // Do not delete an apparently empty draft while its accepted rows are queued.
      if (!await rt.flushPersistence(sessionId,1)) {
        rt.sendInTurn(activeSession,{type:"status",sessionId,status:"complete",metadata:{code:"persistence_lagging",recordingPending:true}});
        finalizeAfterDrain(rt,activeSession,reason);
        return;
      }
      // End the session in DB (use Barry canonical ID)
      await endSessionLifecycle({ session_id: sessionId, reason });

      if (activeSession.sessionId) {
        await endProviderSessionByProviderId(activeSession.sessionId).catch(() => {});
      }

      const stoppingDbSession = await getSessionRecord(sessionId);
      const promoteWorktree =
        reason !== "evicted" &&
        stoppingDbSession?.metadata?.use_worktree &&
        stoppingDbSession.metadata.worktree_status === "active";

      await updateSessionRecord(sessionId, {
        status: reason === "evicted" ? "pending" : "completed",
        ...(reason === "evicted" ? {} : { completed_at: new Date() }),
      });
      // Merge the worktree status atomically (partial metadata merge) rather than
      // read-spread-overwrite, which would race with other metadata writers.
      if (promoteWorktree) {
        await updateSessionMetadata(sessionId, { worktree_status: "ready_to_merge" });
        rt.broadcastToSession(sessionId, { type: "worktree_ready", sessionId, status: "ready_to_merge" });
      }

      if (reason !== "evicted") Events.create({
        type: "task_finished",
        session_id: sessionId,
        source: "system",
        title: `Session completed (${Math.round(duration_ms / 1000)}s)`,
        severity: "success",
        data: { status: "completed", duration_seconds: Math.round(duration_ms / 1000) },
      }).catch(() => {}); // non-fatal

      // Drop the in-memory entry: the session is closed and its status is
      // terminal, so leaving it here would make getActiveSessionIds() report it
      // as running forever. Summary scheduling above is keyed by id and does not
      // depend on this map. Kept last so a throw earlier cannot strand the entry.
      } finally {
        rt.retainPersistence(activeSession);
        rt.activeSessions.delete(sessionId);
        rt.residentBudget.releaseById(sessionId);
        rt.broadcastSessionList();
      }
    }
  }

export async function rt_removeSession(rt: SessionRuntime, sessionId: string, principal?: AuthPrincipal): Promise<void> {
    if (principal) await authorizeSessionExecution(principal, { sessionId });
    const activeSession = rt.activeSessions.get(sessionId);
    if (activeSession) {
      // See stopSession's identical comment: bumped first and synchronously,
      // before anything else, so a queued/semaphore-waiting turn cannot slip
      // past the removal and create a fresh provider session.
      activeSession.generation++;

      await rt.forceTurn(activeSession);
      try {
      // Do not delete an apparently empty draft while its accepted rows are queued.
      if (!await rt.flushPersistence(sessionId,1)) {
        rt.sendInTurn(activeSession,{type:"status",sessionId,status:"complete",metadata:{code:"persistence_lagging",recordingPending:true}});
        finalizeAfterDrain(rt,activeSession,"removed");
        return;
      }
      // End the session in DB (use Barry canonical ID)
      await endSessionLifecycle({ session_id: sessionId, reason: "removed" }).catch((err) => {
        log.warn("sdk.session_end_error", { sessionId, error: err instanceof Error ? err.message : String(err) });
      });

      if (activeSession.sessionId) {
        await endProviderSessionByProviderId(activeSession.sessionId).catch(() => {});
      }

      forgetSession(sessionId);
      rt.sweepToolTimers(sessionId);

      if (activeSession.skillsPluginDir) {
        try { rmSync(activeSession.skillsPluginDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        activeSession.skillsPluginDir = null;
      }

      if (activeSession.commandsDir) {
        try { rmSync(activeSession.commandsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        activeSession.commandsDir = null;
      }


      } finally {
        rt.retainPersistence(activeSession);
        rt.activeSessions.delete(sessionId);
        rt.residentBudget.releaseById(sessionId);
        rt.broadcastSessionList();
      }
    }
  }

  /**
   * Invalidate the active SDK session so the next turn re-creates MCP
   * connections with freshly resolved bags, bounds, and tools. Called when tool
   * configuration (bags, bounds, namespaces, tools) is changed externally
   * (e.g. via the BarrySession macOS app PATCH endpoint).
   */
export function rt_invalidateSessionTools(rt: SessionRuntime, sessionId: string, options: { reason?: "grants" | "system_prompt" } = {}): void {
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) return;
    if (options.reason === "grants") {
      // MCP publishes tools/list_changed; the per-call gate resolves current bounds.
      return;
    }
    if (activeSession.status === "streaming") {
      log.warn("session.invalidate_while_streaming", { sessionId });
      return;
    }
    // Closing the session would close the engine an attached TUI runs on.
    if (activeSession.renderers.size > 0) {
      activeSession.toolsChangedWhileAttached = true;
      log.info("session.invalidate_after_detach", { sessionId });
      return;
    }
    const wasPrepared = !!(activeSession.warm || activeSession.warming);
    const warming = activeSession.warming;
    if (warming) activeSession.warmGeneration = (activeSession.warmGeneration ?? 0) + 1;
    activeSession.warm = null;
    if (activeSession.session) {
      void activeSession.session.close().catch(() => {});
      activeSession.session = null;
      activeSession.sessionId = null;
      log.info("session.tools_invalidated", { sessionId });
    }    if (wasPrepared) void Promise.resolve(warming).then(async () => {
      if (rt.activeSessions.get(sessionId) === activeSession && !activeSession.pendingTurns && !activeSession.abortController) {
        const row = await getSessionRecord(sessionId);
        if (row) {
          if (row.bags) activeSession.bags = row.bags;
          if (row.bounds) activeSession.bounds = row.bounds;
          if (row.bound !== undefined) activeSession.bound = row.bound;
        }
        return rt.warmHarness(sessionId);
      }
    }).catch(error => log.warn("session.rewarm_failed", { sessionId, error: String(error) }));

  }
