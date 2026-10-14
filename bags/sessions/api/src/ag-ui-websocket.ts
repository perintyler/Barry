import { AgUiSubscriptionRequestSchema, projectAgUi, type ExecutionEvent, type AgUiSubscriptionDelivery } from "@barry-rocks/sdk/apps";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";

import { turnExecutionService } from "./turn-execution.js";
import { agUiSnapshot } from "./ag-ui-snapshot.js";
import type { CredentialAuthorization } from "@barry-rocks/sdk/internal/auth";
import { authorizeSessionRead } from "./request-authorization.js";

/** Barry subscription framing over the same committed source as SSE. */
/** The parts of a `ws` socket a subscription uses. */
export interface AgUiSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error", listener: () => void): unknown;
  on(event: "message", listener: (data: { toString(): string }) => void): unknown;
}

export function attachAgUiSubscription(ws: AgUiSocket, authorization: CredentialAuthorization): void {
  let timer: NodeJS.Timeout | undefined; let generation = 0; let handling = false;
  let controller = new AbortController();
  const stop = () => { generation++; controller.abort(); if (timer) clearTimeout(timer); timer = undefined; };
  const close = (code: number, reason: string) => { stop(); authorization.dispose(); ws.close(code, reason); };
  const send = (value: AgUiSubscriptionDelivery): boolean => {
    if (ws.readyState !== 1) return false;
    const bytes = JSON.stringify(value);
    if (ws.bufferedAmount + Buffer.byteLength(bytes) > 2 * 1024 * 1024) {
      close(1013, "Consumer is behind; reconnect from the last cursor"); return false;
    }
    ws.send(bytes); return true;
  };
  ws.on("close", stop);
  ws.on("error", stop);
  ws.on("message", async (data) => {
    if (handling) { close(1008, "Subscription request already in progress"); return; }
    handling = true;
    try {
      const request = AgUiSubscriptionRequestSchema.parse(JSON.parse(data.toString()));
      stop();
      if (request.type === "unsubscribe") return;
      controller = new AbortController();
      const signal = controller.signal;
      const ownGeneration = generation;
      const allowed = async () => {
        if (ownGeneration !== generation || ws.readyState !== 1) return false;
        const valid = await authorization.authorize({
          scopes: ["sessions:read", "events:read", "events:subscribe"],
          authorize: (principal, signal) => authorizeSessionRead(principal, request.sessionId, signal),
        }, signal);
        if (ownGeneration !== generation || ws.readyState !== 1) return false;
        if (!valid) { close(1008, "Subscription forbidden"); return false; }
        return true;
      };
      if (!await allowed()) return;
      await withStoreContext({ identity: sessionIdentity(request.sessionId) }, async () => {
        const snapshot = await agUiSnapshot(request.sessionId);
        if (ownGeneration !== generation || ws.readyState !== 1) return;
        const store = turnExecutionService().store;
        const parts = request.after?.split(":").map(Number);
        let sequence = parts?.[0] ?? snapshot.cursor;
        let index = parts?.[1] ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(index)) throw new Error("Invalid replay cursor");
        store.replay(request.sessionId, sequence, 1, true);
        // A fresh subscriber gets a consistent snapshot/cursor. Reconnecting
        // clients replay after their acknowledged frame without replacing it.
        if (request.after === undefined && (!await allowed() || !send({ type: "snapshot", sessionId: request.sessionId, snapshot }))) return;
        const pump = async () => {
          if (ownGeneration !== generation || ws.readyState !== 1) return;
          try {
            if (!await allowed()) return;
            const records = store.replay(request.sessionId, sequence, 128, true);
            for (const record of records) {
              const events = projectAgUi(request.sessionId, record as ExecutionEvent);
              for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
                if (record.sequence === sequence && eventIndex <= index) continue;
                if (!await allowed()) return;
                if (!send({ type: "event", sessionId: request.sessionId, cursor: `${record.sequence}:${eventIndex}`, event: events[eventIndex] })) return;
                sequence = record.sequence; index = eventIndex;
              }
              sequence = record.sequence; index = Number.MAX_SAFE_INTEGER;
            }
            if (ownGeneration === generation && ws.readyState === 1) {
              timer = setTimeout(() => { void pump(); }, records.length >= 128 ? 0 : 150); timer.unref();
            }
          } catch { close(1011, "Event subscription failed"); }
        };
        void pump();
      });
    } catch {
      if (await authorization.revalidate()) send({ type: "error", message: "Invalid subscription request" });
      else close(1008, "Authorization unavailable");
    } finally { handling = false; }
  });
}
