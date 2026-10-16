import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgUiEvent } from "@barry-rocks/sdk/apps";
import type { CredentialAuthorization } from "@barry-rocks/sdk/internal/auth";

const fixture = vi.hoisted(() => ({ listeners: new Set<()=>void>(), records: [] as Array<{ sequence: number; turnId: string; runId: string; event: Record<string, unknown> }> }));
vi.mock("@barry-rocks/sessions-bag/store/turn-continuations",async importOriginal=>({
  ...await importOriginal<typeof import("@barry-rocks/sessions-bag/store/turn-continuations")>(),
  watchTurnEvents: (_id:string,fn:()=>void)=>{fixture.listeners.add(fn);return ()=>{fixture.listeners.delete(fn);};},
}));
vi.mock("./ag-ui-snapshot.js", () => ({ agUiSnapshot: async (id: string) => {
  if (id !== "session") throw new Error("Session not found");
  return { threadId: id, cursor: 3, messages: [] };
} }));
vi.mock("./turn-execution.js", () => ({ turnExecutionService: () => ({ store: { replay: (_session: string, after: number) => {
  if (after === 99) throw new Error("Replay cursor does not belong to this session");
  return fixture.records.filter((record) => record.sequence >= after);
} } }) }));
const { attachAgUiSubscription } = await import("./ag-ui-websocket.js");

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.emit("close"); });
  send(bytes: string) { this.sent.push(JSON.parse(bytes)); }
  request(body: unknown) { this.emit("message", Buffer.from(JSON.stringify(body))); }
}
const sockets: Socket[] = [];
afterEach(() => { for (const ws of sockets.splice(0)) ws.close(); fixture.records = []; });
function socket(): Socket {
  const ws = new Socket(); sockets.push(ws);
  const authorization: CredentialAuthorization = {
    principal: { kind: "installation", actorId: 1, credentialId: "installation" },
    revalidate: async () => true, authorize: async () => true, dispose: () => {},
  };
  attachAgUiSubscription(ws, authorization);
  return ws;
}

describe("AG-UI native subscription", () => {
  it("takes a consistent snapshot and replays the rest of a partially received event batch", async () => {
    const first = socket(); first.request({ type: "subscribe", sessionId: "session" });
    await vi.waitFor(() => expect(first.sent[0]).toMatchObject({ type: "snapshot", snapshot: { cursor: 3 } }));
    fixture.records.push({ sequence: 4, turnId: "turn", runId: "run", event: { type: "tool_use", id: "original", tool: "write", input: { value: "exact" } } });
    for (const notify of fixture.listeners) notify();
    await vi.waitFor(() => expect(first.sent).toHaveLength(4));
    const reconnect = socket(); reconnect.request({ type: "subscribe", sessionId: "session", after: "4:0" });
    await vi.waitFor(() => expect(reconnect.sent).toHaveLength(2));
    expect(reconnect.sent.map((frame) => frame.cursor)).toEqual(["4:1", "4:2"]);
    expect(reconnect.sent.map((frame) => parseAgUiEvent(frame.event).type)).toEqual(["TOOL_CALL_ARGS", "TOOL_CALL_END"]);
    reconnect.request({ type: "unsubscribe" });
  });

  it("refuses missing sessions and foreign cursors and disconnects a slow consumer", async () => {
    const missing = socket(); missing.request({ type: "subscribe", sessionId: "foreign" });
    await vi.waitFor(() => expect(missing.sent[0]).toMatchObject({ type: "error", message: "Invalid subscription request" }));
    const invalid = socket(); invalid.request({ type: "subscribe", sessionId: "session", after: "99:0" });
    await vi.waitFor(() => expect(invalid.sent[0]).toMatchObject({ type: "error", message: "Invalid subscription request" }));
    const slow = socket(); slow.bufferedAmount = 2 * 1024 * 1024;
    slow.request({ type: "subscribe", sessionId: "session" });
    await vi.waitFor(() => expect(slow.close).toHaveBeenCalledWith(1013, expect.stringContaining("reconnect")));
    expect(slow.sent).toEqual([]);
  });
});
