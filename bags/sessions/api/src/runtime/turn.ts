import {deferred,untilAborted} from "@barry-rocks/sdk/sessions";
import { claudeProcessCount } from "./process-count.js";
import { TurnTimer } from "./turn-timer.js";
// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, RunnerExecutionError, drainTurn, log} from "../session-runtime.js";
import { assertInteractiveDestination } from "../workflow-session-ownership.js";
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
    mcpServers: Record<string, McpServerConfig>,
    ingressAt?: number,
  ): Promise<SessionTurnOutcome> {
    assertInteractiveDestination(activeSession.id);
    const timer = new TurnTimer(ingressAt);
    const effectivePrompt = rt.withActionsIndex(activeSession, prompt);
    const gen = activeSession.generation;
    const interruptGen = activeSession.interruptGeneration;
    activeSession.pendingTurns++;
    const next = activeSession.turnQueue
      .catch(() => {}) // isolate: a failed prior turn shouldn't reject the chain
      .then(() => rt.runTurn(activeSession, effectivePrompt, mcpServers, gen, interruptGen, timer))
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
    timer = new TurnTimer(),
  ): Promise<SessionTurnOutcome> {
    // Staleness check BEFORE anything else — a turn queued behind a stop
    // must not run at all, let alone create a new provider session
    // (, defect D).
    assertInteractiveDestination(activeSession.id);
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

    activeSession.turnTimer = timer;
    timer.mark("queue_ms");
    const turnStart = performance.now();
    delete activeSession.timings.first_event_ms;
    delete activeSession.timings.first_token_ms;
    activeSession.status = "starting";
    rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "starting", metadata: { warm: activeSession.session?.isWarm?.() === true ? 1 : 0, phase: "initializing" } });

    // Wires the abortController field that stopSession/removeSession already
    // call.abort() on — it was declared on ActiveSession but never assigned
    // anywhere, so those aborts were no-ops (, defect E's
    // session-runtime half). One controller per turn: stopSession firing between
    // two turns of the same session must not abort the wrong one.
    const controller = new AbortController();
    activeSession.abortController = controller;
    const completion=deferred<void>();
    const control={force:new AbortController(),done:completion.promise,finish:()=>completion.resolve()};
    activeSession.turnControl=control;activeSession.lastEventAt=undefined;activeSession.lastEventAtMonotonic=performance.now();
    const cancellable=<T>(work:PromiseLike<T>)=>untilAborted(work,control.force.signal);

    // This turn owns its lease until its reader finishes or explicit forced
    // cancellation abandons that reader. Adapter close owns process cleanup;
    // late provider completions cannot release a subsequent turn's lease.
    try {
      await timer.measure("warm_wait_ms", async () => { await cancellable(activeSession.warming??Promise.resolve()); });
      if (rt.isStale(activeSession, gen)) return { state: "stopped" };
      const wasWarm = activeSession.session?.isWarm?.() === true;
      if (!wasWarm && activeSession.warm) delete activeSession.warm.preparedAt;
      activeSession.timings.warm_hit = wasWarm ? 1 : 0;
      if (wasWarm) { delete activeSession.timings.harness_create_ms; delete activeSession.timings.harness_ready_ms; }
      const recordStart = performance.now();
      if (!activeSession.startedAtRecorded) {
        await updateSessionRecord(activeSession.id, { started_at: new Date(), status: "running" },{defer:true});
        activeSession.startedAtRecorded = true;
      }
      timer.sample("record", performance.now() - recordStart);
      let runnerFailure: string | null = null;
      let turnResult: string | null = null;
      let wasInterrupted = false;

      // Resolve the identity's environment fresh on every turn (supports key
      // rotation). A build that fails returns environment: null, which the
      // gate below refuses on — a turn never starts on half-read credentials.
      const env = await cancellable(timer.measure("env_ms", () => rt.resolveHarnessEnvironment(activeSession)));

      if (activeSession.session) log.info("sdk.session_followup", { sessionId: activeSession.id, sdkSessionId: activeSession.sessionId });
      const session = await cancellable(timer.measure("open_ms", () => rt.ensureHarnessSession(activeSession, mcpServers, env)));
      if(rt.isStale(activeSession,gen)||control.force.signal.aborted)return {state:"stopped"};

      activeSession.status = "streaming";
      rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "streaming" });
      timer.mark("deliver_ms");
      activeSession.timings.deliver_at = performance.now();
      for await (const event of rt.turnEvents(session, prompt, () => controller.signal.aborted || rt.isStale(activeSession, gen),control.force.signal,()=>{if(!rt.isStale(activeSession,gen)){activeSession.lastEventAt=new Date().toISOString();activeSession.lastEventAtMonotonic=performance.now();}})) {
        timer.event(event.type);
        if (event.type === "partial") timer.count("partial_frames");
        if (event.type === "thinking") timer.count("thinking_frames");
        activeSession.timings.first_event_ms ??= performance.now() - turnStart;
        if (event.type === "partial" || event.type === "text") activeSession.timings.first_token_ms ??= performance.now() - turnStart;
        await cancellable(rt.handleRunnerEvent(activeSession, event));
        if (event.type === "error") runnerFailure = event.error;
        if (event.type === "result") {
          for (const [name, value] of Object.entries(event.usage?.sdk ?? {})) if (typeof value === "number") timer.count(`sdk_${name}`, value);
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
      activeSession.thinkingBuffer = "";
      activeSession.turnFrames = activeSession.persistence?.pending().slice() ?? [];
      activeSession.status = "waiting";
      activeSession.timings.turn_done_ms = performance.now() - turnStart;
      timer.mark("turn_done_ms");
      log.info("session.timing", { sessionId: activeSession.id, warm_hit:wasWarm?1:0, ...timer.summary() });
      log.info("session.turn_complete", { sessionId: activeSession.id, sdkSessionId: activeSession.sessionId });
      rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "waiting", metadata: { timing: {warm_hit: wasWarm ? 1 : 0,...timer.summary()}, session: {...activeSession.timings} } });

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
        await updateSessionRecord(activeSession.id, { status: "pending" },{defer:true}).catch((e) => {
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
      const completedDbSession = await cancellable(getSessionRecord(activeSession.id));
      if(rt.isStale(activeSession,gen))return {state:"stopped"};
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
      if(rt.turnWasStopped(activeSession,controller,gen)||control.force.signal.aborted)return {state:"stopped"};
      const retryable = /Subprocess initialization did not complete|initializ(?:e|ation|ing).*?(?:timeout|timed out)|(?:timeout|timed out).*initializ/i.test(err instanceof Error ? err.message : String(err));
      if (retryable) {
        await cancellable(Promise.resolve(activeSession.session?.close()).catch(() => {}));
        if(rt.isStale(activeSession,gen)||control.force.signal.aborted)return {state:"stopped"};
        activeSession.session=null; activeSession.warm=null;
        activeSession.status="waiting";
        rt.broadcastToSession(activeSession.id, { type: "error", sessionId: activeSession.id, error: String(err), metadata: { code: "harness_initialize_timeout", retryable: true } });
        rt.broadcastToSession(activeSession.id, { type: "status", sessionId: activeSession.id, status: "waiting" });
        await updateSessionRecord(activeSession.id, { status: "pending" });
        return { state: "failed", error: String(err) };
      }
      activeSession.consecutiveFailures++;
      void claudeProcessCount().then(claude_processes=>log.info("sdk.query_error_processes", {sessionId:activeSession.id,claude_processes}));
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

      // Preserve the row if accepted transcript writes are still pending.
      if (!await cancellable(rt.flushPersistence(activeSession.id,30_000))) {
        await updateSessionRecord(activeSession.id,{status:"pending"});
        return {state:"failed",error:"Recording delayed; session retained"};
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
      // Completion and capacity settle once for this captured turn, including
      // a forced cancellation of an otherwise silent provider iterator.
      lease.release();control.finish();if(activeSession.turnControl===control)delete activeSession.turnControl;
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
export async function* rt_turnEvents(rt: SessionRuntime, session: Session, prompt: string, stopped: () => boolean, force?:AbortSignal, onEvent?:()=>void): AsyncGenerator<TurnEvent> {
    await untilAborted(session.deliver(prompt),force);
    // Ordinary interrupts drain through done before reusing this stream. A
    // forced cancellation abandons pending reads and closes that harness; its
    // late events can never become a subsequent turn's input.
    const reader = session.events()[Symbol.asyncIterator]();
    let finished = false;
    async function* thisTurn(): AsyncGenerator<SessionEvent> {
      for (;;) {
        const next = await untilAborted(reader.next(),force);
        if(!next.done)onEvent?.();
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
        void session.interrupt().catch(() => {});
        break;
      }
      yield event;
    }
    if (!finished) await untilAborted(drainTurn(reader),force);
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
        activeSession.sessionId = event.sessionId;
        void createProviderSession({ session_id: activeSession.id, provider: activeSession.provider,
          provider_session_id: event.sessionId }).catch(err => {
          log.warn("sdk.provider_session_create_warn", { error: err instanceof Error ? err.message : String(err) });
        });

        rt.broadcastToSession(activeSession.id, {
          type: "init",
          sessionId: activeSession.id,
          content: `Session ${event.sessionId} started`,
        });
        break;

      case "starting":
        rt.broadcastToSession(activeSession.id, {type:"status",sessionId:activeSession.id,status:"starting",metadata:{phase:event.phase,warm:0}});
        break;
      case "thinking":
        if (!event.parentToolUseId) activeSession.thinkingBuffer = (activeSession.thinkingBuffer ?? "") + event.content;
        rt.broadcastToSession(activeSession.id, { type: "thinking", sessionId: activeSession.id, content: event.content });
        break;
      case "tool_input_delta":
        rt.broadcastToSession(activeSession.id, { type: "tool_input_delta", sessionId: activeSession.id, content: event.content, toolUseId: event.toolUseId });
        break;
      case "partial":
        if (!event.parentToolUseId) activeSession.thinkingBuffer = "";
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
        if (!event.parentToolUseId) activeSession.thinkingBuffer = "";
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
