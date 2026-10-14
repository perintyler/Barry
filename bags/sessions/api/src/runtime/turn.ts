// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, RunnerExecutionError, drainTurn, log} from "../session-runtime.js";
import type { ActiveSession, McpServerConfig, SessionTurnOutcome } from "../session-runtime.js";
import {forgetSession, getSessionRecord, updateSessionMetadata, updateSessionRecord} from "../db.js";
import {drainInbox} from "../inbox-relay.js";
import {applyProsePrefix} from "../session-prose.js";
import {bufferToolInvocation, flushToolInvocations, recordSessionUsage} from "../telemetry.js";
import {type TurnEvent, turnEventsOf} from "../turn-events.js";
import {Events} from "@barry-rocks/events-bag";
import {type PermissionDecision, type PermissionRequest, type Session, type SessionEvent, isScopedMcpTool} from "@barry-rocks/sdk/sessions";
import {createProviderSession, endProviderSessionByProviderId} from "@barry-rocks/sessions-bag/client";
import {endSession as endSessionLifecycle} from "@barry-rocks/sessions-bag/lifecycle";
import {randomUUID} from "node:crypto";

  /**
   * Serialize turns per session: a CodingAgentSession cannot run two send()
   * loops concurrently, so each turn chains onto the session's turnQueue and
   * waits for any in-flight turn to finish before starting. Errors in one turn
   * do not poison the queue for the next.
   *
   * Captures `activeSession.generation` NOW, at queue time — not when the
   * turn actually starts running. If stopSession/removeSession bumps the
   * generation while this turn is still waiting in the queue (or waiting on
   * the execution semaphore), runTurn's staleness checks compare against
   * this captured value and refuse to run — which is the fix for a stopped
   * session's queued turn creating a fresh provider session.
   */
export function rt_runSession(rt: SessionRuntime, 
    activeSession: ActiveSession,
    prompt: string,
    mcpServers: Record<string, McpServerConfig>
  ): Promise<SessionTurnOutcome> {
    const effectivePrompt = rt.withActionsIndex(activeSession, prompt);
    const gen = activeSession.generation;
    const interruptGen = activeSession.interruptGeneration;
    activeSession.pendingTurns++;
    const next = activeSession.turnQueue
      .catch(() => {}) // isolate: a failed prior turn shouldn't reject the chain
      .then(() => rt.runTurn(activeSession, effectivePrompt, mcpServers, gen, interruptGen))
      .catch((error): SessionTurnOutcome => ({ state: "failed", error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { activeSession.pendingTurns--; });
    activeSession.lastTurn = next;
    activeSession.turnQueue = next.then(() => undefined);
    return next;
  }

  /**
   * Prefix the actions index for providers that ignore `systemPrompt`.
   *
   * claude/zai get bag instructions via the systemPrompt preset and cursor via
   * its generated workspace instruction file, but codex and opencode read neither — the
   * prompt string is the only channel that reaches them. Applied here in
   * runSession rather than at the call sites because both the cold-start path
   * and the resume path (which passes content through unmodified) funnel
   * through it.
   *
   * Sent once per session: it is context, not a per-turn instruction, and
   * repeating it every turn would burn budget and read as nagging.
   */
export function rt_withActionsIndex(rt: SessionRuntime, activeSession: ActiveSession, prompt: string): string {
    const { prompt: next, sent } = applyProsePrefix(
      activeSession.provider,
      {
        alwaysInstructions: activeSession.alwaysInstructions,
        instructionsIndex: activeSession.instructionsIndex,
        actionsIndex: activeSession.actionsIndex,
      },
      prompt,
      Boolean(activeSession.actionsIndexSent),
    );
    activeSession.actionsIndexSent = sent;
    return next;
  }

  /**
   * A session is "stale" for turn purposes when either the generation this
   * turn was queued under has moved, or the map no longer holds this exact
   * object at this id (stopSession/removeSession deleted it, or a
   * differently-shaped restart replaced it). Map-identity, not just id
   * presence, because a delete-then-recreate under the same id must not be
   * confused with "still the session this turn belongs to".
   */
  /** Whether this turn was stopped with its session, rather than finished or interrupted. */
export function rt_turnWasStopped(rt: SessionRuntime, activeSession: ActiveSession, controller: AbortController, gen: number): boolean {
    if (rt.isStale(activeSession, gen)) return true;
    return controller.signal.aborted && activeSession.interruptedTurn !== controller;
  }

export function rt_isStale(rt: SessionRuntime, activeSession: ActiveSession, gen: number): boolean {
    return activeSession.generation !== gen || rt.activeSessions.get(activeSession.id) !== activeSession;
  }

export async function rt_runTurn(rt: SessionRuntime, 
    activeSession: ActiveSession,
    prompt: string,
    mcpServers: Record<string, McpServerConfig>,
    gen: number,
    interruptGen: number,
  ): Promise<SessionTurnOutcome> {
    // Staleness check BEFORE anything else — a turn queued behind a stop
    // must not run at all, let alone create a new provider session
    // (, defect D).
    if (rt.isStale(activeSession, gen)) return { state: "stopped" };
    if (activeSession.interruptGeneration !== interruptGen) return { state: "interrupted" };

    const lease = await rt.acquireTurnSlot(); // may throw AdmissionError("turn_queue_full")

    // Re-check after acquiring: stop can land while this turn was queued
    // waiting for an execution slot, not just while it was queued behind a
    // prior turn.
    if (rt.isStale(activeSession, gen)) {
      lease.release();
      return { state: "stopped" };
    }
    if (activeSession.interruptGeneration !== interruptGen) {
      lease.release();
      return { state: "interrupted" };
    }

    activeSession.status = "streaming";
    rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "streaming" });

    // Wires the abortController field that stopSession/removeSession already
    // call.abort() on — it was declared on ActiveSession but never assigned
    // anywhere, so those aborts were no-ops (, defect E's
    // session-runtime half). One controller per turn: stopSession firing between
    // two turns of the same session must not abort the wrong one.
    const controller = new AbortController();
    activeSession.abortController = controller;

    // Capacity is released only in `finally`, once the provider iterator has
    // actually terminated — not when the UI's stop request is accepted, and
    // not when this function merely returns early. Holding the lease through
    // a codex drain-after-abort (the iterator keeps running briefly after
    // signal.abort() until the child process actually exits) is what makes
    // "no longer counted as executing" mean "actually stopped executing".
    try {
      let runnerFailure: string | null = null;
      let turnResult: string | null = null;
      let wasInterrupted = false;

      // Resolve the identity's environment fresh on every turn (supports key
      // rotation). A build that fails returns environment: null, which the
      // gate below refuses on — a turn never starts on half-read credentials.
      const env = await rt.resolveHarnessEnvironment(activeSession);

      if (activeSession.session) log.info("sdk.session_followup", { sessionId: activeSession.id, sdkSessionId: activeSession.sessionId });
      const session = await rt.ensureHarnessSession(activeSession, mcpServers, env);

      for await (const event of rt.turnEvents(session, prompt, () => controller.signal.aborted || rt.isStale(activeSession, gen))) {
        await rt.handleRunnerEvent(activeSession, event);
        if (event.type === "error") runnerFailure = event.error;
        if (event.type === "result") {
          if (event.error) runnerFailure = event.error;
          if (event.result !== undefined) turnResult = event.result;
        }
      }

      if (session.harnessSessionId) {
        activeSession.sessionId = session.harnessSessionId;
      }

      if (rt.turnWasStopped(activeSession, controller, gen)) return { state: "stopped" };

      // An interrupted turn stops reading events at the interrupt, so how its
      // harness reports the abort is drained, not counted as a failure; an
      // error from before the interrupt still is.
      if (activeSession.interruptedTurn === controller) {
        wasInterrupted = true;
        activeSession.interruptedTurn = null;
      }
      if (runnerFailure) {
        throw new RunnerExecutionError(runnerFailure);
      }

      activeSession.consecutiveFailures = 0;
      activeSession.status = "waiting";
      log.info("session.turn_complete", { sessionId: activeSession.id, sdkSessionId: activeSession.sessionId });
      rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "waiting" });

      // Persist the resting state so the DB row no longer shows "running" after a
      // natural turn completion. Otherwise reconcileStaleSessions treats a healthy
      // idle session (running-in-DB, absent-from-memory after a restart) the same
      // as a crashed one. "pending" is the resumable resting status both use.
      //
      // Only write if the session is still resting: a queued turn may already
      // have started and set "running", and this write lands after it. The
      // in-memory status is the authority, since it is updated synchronously
      // while the DB write is not.
      if (activeSession.status === "waiting") {
        await updateSessionRecord(activeSession.id, { status: "pending" }).catch((e) => {
          log.warn("session.rest_status_failed", { sessionId: activeSession.id, error: e instanceof Error ? e.message : String(e) });
        });
      }

      // Anything that arrived WHILE this turn ran is read now, before the
      // session goes quiet. Without this the message waits for the idle relay's
      // next poll even though the session is right here, about to rest.
      //
      // Failing to deliver must not fail the turn that just succeeded: the
      // messages stay pending and the idle relay picks them up.
      if (activeSession.status === "waiting") {
        await drainInbox(activeSession.id, (id, content) => rt.sendMessage(id, content)).catch((e) => {
          log.warn("session.turn_end_drain_failed", {
            sessionId: activeSession.id,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }

      // Check if we should emit worktree_ready (when SDK finishes naturally, not via stop)
      // This is handled by stopSession when user manually stops; for natural completion check DB
      const completedDbSession = await getSessionRecord(activeSession.id);
      if (completedDbSession?.metadata?.use_worktree && completedDbSession.metadata.worktree_status === "active") {
        // Atomic partial merge — don't read-spread-overwrite the whole metadata
        // column (that races with concurrent metadata writers and drops keys).
        await updateSessionMetadata(activeSession.id, { worktree_status: "ready_to_merge" });
        rt.broadcastToSession(activeSession.id, { type: "worktree_ready", sessionId: activeSession.id, status: "ready_to_merge" });
      }

      // Note: We don't end the DB session here - the SDK session is still open!
      // DB session will be ended when the session is stopped or removed.
      return wasInterrupted ? { state: "interrupted" } : { state: "completed", result: turnResult };

    } catch (err) {
      activeSession.consecutiveFailures++;
      log.error("sdk.query_error", { sessionId: activeSession.id, consecutiveFailures: activeSession.consecutiveFailures, error: err instanceof Error ? err.message : String(err) });
      activeSession.status = "error";
      // Said aloud, as a finished turn's "waiting" is: a client waiting for
      // the turn to end otherwise never learns that it has.
      rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "error" });

      if (activeSession.session) {
        void activeSession.session.close().catch(() => {});
        activeSession.session = null;
      }

      const alreadyReported = err instanceof RunnerExecutionError;
      if (!alreadyReported) {
        rt.broadcastToSession(activeSession.id, {
          type: "error",
          sessionId: activeSession.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // End the session in DB (use Barry canonical ID)
      await endSessionLifecycle({ session_id: activeSession.id, reason: "error" }).catch((err2) => {
        log.warn("sdk.session_end_error", { sessionId: activeSession.id, error: err2 instanceof Error ? err2.message : String(err2) });
      });

      if (activeSession.sessionId) {
        await endProviderSessionByProviderId(activeSession.sessionId).catch(() => {});
      }
      // Ended: its tool-call correlation state goes with it.
      forgetSession(activeSession.id);

      await updateSessionRecord(activeSession.id, { status: "failed" });

      Events.create({
        type: "task_finished",
        session_id: activeSession.id,
        source: "system",
        title: "Session failed",
        severity: "error",
        data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
      }).catch(() => {}); // non-fatal

      return { state: "failed", error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Sweep any tool timers that never received a matching tool_result (aborted
      // tool, lost event). Runs on both success and failure so the map can't grow
      // unbounded over a long-lived server.
      rt.sweepToolTimers(activeSession.id);

      // Only clear OUR OWN controller — a stale runTurn's finally must not
      // erase the abortController a newer turn has since installed.
      if (activeSession.abortController === controller) {
        activeSession.abortController = null;
      }
      // Capacity frees only now: the provider iterator has actually ended
      // (normally, on error, or after draining post-abort), not merely when
      // a stop request was accepted. This is what makes the execution
      // budget reflect real concurrency instead of "turns we asked to stop".
      lease.release();
    }
  }

  /** Remove any lingering tool timers belonging to a session. */
export function rt_sweepToolTimers(rt: SessionRuntime, sessionId: string): void {
    for (const [id, timer] of rt.toolTimers) {
      if (timer.sessionId === sessionId) rt.toolTimers.delete(id);
    }
  }

  /**
   * One turn: deliver the prompt and read the session's events until the
   * turn's `done`, in the vocabulary `handleRunnerEvent` reads.
   *
   * Stopping mid-turn interrupts the session and then drains the rest of the
   * turn, unreported: a session has one event stream across turns, so an
   * abandoned turn's remainder — its `done` included — would otherwise be
   * read as the start of the next one. It also means the turn has really
   * stopped before its execution slot is released.
   */
export async function* rt_turnEvents(rt: SessionRuntime, session: Session, prompt: string, stopped: () => boolean): AsyncGenerator<TurnEvent> {
    await session.deliver(prompt);
    // Read with `next()` rather than `for await`, and only ever stop between
    // events: a reader abandoned while waiting would take the next event
    // with it, and one returned early would end the stream for good.
    const reader = session.events()[Symbol.asyncIterator]();
    let finished = false;
    async function* thisTurn(): AsyncGenerator<SessionEvent> {
      for (;;) {
        const next = await reader.next();
        if (next.done) {
          finished = true;
          return;
        }
        yield next.value;
        if (next.value.type === "done") {
          finished = true;
          return;
        }
      }
    }
    for await (const event of turnEventsOf(thisTurn())) {
      if (stopped()) {
        await session.interrupt().catch(() => {});
        break;
      }
      yield event;
    }
    if (!finished) await drainTurn(reader);
  }

  /**
   * Map RunnerEvents to WsMessages and broadcast to subscribers.
   */
export async function rt_handleRunnerEvent(rt: SessionRuntime, activeSession: ActiveSession, event: TurnEvent): Promise<void> {
    // Subagent events are broadcast and persisted like any other, but carry the
    // spawning tool-use id so consumers can group or filter them. Stamped once
    // here rather than at each broadcast call below.
    const previousProvenance = rt.currentProvenance;
    rt.currentProvenance = event.parentToolUseId;
    try {
      await rt.handleRunnerEventInner(activeSession, event);
    } finally {
      rt.currentProvenance = previousProvenance;
    }
  }

export async function rt_handleRunnerEventInner(rt: SessionRuntime, activeSession: ActiveSession, event: TurnEvent): Promise<void> {
    switch (event.type) {
      case "init":
        log.info("sdk.session_started", { sessionId: activeSession.id, sdkSessionId: event.sessionId });

        // Link the SDK runtime ID to the Barry session via provider_sessions
        try {
          await createProviderSession({
            session_id: activeSession.id,
            provider: activeSession.provider,
            provider_session_id: event.sessionId,
          });
          activeSession.sessionId = event.sessionId;
        } catch (err) {
          log.warn("sdk.provider_session_create_warn", { error: err instanceof Error ? err.message : String(err) });
          activeSession.sessionId = event.sessionId;
        }

        rt.broadcastToSession(activeSession.id, {
          type: "init",
          sessionId: activeSession.id,
          content: `Session ${event.sessionId} started`,
        });
        break;

      case "partial":
        activeSession.outputBuffer += event.content;
        rt.broadcastToSession(activeSession.id, {
          type: "partial",
          sessionId: activeSession.id,
          content: event.content,
        });
        break;

      case "text":
        rt.broadcastToSession(activeSession.id, {
          type: "text",
          sessionId: activeSession.id,
          content: event.content,
          role: event.role,
        });
        activeSession.outputBuffer = "";
        break;

      case "tool_start":
        rt.toolTimers.set(event.toolUseId, { start: Date.now(), name: event.name, sessionId: activeSession.id });
        log.info("session.tool_start", { sessionId: activeSession.id, tool: event.name, toolUseId: event.toolUseId });
        rt.broadcastToSession(activeSession.id, {
          type: "tool_start",
          sessionId: activeSession.id,
          name: event.name,
          input: event.input,
          toolUseId: event.toolUseId,
        });
        break;

      case "tool_result": {
        const toolInfo = event.toolUseId ? rt.toolTimers.get(event.toolUseId) : undefined;
        const toolDuration = toolInfo ? Date.now() - toolInfo.start : undefined;
        const toolName = toolInfo?.name;
        if (event.toolUseId) rt.toolTimers.delete(event.toolUseId);
        log.info("session.tool_result", { sessionId: activeSession.id, tool: toolName, toolUseId: event.toolUseId, duration_ms: toolDuration });
        // Persist the duration that was, until now, computed and thrown away one
        // line above. Buffered rather than written per call: a busy day is ~5,000
        // tool results, and an fsync on this path would make measuring cost more
        // than the thing measured. Never throws — see./telemetry.js.
        if (toolDuration !== undefined && toolName) {
          bufferToolInvocation({
            id: `ti_${randomUUID()}`,
            sessionId: activeSession.id,
            toolUseId: event.toolUseId,
            name: toolName,
            durationMs: toolDuration,
            createdAt: Math.floor(Date.now() / 1000),
          });
        }
        rt.broadcastToSession(activeSession.id, {
          type: "tool_result",
          sessionId: activeSession.id,
          toolUseId: event.toolUseId,
          result: event.result,
        });
        break;
      }

      case "tool_progress":
        rt.broadcastToSession(activeSession.id, {
          type: "tool_progress",
          sessionId: activeSession.id,
          name: event.name,
          toolUseId: event.toolUseId,
          elapsedTime: event.elapsedTime,
        });
        break;

      case "result": {
        const usage = event.usage;
        const usageContext = usage ? {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          cost_usd: usage.costUsd,
          num_turns: usage.numTurns,
          sdk_duration_ms: usage.durationMs,
        } : {};

        const barryContext = { identityId: activeSession.identityId, identityName: activeSession.identityName };

        // The terminus used to be the log line below: usageContext was assembled
        // purely to be logged, so cost and token counts existed in memory for
        // microseconds and were then discarded. Persist them, and flush whatever
        // tool durations this turn buffered while we are here.
        //
        // Best-effort by construction: the telemetry module swallows and counts
        // its own failures, so a broken usage.db cannot fail a session.
        if (usage) {
          recordSessionUsage({
            id: `su_${randomUUID()}`,
            sessionId: activeSession.id,
            model: activeSession.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            totalTokens: usage.totalTokens,
            costUsd: usage.costUsd,
            numTurns: usage.numTurns,
            durationMs: usage.durationMs,
            status: event.error ? "error" : "ok",
            createdAt: Math.floor(Date.now() / 1000),
          });
        }
        flushToolInvocations();

        if (event.error) {
          log.error("session.result", { sessionId: activeSession.id, status: "error", error: event.error, ...usageContext, ...barryContext });
          rt.broadcastToSession(activeSession.id, {
            type: "result",
            sessionId: activeSession.id,
            error: event.error,
            status: "error",
          });
        } else {
          log.info("session.result", { sessionId: activeSession.id, status: "success", ...usageContext, ...barryContext });
          rt.broadcastToSession(activeSession.id, {
            type: "result",
            sessionId: activeSession.id,
            result: event.result,
            status: "success",
          });
        }
        break;
      }

      case "error":
        log.error("session.error", { sessionId: activeSession.id, error: event.error });
        rt.broadcastToSession(activeSession.id, {
          type: "error",
          sessionId: activeSession.id,
          error: event.error,
        });
        break;
    }
  }

  /** Scoped Barry MCP tools run without a second approval layer. */
export function rt_createDecideFunction(rt: SessionRuntime, 
    activeSession: ActiveSession,
    deniedTools: readonly string[],
    servers: readonly string[],
    allowedNativeTools: readonly string[],
  ): (request: PermissionRequest) => Promise<PermissionDecision> {
    return async (request: PermissionRequest): Promise<PermissionDecision> => {
      // 1. Bounds / denied-tools first — an app can never widen a session beyond its bounds
      if (deniedTools.includes(request.tool) || (!allowedNativeTools.includes(request.tool) && !isScopedMcpTool(request.tool, servers))) {
        return { allow: false, reason: `${request.tool} is denied in this session` };
      }

      // Barry tools enforce their grants and bounds at discovery and execution.
      // An attached renderer does not introduce another approval requirement.
      return { allow: true };
    };
  }
