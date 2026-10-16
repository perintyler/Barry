import {envMs, withDeadline, DeadlineError} from "@barry-rocks/sdk/sessions";
import { PersistQueue } from "./persist-queue.js";
// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, log} from "../session-runtime.js";
import type { ActiveSession, SessionSubscriber, WsMessage } from "../session-runtime.js";
import {getDescribeAdapter} from "../agent-runtime.js";
import {appendMessage, getSessionMessages, shouldPersist, updateSessionRecord} from "../db.js";
import {type AuthPrincipal} from "@barry-rocks/sdk/internal/auth";
import {authorizeSessionExecution} from "@barry-rocks/sessions-bag/execution-authorization";

export function rt_subscribe(rt: SessionRuntime, sessionId: string, ws: SessionSubscriber, _options?: { protocolVersion?: number; afterSequence?: number }): void {
    const activeSession = rt.activeSessions.get(sessionId);
    const capabilities = {
      streaming: true,
      thinking: true,
      activity: true,
      gating: !!activeSession && (activeSession.session?.guarantees.gating ?? getDescribeAdapter()?.(activeSession.provider)?.modes.hosted?.guarantees.gating) === "per-call",
      listener: true,
      attachments: true,
    };
    if (activeSession) {
      activeSession.subscribers.add(ws);
      activeSession.session?.touch?.();
      if (activeSession.session?.isWarm?.() === false && !activeSession.abortController && !activeSession.pendingTurns) {
        if (activeSession.warm) delete activeSession.warm.preparedAt;
        void rt.warmHarness(sessionId);
      }
      if (activeSession.warm) delete activeSession.warm.idleSince;
      // Send current status, buffer, sequence, and versioned protocol handshake
      // capabilities. In turn: messages broadcast before this subscriber came
      // are not sent to it, so the handshake waits for them to be stored and
      // its sequence covers them. Status and buffer are as of now; everything
      // after this reaches the subscriber live.
      const finish=(stored: Record<string,unknown>[]=[])=>{
        const captured=activeSession.replaying?.get(ws)??[];
        activeSession.replaying?.delete(ws);
        rt.sendToClient(ws, { type: "subscribed", sessionId, status: activeSession.status,lastEventAt:activeSession.lastEventAt??null,
          ...(activeSession.lastSequence>=0 ? { sequence: activeSession.lastSequence } : {}), protocolVersion:1,capabilities });
        if (_options?.afterSequence!==undefined) {
          const seen=new Set<number>();
          for (const frame of [...stored,...(activeSession.turnFrames??[]),...rt.pendingPersistence(sessionId),...captured.filter(frame=>shouldPersist(frame.type))]) {
            const sequence=typeof frame.sequence === "number" ? frame.sequence : undefined;
            if (sequence!==undefined && sequence>_options.afterSequence && !seen.has(sequence)) {
              seen.add(sequence);if (ws.readyState===1) ws.send(JSON.stringify(frame));
            }
          }
        }
        if (activeSession.thinkingBuffer) rt.sendToClient(ws,{type:"thinking",sessionId,content:activeSession.thinkingBuffer});
        if (activeSession.outputBuffer) rt.sendToClient(ws,{type:"partial",sessionId,content:activeSession.outputBuffer});
        for (const frame of captured) if (["permission_request","ruling_result"].includes(frame.type)) rt.sendToClient(ws,frame);
      };
      if (_options?.afterSequence!==undefined) {
        if (!Number.isSafeInteger(_options.afterSequence) || _options.afterSequence<0) {activeSession.subscribers.delete(ws);return;}
        (activeSession.replaying??=new Map()).set(ws,[]);
        void (async()=>{
          await rt.flushPersistence(sessionId);
          const {messages}=await getSessionMessages(sessionId,{afterSequence:_options.afterSequence,limit:5000});
          if (activeSession.subscribers.has(ws)) finish(messages);
        })().catch(error=>{activeSession.replaying?.delete(ws);rt.sendToClient(ws,{type:"error",sessionId,error:`Replay failed: ${String(error)}`,metadata:{retryable:true}});});
      } else finish();
    } else {
      // Session not active in memory (e.g. after server restart).
      // Still respond so the client knows — history is available via REST.
      rt.sendToClient(ws, {
        type: "subscribed",
        sessionId,
        status: "inactive",
        protocolVersion: 1,
        capabilities,
      });
    }
  }

export function rt_unsubscribe(rt: SessionRuntime, sessionId: string, ws: SessionSubscriber): void {
    const activeSession = rt.activeSessions.get(sessionId);
    if (activeSession) {
      activeSession.subscribers.delete(ws);
      activeSession.replaying?.delete(ws);
      if (activeSession.warm && !activeSession.subscribers.size) activeSession.warm.idleSince = Date.now();
    }
  }

export function rt_unsubscribeAll(rt: SessionRuntime, ws: SessionSubscriber): void {
    for (const activeSession of rt.activeSessions.values()) {
      activeSession.subscribers.delete(ws);
      activeSession.replaying?.delete(ws);
      if (activeSession.warm && !activeSession.subscribers.size) activeSession.warm.idleSince = Date.now();
    }
  }

  /**
   * End the running turn, leaving the session open for the next message.
   *
   * A cooperative interrupt keeps the harness reusable. If its completion
   * deadline expires, force cancellation closes it and fences late events;
   * queued turns are invalidated in either case.
   * False when no turn is running or pending.
   */
export async function rt_interruptTurn(rt: SessionRuntime, sessionId: string, principal?: AuthPrincipal): Promise<boolean> {
    if (principal) await authorizeSessionExecution(principal, { sessionId });
    const activeSession = rt.activeSessions.get(sessionId);
    const controller = activeSession?.abortController;
    if (!activeSession || (!controller && activeSession.pendingTurns === 0)) return false;
    activeSession.interruptGeneration++;
    if (!controller) {
      activeSession.status = "waiting";
      rt.broadcastToSession(sessionId, { type: "status", sessionId, status: "waiting" });
      await updateSessionRecord(sessionId, { status: "pending" });
      return true;
    }
    activeSession.interruptedTurn = controller;
    controller.abort();
    // The turn's own loop interrupts too, but only between events; a turn
    // waiting on a long tool call would otherwise run until it produced one.
    const control=activeSession.turnControl;
    const request=Promise.resolve().then(()=>activeSession.session?.interrupt());
    void request.catch(error=>log.warn("session.interrupt_failed",{sessionId,error:String(error)}));
    if (control) {
      try { await withDeadline(control.done,envMs("BARRY_INTERRUPT_DEADLINE_MS",10_000)); }
      catch(error) { if(!(error instanceof DeadlineError))throw error; await rt.forceTurn(activeSession); }
    }
    return true;
  }

  /**
   * Emit a delivery-state change for an already-persisted user message.
   *
   * This event is intentionally not persisted from here. The delivery row is
   * already written in the route/db path; this is only for live subscribers.
   */
export function rt_publishDeliveryUpdate(rt: SessionRuntime, 
    sessionId: string,
    update: {
      messageId: string;
      clientMessageId?: string;
      deliveryState: "queued" | "accepted" | "failed" | "uncertain";
      deliveryError?: string | null;
    },
  ): void {
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) return;

    const message: WsMessage = {
      type: "delivery_update",
      sessionId,
      messageId: update.messageId,
      clientMessageId: update.clientMessageId,
      deliveryState: update.deliveryState,
      deliveryError: update.deliveryError ?? null,
    };

    rt.sendInTurn(activeSession, message);
  }

export function rt_broadcastToSession(rt: SessionRuntime, sessionId: string, message: WsMessage): void {
    const activeSession = rt.activeSessions.get(sessionId);
    if (!activeSession) return;

    // Mark anything emitted while handling a subagent event, unless the caller
    // already set it explicitly.
    if (rt.currentProvenance && message.parentToolUseId === undefined) {
      message.parentToolUseId = rt.currentProvenance;
    }

    if (!shouldPersist(message.type) || message.reuseClientMessageRow) {
      rt.sendInTurn(activeSession, message);
      return;
    }

    // This owner allocates the wire sequence synchronously. A tool result
    // folds into its tool row and has no new durable row of its own.
    message.createdAt ??= new Date().toISOString();
    message.dedupeKey ??= `engine:${crypto.randomUUID()}`;
    if (message.type !== "tool_result") message.sequence = ++activeSession.lastSequence;
    (activeSession.turnFrames ??= []).push(message);
    rt.sendInTurn(activeSession, message);
    const timer=activeSession.turnTimer;
    activeSession.persistence ??= new PersistQueue((lagging, error) => {
      if (error) log.error(/UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i.test(String(error)) ? "ws.sequence_conflict" : "ws.persist_error", { sessionId, error: String(error) });
      rt.publishPersistenceHealth(sessionId,"messages",lagging);
    });
    activeSession.persistence.enqueue(message, Buffer.byteLength(JSON.stringify(message)), async () => {
      const started=performance.now();
      const persistedSequence=await appendMessage(sessionId, message, activeSession.sessionId, {
        provider: activeSession.provider, model: activeSession.model, channel: "engine",
      });
      if (typeof message.sequence==="number" && typeof persistedSequence==="number" && persistedSequence!==message.sequence) {
        const oldSequence=message.sequence;
        message.sequence=persistedSequence;activeSession.lastSequence=Math.max(activeSession.lastSequence,persistedSequence);
        log.error("ws.sequence_conflict",{sessionId,oldSequence,newSequence:persistedSequence});
        rt.sendInTurn(activeSession,{type:"delivery_update",sessionId,metadata:{code:"sequence_reassigned",oldSequence,newSequence:persistedSequence,dedupeKey:message.dedupeKey}});
      }
      timer?.sample("persist", performance.now()-started);
      const clientMessageId=message.metadata?.clientMessageId;
      if (message.type==="text" && message.role==="user" && typeof clientMessageId==="string") activeSession.acceptedMessages?.delete(clientMessageId);
    });
  }

  /**
   * Send a session message to the subscribers it had when it was broadcast,
   * in turn behind everything broadcast before it. `append`, when given,
   * stores the message first: it goes out carrying the sequence the store
   * gave it, or none when the store kept no row of its own (a tool result is
   * folded into its call), as every message the store does not keep does.
   */
export function rt_sendInTurn(rt: SessionRuntime, activeSession: ActiveSession, message: WsMessage, append?: () => Promise<number | null>): void {
    message.lastEventAt=activeSession.lastEventAt??null;
    const at = performance.now();
    Object.defineProperty(message, "__at", { value: at, enumerable: false, configurable: true });
    const timer = activeSession.turnTimer;
    const recipients = [...activeSession.subscribers];
    const send = () => {
      if (message.type === "status" && message.status === "waiting" && timer) {
        message.metadata = { ...message.metadata, timing: { ...(message.metadata?.timing as Record<string, number> ?? {}), ...timer.summary() } };
      }
      const data = JSON.stringify(message);
      for (const ws of recipients) {
        // WebSocket.OPEN, and still subscribed: one that left while this
        // waited its turn has stopped listening.
        if (ws.readyState === 1 && activeSession.subscribers.has(ws)) {
          const replay=activeSession.replaying?.get(ws);
          if (replay) {replay.push(message);continue;}
          const sent = (receipt?:{bytes?:number;queuedAt?:number;coalesced?:number;skipPhysical?:boolean;queueWaitMs?:number;sendCallbackMs?:number}) => {
            if (receipt?.skipPhysical) return;
            if(receipt?.queueWaitMs!==undefined)timer?.sample("ws_queue",receipt.queueWaitMs);
            if(receipt?.sendCallbackMs!==undefined)timer?.sample("ws_callback",receipt.sendCallbackMs);
            timer?.sent(receipt?.bytes??Buffer.byteLength(data), at, message.type === "partial" || message.type === "thinking");
            if (receipt?.coalesced) timer?.count("coalesced_frames",receipt.coalesced);
          };
          if (ws.publish) ws.publish(data, sent); else { ws.send(data); sent(); }
        }
      }
    };
    rt.inTurn(activeSession.id, send, append && (async () => {
      const started = performance.now();
      const sequence = await append();
      timer?.sample("persist", performance.now() - started);
      if (sequence !== null) {
        message.sequence = sequence;
        activeSession.lastSequence = sequence;
      }
    }));
  }

  /**
   * Run `send` once everything queued for the session before it has gone
   * out, after `store` when one is given. With nothing queued and nothing to
   * store it runs now, as a send always used to; a message being stored
   * queues, so what is broadcast after it waits for the store too, and the
   * order on the wire is the order in the store.
   */
export function rt_inTurn(rt: SessionRuntime, sessionId: string, send: () => void, store?: () => Promise<void>): void {
    const previous = rt.outboxes.get(sessionId);
    if (!previous && !store) {
      send();
      return;
    }
    const next = (previous ?? Promise.resolve()).then(async () => {
      await store?.();
      send();
    }).catch((err) => {
      // A failed send must not stall the session's chain.
      log.error("ws.send_error", { sessionId, error: err instanceof Error ? err.message : String(err) });
    });
    rt.outboxes.set(sessionId, next);
    // Drop the entry once this session's chain has fully drained, so the map
    // does not retain one promise per session that ever streamed.
    void next.then(() => {
      if (rt.outboxes.get(sessionId) === next) rt.outboxes.delete(sessionId);
    });
  }

export function rt_broadcastSessionList(rt: SessionRuntime, ws?: SessionSubscriber): void {
    const sessions = rt.getActiveSessions().filter((s) => !s.unlisted).map((s) => ({
      id: s.id,
      sessionId: s.sessionId,
      name: s.name,
      repoPath: s.repoPath,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastEventAt:s.lastEventAt??null,
    }));

    const message: WsMessage = { type: "session_list", sessions };

    if (ws) {
      rt.sendToClient(ws, message);
    } else {
      const allSubscribers = new Set<SessionSubscriber>();
      for (const activeSession of rt.activeSessions.values()) {
        for (const sub of activeSession.subscribers) {
          allSubscribers.add(sub);
        }
      }
      for (const sub of allSubscribers) {
        rt.sendToClient(sub, message);
      }
    }
  }

export function rt_sendToClient(rt: SessionRuntime, ws: SessionSubscriber, message: WsMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
