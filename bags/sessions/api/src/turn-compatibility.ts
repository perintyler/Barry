import type { SessionEvent, TurnSnapshot } from "@barry-rocks/sdk/sessions";
import type { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";
import type { SessionSubscriber, WsMessage } from "./session-runtime.js";

/** A wire projection of committed execution, with no approval state of its own. */
export function compatibilityMessages(sessionId: string, event: unknown, now = Date.now()): WsMessage[] {
  const value = event as SessionEvent | { type: "segment_started" } | { type: "segment_interrupted" | "turn_finished"; snapshot: TurnSnapshot };
  switch (value.type) {
    case "segment_started": return [{ type: "status", sessionId, status: "running" }];
    case "partial": return [{ type: "partial", sessionId, content: value.text }];
    case "tool_use": return [{ type: "tool_use", sessionId, toolUseId: value.id, name: value.tool, input: value.input }];
    case "tool_result": return [{ type: "tool_result", sessionId, toolUseId: value.id, result: typeof value.result === "string" ? value.result : JSON.stringify(value.result) }];
    case "segment_interrupted": return value.snapshot.reviewPolicy.mode === "automatic" ? [] : value.snapshot.interrupts.filter((item) => item.status === "pending").map((item) => ({
      type: "permission_request", sessionId, requestId: item.id, tool: item.call.tool, input: item.call.input,
      ...(item.call.description ? { content: item.call.description } : {}),
      ...(item.expiresAt ? { timeoutMs: Math.max(0, Date.parse(item.expiresAt) - now) } : {}),
    }));
    case "turn_finished": return [{ type: "result", sessionId, status: value.snapshot.state, ...(value.snapshot.error ? { error: value.snapshot.error } : {}) }, { type: "status", sessionId, status: "waiting" }];
    case "error": return [{ type: "error", sessionId, error: value.error }];
    default: return [];
  }
}

/** The socket publisher bounds its queue and reverifies each native send. */
export function subscribeCompatibilityTurns(store: TurnContinuations, sessionId: string, socket: SessionSubscriber): () => void {
  let cursor = store.cursor(sessionId), stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const send = (message: WsMessage) => socket.send(JSON.stringify(message));
  const turn = store.active(sessionId);
  if (turn?.state === "waiting_for_input") {
    send({ type: "status", sessionId, status: "waiting_for_input" });
    for (const message of compatibilityMessages(sessionId, { type: "segment_interrupted", snapshot: { ...turn, interrupts: store.pendingRulings(sessionId, turn.id) } })) send(message);
  }
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
  const pump = () => {
    if (stopped || socket.readyState !== 1) { stop(); return; }
    try {
      const records = store.replay(sessionId, cursor, 128);
      for (const record of records) {
        for (const message of compatibilityMessages(sessionId, record.event)) send({ ...message, metadata: { turnId: record.turnId, runId: record.runId, executionSequence: record.sequence } });
        cursor = record.sequence;
      }
      timer = setTimeout(pump, records.length >= 128 ? 0 : 150); timer.unref();
    } catch { send({ type: "error", sessionId, error: "Execution subscription failed" }); stop(); }
  };
  pump();
  return stop;
}
