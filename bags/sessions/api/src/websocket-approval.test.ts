import Database from "better-sqlite3";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";
import type { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";

const fixture = vi.hoisted(() => ({ db: null as Database.Database | null, effects: 0, bounded: true, reviewMode: "review_required" }));
vi.mock("@barry-rocks/sessions-bag/store/sessions-db", () => ({ getSessionsSqlite: () => fixture.db, sessionsDbPath: () => "websocket-approval-fixture" }));
vi.mock("./db.js", () => ({ getSessionRecord: async (id: string) => id === "session" ? { id, state: "open", metadata: { working_directory: "/tmp", review_policy: { mode: fixture.reviewMode } } } : undefined }));
// Ownership/admission negative controls live in execution-authorization tests.
vi.mock("@barry-rocks/sessions-bag/execution-authorization", () => ({ authorizeSessionExecution: async (principal: unknown) => principal }));
// The transcript projection has its own real-store tests; this fixture owns
// only execution tables and acknowledges its events during service cleanup.
vi.mock("./turn-history.js", () => ({ projectTurnHistory: async (store: TurnContinuations) => { for (const record of store.pendingHistory()) store.acknowledgeHistory(record.sequence); } }));
vi.mock("./session-runtime.js", () => ({ sessionRuntime: {
  getActiveSession: () => ({ id: "session", provider: "fixture", mcpServers: {}, pendingTurns: 0, session: null }),
  prepareHarnessConfiguration: async () => ({}),
  acquireTurnSlot: async () => ({ release() {} }),
  authorizeContinuationTool: async () => fixture.bounded ? { allow: true } : { allow: false, reason: "Denied by current session bounds" },
  subscribe: (id: string, socket: { send(value: string): void }) => socket.send(JSON.stringify({ type: "subscribed", sessionId: id, protocolVersion: 1, capabilities: { gating: true } })),
  unsubscribe() {}, unsubscribeAll() {}, broadcastSessionList() {},
} }));
vi.mock("./agent-runtime.js", () => ({
  getDescribeAdapter: () => () => ({ modes: { hosted: { guarantees: { gating: "per-call" }, approvalContinuation: "durable" } } }),
  openContinuation: async () => ({
    approvalContinuation: "durable", validate() {}, close: async () => {}, interrupt: async () => {},
    begin: async () => ({ type: "interrupted", calls: [{ id: "original", tool: "Write", input: { value: "original proposal" } }], continuation: { format: "fixture", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "fixture", payload: {} } }),
    restore: async (_checkpoint: unknown, decisions: ReadonlyMap<string, { allow: boolean }>, effects: { execute(call: unknown, effect: () => Promise<unknown>): Promise<unknown> }) => {
      if (decisions.get("original")?.allow) await effects.execute({ id: "original", tool: "Write", input: { value: "original proposal" } }, async () => { fixture.effects++; return { id: "original", result: "Applied" }; });
      return { type: "completed", result: "Finished" };
    },
  }),
}));

const { createWebSocketServer } = await import("./websocket.js");
const { closeTurnExecutions, turnExecutionService } = await import("./turn-execution.js");
let server: Server, wss: WebSocketServer, port: number, directory: string;
const secret = "websocket-approval-fixture-secret";

beforeAll(async () => {
  closeIdentitiesStore(); directory = mkdtempSync(join(tmpdir(), "barry-approval-owner-"));
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db")); vi.stubEnv("BARRY_SECRET", secret);
  owner.installation().provision({ username: "Approval fixture" });
  const db = fixture.db = new Database(":memory:"); db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('session');");
  db.exec(readFileSync(new URL("../../migrations/sessions/010_turn_continuations.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/sessions/011_turn_owner_process.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../../migrations/sessions/012_execution_history_projection.sql", import.meta.url), "utf8"));
  server = createServer(); wss = createWebSocketServer(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await closeTurnExecutions(); fixture.db?.close(); closeIdentitiesStore(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function connection() {
  const frames: Array<Record<string, unknown>> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, { headers: { Authorization: `Bearer ${secret}` } });
  socket.on("message", raw => { frames.push(JSON.parse(raw.toString())); });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "subscribe", sessionId: "session" }));
  await vi.waitFor(() => expect(frames.some(frame => frame.type === "subscribed")).toBe(true));
  // Wait for the asynchronous subscription to capture its starting cursor.
  await new Promise<void>(resolve => setImmediate(resolve));
  return { socket, frames };
}

describe("native approval through the compatibility WebSocket", () => {
  it("runs automatic-policy turns without emitting an interactive prompt", async () => {
    fixture.reviewMode = "automatic";
    const { socket, frames } = await connection();
    const before = fixture.effects;
    try {
      socket.send(JSON.stringify({ type: "message", sessionId: "session", content: "Automatic work" }));
      await vi.waitFor(() => expect(frames.some(frame => frame.type === "result" && frame.status === "completed")).toBe(true));
      expect(frames.some(frame => frame.type === "permission_request")).toBe(false);
      expect(fixture.effects).toBe(before + 1);
    } finally { socket.close(); fixture.reviewMode = "review_required"; }
  });
  it.each(["allow", "deny", "bounds", "expiry"])("executes only an allowed, bounded, unexpired original proposal: %s", async mode => {
    const { socket, frames } = await connection();
    const before = fixture.effects; fixture.bounded = true;
    try {
      socket.send(JSON.stringify({ type: "message", sessionId: "session", content: "Propose a write" }));
      await vi.waitFor(() => expect(frames.some(frame => frame.type === "permission_request")).toBe(true));
      const permission = frames.find(frame => frame.type === "permission_request")!;
      expect(permission).toMatchObject({ tool: "Write", input: { value: "original proposal" } });
      expect(fixture.effects).toBe(before);
      if (mode === "expiry") {
        fixture.db!.prepare("UPDATE session_interrupts SET expires_at='2000-01-01T00:00:00Z' WHERE status='pending'").run();
        const service = turnExecutionService();
        for (const turn of service.store.expireDue()) service.execution.recover(turn, undefined, true);
      } else {
        fixture.bounded = mode !== "bounds";
        socket.send(JSON.stringify({ type: "ruling", sessionId: "session", requestId: permission.requestId, decision: mode === "deny" ? "deny" : "allow" }));
        await vi.waitFor(() => expect(frames.some(frame => frame.type === "ruling_result" && frame.status === "applied")).toBe(true));
      }
      await vi.waitFor(() => expect(frames.some(frame => frame.type === "result" && frame.status === "completed")).toBe(true));
      expect(fixture.effects).toBe(before + (mode === "allow" ? 1 : 0));
      expect(turnExecutionService().store.active("session")).toBeUndefined();
    } finally { socket.close(); fixture.bounded = true; }
  });
});
