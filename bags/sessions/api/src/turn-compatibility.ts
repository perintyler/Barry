import { watchTurnEvents } from "@barry-rocks/sessions-bag/store/turn-continuations";
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

interface CompatibilityHub { sockets:Set<SessionSubscriber>; stop():void }
const hubs=new WeakMap<TurnContinuations,Map<string,CompatibilityHub>>();

/** One event-driven reader per store/session, shared by all native subscribers. */
export function subscribeCompatibilityTurns(store:TurnContinuations,sessionId:string,socket:SessionSubscriber):()=>void {
  const sessions=hubs.get(store)??new Map<string,CompatibilityHub>();hubs.set(store,sessions);
  let hub=sessions.get(sessionId);
  const send=(target:SessionSubscriber,message:WsMessage)=>{if(target.readyState===1) target.send(JSON.stringify(message));};
  if (!hub) {
    let cursor=store.cursor(sessionId), stopped=false, scheduled=false;
    let timer:NodeJS.Timeout|undefined;
    const sockets=new Set<SessionSubscriber>();
    let unwatch=()=>{};
    const stop=()=>{stopped=true;if(timer)clearTimeout(timer);unwatch();if(sessions.get(sessionId)===hub)sessions.delete(sessionId);};
    const pump=()=>{
      scheduled=false;if(stopped)return;
      if(timer)clearTimeout(timer);
      try {
        const records=store.replay(sessionId,cursor,128);
        for(const record of records) {
          for(const message of compatibilityMessages(sessionId,record.event)) {
            const frame={...message,metadata:{turnId:record.turnId,runId:record.runId,executionSequence:record.sequence}};
            for(const target of sockets) send(target,frame);
          }
          cursor=record.sequence;
        }
        if(store.active(sessionId)){timer=setTimeout(pump,records.length>=128?0:1000);timer.unref();}
      } catch {
        for(const target of sockets)send(target,{type:"error",sessionId,error:"Execution subscription failed"});stop();
      }
    };
    unwatch=watchTurnEvents(sessionId,()=>{if(!scheduled&&!stopped){scheduled=true;queueMicrotask(pump);}});
    hub={sockets,stop};sessions.set(sessionId,hub);
    if(store.active(sessionId)){timer=setTimeout(pump,1000);timer.unref();}
  }
  hub.sockets.add(socket);
  const turn=store.active(sessionId);
  if(turn?.state==="waiting_for_input") {
    send(socket,{type:"status",sessionId,status:"waiting_for_input"});
    for(const message of compatibilityMessages(sessionId,{type:"segment_interrupted",snapshot:{...turn,interrupts:store.pendingRulings(sessionId,turn.id)}}))send(socket,message);
  }
  return ()=>{hub!.sockets.delete(socket);if(!hub!.sockets.size)hub!.stop();};
}
