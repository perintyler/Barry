// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, log} from "../session-runtime.js";
import {forgetSession, getSessionRecord, listSessionRecords, updateSessionMetadata, updateSessionRecord} from "../db.js";
import {Events} from "@barry-rocks/events-bag";
import {type AuthPrincipal} from "@barry-rocks/sdk/internal/auth";
import {endProviderSessionByProviderId} from "@barry-rocks/sessions-bag/client";
import {authorizeSessionExecution} from "@barry-rocks/sessions-bag/execution-authorization";
import {endSession as endSessionLifecycle} from "@barry-rocks/sessions-bag/lifecycle";
import {rmSync} from "fs";

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
    if (activeSession) {
      // Bumped FIRST, synchronously, before any await below — this is what a
      // turn still queued behind this stop (or waiting on the execution
      // semaphore) sees when its staleness check runs, closing the
      // resurrection bug where a queued turn found `session === null` (from
      // the close() below) and created a FRESH provider session instead of
      // staying stopped (, defect D).
      activeSession.generation++;

      // Abort any in-flight turn's provider-level work (SIGTERMs the codex
      // child, etc.) before discarding the session object. `abortController`
      // signals runTurn's own event-loop checks; `session.interrupt()` is the
      // provider's real cancellation — the two are complementary, not
      // redundant: the controller is session-runtime's signal, interrupt() is
      // what actually reaches the child process (, defect E).
      if (activeSession.abortController) {
        activeSession.abortController.abort();
      }
      if (activeSession.session) {
        await activeSession.session.interrupt().catch(() => {});
        // Not awaited: close resolves once the harness has exited, and a stop
        // is a request, not a wait. The turn in flight holds its slot until
        // then, reading the session's events to their end.
        void activeSession.session.close().catch(() => {});
        activeSession.session = null;
      }

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
      rt.activeSessions.delete(sessionId);
      rt.residentBudget.releaseById(sessionId);
      rt.broadcastSessionList();
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

      if (activeSession.abortController) {
        activeSession.abortController.abort();
      }
      if (activeSession.session) {
        await activeSession.session.interrupt().catch(() => {});
        // Not awaited, as in stopSession.
        void activeSession.session.close().catch(() => {});
        activeSession.session = null;
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

      rt.activeSessions.delete(sessionId);
      rt.residentBudget.releaseById(sessionId);
      rt.broadcastSessionList();
    }
  }

  /**
   * Invalidate the active SDK session so the next turn re-creates MCP
   * connections with freshly resolved traits/tools. Called when tool
   * configuration (traits, namespaces, tools) is changed externally
   * (e.g. via the BarrySession macOS app PATCH endpoint).
   */
export function rt_invalidateSessionTools(rt: SessionRuntime, sessionId: string): void {
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) return;
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
    if (activeSession.session) {
      void activeSession.session.close().catch(() => {});
      activeSession.session = null;
      activeSession.sessionId = null;
      log.info("session.tools_invalidated", { sessionId });
    }
  }
