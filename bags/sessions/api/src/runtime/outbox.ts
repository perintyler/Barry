// Method bodies extracted from session-runtime.ts for file size.
// Moved verbatim as free functions taking the runtime instance (`rt`);
// the SessionRuntime class delegates to these. Pure move + rewire.
import {SessionRuntime, log} from "../session-runtime.js";
import type { ActiveSession, SessionSubscriber, WsMessage } from "../session-runtime.js";
import {getDescribeAdapter} from "../agent-runtime.js";
import {appendMessage, shouldPersist, updateSessionRecord} from "../db.js";
import {type AuthPrincipal} from "@barry-rocks/sdk/internal/auth";
import {authorizeSessionExecution} from "@barry-rocks/sessions-bag/execution-authorization";

export function rt_subscribe(rt: SessionRuntime, sessionId: string, ws: SessionSubscriber, _options?: { protocolVersion?: number }): void {
    const activeSession = rt.activeSessions.get(sessionId);
    const capabilities = {
      streaming: true,
      gating: !!activeSession && (activeSession.session?.guarantees.gating ?? getDescribeAdapter()?.(activeSession.provider)?.modes.hosted?.guarantees.gating) === "per-call",
      listener: true,
      attachments: true,
    };
    if (activeSession) {
      activeSession.subscribers.add(ws);
      // Send current status, buffer, sequence, and versioned protocol handshake
      // capabilities. In turn: messages broadcast before this subscriber came
      // are not sent to it, so the handshake waits for them to be stored and
      // its sequence covers them. Status and buffer are as of now; everything
      // after this reaches the subscriber live.
      const { status, outputBuffer } = activeSession;
      rt.inTurn(sessionId, () => {
        rt.sendToClient(ws, {
          type: "subscribed",
          sessionId,
          status,
          sequence: activeSession.lastSequence,
          protocolVersion: 1,
          capabilities,
        });
        if (outputBuffer) {
          rt.sendToClient(ws, {
            type: "partial",
            sessionId,
            content: outputBuffer,
          });
        }
      });
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
    }
  }

export function rt_unsubscribeAll(rt: SessionRuntime, ws: SessionSubscriber): void {
    for (const activeSession of rt.activeSessions.values()) {
      activeSession.subscribers.delete(ws);
    }
  }

  /**
   * End the running turn, leaving the session open for the next message.
   *
   * Unlike stopSession, nothing is closed and the generation is not bumped:
   * the turn ends as a finished one does — resting, "waiting" broadcast — so a
   * client waiting on it learns it is over. Queued turns are invalidated too.
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
    await activeSession.session?.interrupt().catch(() => {});
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

    // Stored first, then sent with the sequence the store gave it: a client
    // that reads the transcript finds every live message under the number it
    // was sent with. Always use the Barry canonical session ID, and the
    // session's resolved provider/model. The SDK stream does not report a
    // per-message model, so this is the most precise attribution available —
    // and it is correct per turn, since a model change starts a new session.
    //
    // In turn per session rather than fired independently (see `inTurn`).
    // Appends used to overlap: each awaits model resolution and its own
    // INSERT, so a `tool_result` could reach its correlation lookup while the
    // matching `tool_start` had not yet inserted a row — finding neither a
    // pending entry nor a committed row, it returned successfully having
    // saved nothing. And the store numbers a message when its insert runs, so
    // overlapping appends would also number them out of the order they were
    // sent in. (messages.ts also retains an unmatched result as a second line
    // of defense, for callers that persist out of order.)
    rt.sendInTurn(activeSession, message, async () => {
      try {
        return await appendMessage(sessionId, message, activeSession.sessionId, {
          provider: activeSession.provider,
          model: activeSession.model,
          // `engine`: Barry held the agent's handle and saw this event
          // directly — the only channel that is complete by construction.
          //
          // This is the write path for EVERY tool call and most assistant
          // text, so its omission was most of the NULLs: 15,210 of the
          // 18,000 rows written in the three hours after the store restart,
          // including all 10,901 `tool_call` rows. `channel-recording.sh`
          // still reported PASS on the transcript rows beside them, which is
          // why the gap survived a check written to find exactly rt.
          channel: "engine",
        });
      } catch (err) {
        // Still sent: a subscriber should see what the agent did even when
        // the store could not keep it.
        log.error("ws.persist_error", { sessionId, type: message.type, error: err instanceof Error ? err.message : String(err) });
        return null;
      }
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
    const recipients = [...activeSession.subscribers];
    const send = () => {
      const data = JSON.stringify(message);
      for (const ws of recipients) {
        // WebSocket.OPEN, and still subscribed: one that left while this
        // waited its turn has stopped listening.
        if (ws.readyState === 1 && activeSession.subscribers.has(ws)) ws.send(data);
      }
    };
    rt.inTurn(activeSession.id, send, append && (async () => {
      const sequence = await append();
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
