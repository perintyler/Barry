import { authorizeRequest } from "@barry-rocks/sdk/internal/auth";
import express from "express";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { Barry } from "@barry-rocks/sdk";
import { identities, owner } from "@barry-rocks/identities-bag";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TurnExecution } from "@barry-rocks/sdk/sessions";
import { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";
import type { RunAgentInput } from "@barry-rocks/sdk/apps";

const SECRET = "test-secret-ag-ui-stream";
process.env.BARRY_SECRET = SECRET;

const mock = vi.hoisted(() => ({
  service: null as { store: TurnContinuations; execution: TurnExecution } | null,
  effects: 0,
}));

vi.mock("../turn-execution.js", () => ({
  turnExecutionService: () => mock.service,
  prepareTurnSession: async () => ({ provider: "fixture" }),
}));

vi.mock("../agent-runtime.js", () => ({
  getDescribeAdapter: () => () => ({ modes: { hosted: { approvalContinuation: "durable", guarantees: { gating: "per-call" } } } }),
}));

vi.mock("../session-runtime.js", () => ({
  sessionRuntime: {
    prepareTurnAttachments: vi.fn(async () => ""),
    broadcastSessionList: vi.fn(),
  },
}));

vi.mock("../db.js", () => ({
  getSessionRecord: async (id: string) =>
    id.startsWith("session") ? { id, metadata: {}, active: true, state: "open" } : null,
  listSessionRecords: vi.fn().mockResolvedValue([]),
  updateSessionRecord: vi.fn(),
  getSessionMessages: vi.fn(),
  buildSessionHistoryContext: vi.fn(),
}));

vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return { ...actual, owner: { ...actual.owner, current: async () => ({ id: 1 }), users: { ...actual.owner.users, get: async () => ({ id: 1 }) } } };
});

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: async (id: string) => id.startsWith("session") ? { id, metadata: {}, active: true, state: "open" } : null,
  queuePrompt: vi.fn(),
  getMessageByClientMessageId: vi.fn(),
  recordPromptDelivery: vi.fn(),
  updatePromptDeliveryByClientMessageId: vi.fn(),
  claimFailedPromptRetry: vi.fn(),
  getListeners: vi.fn().mockResolvedValue({}),
  Sessions: {
    createInert: vi.fn(),
    getName: vi.fn().mockReturnValue("test session"),
  },
  Processes: {
    recordStart: vi.fn(),
    markEnded: vi.fn(),
    getLive: vi.fn().mockResolvedValue(null),
  },
  Messages: { deleteOlderThan: vi.fn() },
}));

const { createAgUiRouter, closeAgUiStreams } = await import("./ag-ui.js");
const { sessionLifecycleRouter } = await import("./session-lifecycle.js");
const { createWebSocketServer } = await import("../websocket.js");

interface SseFrame {
  id?: string;
  data: { type?: string } & Record<string, unknown>;
}

async function readSseStream(response: Response): Promise<SseFrame[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body reader");
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (!block.trim()) continue;
      let id: string | undefined;
      let dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4).trim();
        else if (line.startsWith("data: ")) dataStr += (dataStr ? "\n" : "") + line.slice(6);
      }
      if (dataStr) {
        try {
          frames.push({ id, data: JSON.parse(dataStr) });
        } catch {
          // ignore unparseable comment/keepalive
        }
      }
    }
  }
  return frames;
}

describe("AG-UI SSE Wire Streaming Acceptance & Protocol v1 Sunset Gate", () => {
  let server: Server;
  let url: string;
  let wsUrl: string;
  let db: Database.Database;
  let identitiesDirectory: string;
  let wss: WebSocketServer;

  beforeAll(async () => {
    closeIdentitiesStore();
    identitiesDirectory = mkdtempSync(join(tmpdir(), "barry-ag-ui-protocol-owner-"));
    vi.stubEnv("BARRY_IDENTITIES_DB", join(identitiesDirectory, "identities.db"));
    owner.installation().provision({ username: "Protocol fixture" });
    // Installed as the service installs them: the real subjects over this store.
    Barry.use(identities, sessions);
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES
        ('session-stream'),
        ('session-tools'),
        ('session-queued-json'),
        ('session-queued-stream'),
        ('session-sunset');
    `);
    db.exec(readFileSync(new URL("../../../migrations/sessions/010_turn_continuations.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../../../migrations/sessions/011_turn_owner_process.sql", import.meta.url), "utf8"));

    const store = new TurnContinuations(db);
    const execution = new TurnExecution({
      store,
      authorize: async () => ({ allow: true }),
      openHarness: async () => ({
        approvalContinuation: "durable",
        validate: () => {},
        close: async () => {},
        interrupt: async () => {},
        begin: async (input, emit) => {
          const text = typeof input === "string" ? input : JSON.stringify(input);
          if (text.includes("pause-me")) {
            await emit({ type: "tool_use", id: "call-1", tool: "ask_permission", input: { action: "deploy" } });
            return {
              type: "interrupted",
              calls: [{ id: "call-1", tool: "ask_permission", input: { action: "deploy" } }],
              continuation: {
                format: "fixture",
                version: 1,
                adapterId: "fixture",
                adapterVersion: "1",
                harnessVersion: "1",
                configFingerprint: "config",
                payload: {},
              },
            };
          }
          if (text.includes("with-tools")) {
            await emit({ type: "tool_use", id: "calc-1", tool: "calc", input: { expr: "1+1" } });
            await emit({ type: "tool_result", id: "calc-1", result: "2" });
            await emit({ type: "partial", text: "Calculated 2" });
            return { type: "completed", result: "Calculated 2" };
          }
          await emit({ type: "partial", text: "Chunk 1" });
          await emit({ type: "partial", text: "Chunk 2" });
          return { type: "completed", result: "Chunk 1Chunk 2" };
        },
        restore: async (_checkpoint, decisions, effects, emit) => {
          if (decisions.get("call-1")?.allow) {
            await effects.execute({ id: "call-1", tool: "ask_permission", input: { action: "deploy" } }, async () => {
              mock.effects++;
              return { id: "call-1", result: "Allowed" };
            });
          }
          await emit({ type: "tool_result", id: "call-1", result: "Allowed" });
          await emit({ type: "partial", text: "Finished resume" });
          return { type: "completed", result: "Finished resume" };
        },
      }),
    });
    mock.service = { store, execution };

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.headers.authorization = "Bearer protocol-fixture"; next(); });
    app.use(authorizeRequest({ verifyCredential: () => ({ kind: "installation", actorId: 1, credentialId: "installation" }), policy: () => null }));
    app.use("/api/v1/sessions", sessionLifecycleRouter);
    app.use("/api/v2/sessions", createAgUiRouter());

    server = createServer(app);
    wss = createWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    url = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    closeAgUiStreams();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await mock.service?.execution.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    Barry.reset();
    closeIdentitiesStore(); vi.unstubAllEnvs();
    rmSync(identitiesDirectory, { recursive: true, force: true });
  });

  describe("AG-UI SSE Wire Streaming Acceptance", () => {
    it("connects end-to-end via SSE and streams RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED", async () => {
      const sessionId = "session-stream";
      const runId = "stream-run-1";
      const payload: RunAgentInput = {
        threadId: sessionId,
        runId,
        messages: [{ id: "msg-1", role: "user", content: "Tell me a story" }],
        tools: [],
        context: [],
      };

      const res = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-barry-turn-id")).toBeTruthy();

      const frames = await readSseStream(res);
      expect(frames.length).toBeGreaterThanOrEqual(4);

      // Verify sequence and types of streamed wire events
      expect(frames[0].data).toMatchObject({
        type: "RUN_STARTED",
        threadId: sessionId,
        runId,
      });
      expect(frames[1].data).toMatchObject({
        type: "TEXT_MESSAGE_CHUNK",
        messageId: `${runId}:assistant`,
        role: "assistant",
        delta: "Chunk 1",
      });
      expect(frames[2].data).toMatchObject({
        type: "TEXT_MESSAGE_CHUNK",
        messageId: `${runId}:assistant`,
        role: "assistant",
        delta: "Chunk 2",
      });
      expect(frames[3].data).toMatchObject({
        type: "RUN_FINISHED",
        threadId: sessionId,
        runId,
      });

      // Verify stable event id cursor format sequence:index
      expect(frames[0].id).toMatch(/^\d+:\d+$/);
    });

    it("emits tool call event chunks over SSE wire stream", async () => {
      const sessionId = "session-tools";
      const runId = "stream-run-tools";
      const payload: RunAgentInput = {
        threadId: sessionId,
        runId,
        messages: [{ id: "msg-tools", role: "user", content: "Calculate with-tools" }],
        tools: [],
        context: [],
      };

      const res = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const frames = await readSseStream(res);
      const eventTypes = frames.map((f) => f.data.type);

      expect(eventTypes).toContain("RUN_STARTED");
      expect(eventTypes).toContain("TOOL_CALL_START");
      expect(eventTypes).toContain("TOOL_CALL_ARGS");
      expect(eventTypes).toContain("TOOL_CALL_END");
      expect(eventTypes).toContain("TOOL_CALL_RESULT");
      expect(eventTypes).toContain("TEXT_MESSAGE_CHUNK");
      expect(eventTypes).toContain("RUN_FINISHED");
    });

    it("handles queued turn delivery with 202 Accepted when not requesting SSE stream", async () => {
      const sessionId = "session-queued-json";

      // Step 1: Start a turn that pauses on interrupt (leaving session active in waiting_for_input)
      const pauseRunId = "pause-run-1";
      const pausePayload: RunAgentInput = {
        threadId: sessionId,
        runId: pauseRunId,
        messages: [{ id: "msg-pause", role: "user", content: "Please pause-me" }],
        tools: [],
        context: [],
      };

      const pauseRes = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(pausePayload),
      });
      const pauseFrames = await readSseStream(pauseRes);
      expect(pauseFrames.at(-1)?.data).toMatchObject({
        type: "RUN_FINISHED",
        outcome: { type: "interrupt" },
      });

      // Step 2: Fetch committed snapshot messages
      const snapRes = await fetch(`${url}/api/v2/sessions/${sessionId}`);
      const snapshot = await snapRes.json();
      expect(snapshot.turn?.state).toBe("waiting_for_input");

      // Submitting without ifActive: "queue" throws 409
      const unqueuedPayload: RunAgentInput = {
        threadId: sessionId,
        runId: "unqueued-conflict-run",
        messages: [...snapshot.messages, { id: "msg-conflict", role: "user", content: "Conflict turn" }],
        tools: [],
        context: [],
      };
      const conflictRes = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unqueuedPayload),
      });
      expect(conflictRes.status).toBe(409);

      // Step 3: Submitting with ifActive: "queue" and Accept: application/json returns 202 Accepted
      const queuedRunId = "queued-run-json";
      const queuedPayload: RunAgentInput = {
        threadId: sessionId,
        runId: queuedRunId,
        messages: [...snapshot.messages, { id: "msg-queue-1", role: "user", content: "Queued request" }],
        forwardedProps: { barry: { ifActive: "queue" } },
        tools: [],
        context: [],
      };

      const jsonRes = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(queuedPayload),
      });

      expect(jsonRes.status).toBe(202);
      const jsonBody = (await jsonRes.json()) as { id: string; state: string };
      expect(jsonBody.state).toBe("queued");
      expect(jsonRes.headers.get("x-barry-turn-id")).toBe(jsonBody.id);
    });

    it("handles queued turn delivery with SSE: streams progress upon admission when prior turn finishes", async () => {
      const sessionId = "session-queued-stream";

      // Step 1: Start an active turn that pauses on interrupt
      const pauseRunId = "pause-run-2";
      const pausePayload: RunAgentInput = {
        threadId: sessionId,
        runId: pauseRunId,
        messages: [{ id: "msg-pause-2", role: "user", content: "Please pause-me second" }],
        tools: [],
        context: [],
      };

      const pauseRes = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(pausePayload),
      });
      const pauseFrames = await readSseStream(pauseRes);
      expect(pauseFrames.at(-1)?.data).toMatchObject({
        type: "RUN_FINISHED",
        outcome: { type: "interrupt" },
      });
      const pausedTurnId = pauseRes.headers.get("x-barry-turn-id")!;

      // Step 2: Fetch snapshot messages to build queued turn payload
      const snapRes = await fetch(`${url}/api/v2/sessions/${sessionId}`);
      const snapshot = await snapRes.json();
      expect(snapshot.turn?.state).toBe("waiting_for_input");

      const queuedRunId = "queued-run-sse";
      const queuedPayload: RunAgentInput = {
        threadId: sessionId,
        runId: queuedRunId,
        messages: [...snapshot.messages, { id: "msg-queue-sse", role: "user", content: "Queued SSE request" }],
        forwardedProps: { barry: { ifActive: "queue" } },
        tools: [],
        context: [],
      };

      // Connect with Accept: text/event-stream
      const queuedSseRes = await fetch(`${url}/api/v2/sessions/${sessionId}/ag-ui`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(queuedPayload),
      });

      expect(queuedSseRes.status).toBe(200);
      expect(queuedSseRes.headers.get("content-type")).toContain("text/event-stream");
      const queuedTurnId = queuedSseRes.headers.get("x-barry-turn-id");
      expect(queuedTurnId).toBeTruthy();

      // Step 3: Begin reading SSE stream in parallel
      const streamPromise = readSseStream(queuedSseRes);

      // Cancel the active paused turn: this promotes and runs the queued turn
      const cancelRes = await fetch(`${url}/api/v2/sessions/${sessionId}/turns/${pausedTurnId}/cancel`, {
        method: "POST",
      });
      expect(cancelRes.status).toBe(200);

      // Await the queued turn's streamed progress
      const queuedFrames = await streamPromise;
      expect(queuedFrames.length).toBeGreaterThanOrEqual(3);

      expect(queuedFrames[0].data).toMatchObject({
        type: "RUN_STARTED",
        threadId: sessionId,
        runId: queuedRunId,
      });
      expect(queuedFrames.some((f) => f.data.type === "TEXT_MESSAGE_CHUNK")).toBe(true);
      expect(queuedFrames.at(-1)?.data).toMatchObject({
        type: "RUN_FINISHED",
        threadId: sessionId,
        runId: queuedRunId,
      });
    });
  });

  describe("Strict v1 Sunset Gate Verification", () => {
    it("with BARRY_DISABLE_APP_PROTOCOL_V1=true: rejects /api/v1/ws with 1008 and /api/v1/sessions/:id/message with 410, while v2 endpoints operate normally", async () => {
      const sessionId = "session-sunset";
      const originalEnv = process.env.BARRY_DISABLE_APP_PROTOCOL_V1;
      process.env.BARRY_DISABLE_APP_PROTOCOL_V1 = "true";

      try {
        // 1. /api/v1/sessions/:id/message returns 410 Gone
        const messageRes = await fetch(`${url}/api/v1/sessions/${sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "v1 legacy message" }),
        });
        expect(messageRes.status).toBe(410);
        const body = (await messageRes.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toContain("App Protocol v1 message endpoint is disabled");

        // 2. /api/v1/ws rejects connection with close code 1008
        const wsV1 = new WebSocket(`${wsUrl}/api/v1/ws`, {
          headers: { Authorization: `Bearer ${SECRET}` },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout waiting for ws close")), 3000);
          wsV1.on("close", (code, reason) => {
            clearTimeout(timer);
            resolve({ code, reason: reason.toString() });
          });
          wsV1.on("error", () => {
            // Some ws versions emit error on 1008
          });
        });

        const { code, reason } = await closePromise;
        expect(code).toBe(1008);
        expect(reason).toContain("Barry App Protocol v1 is disabled; connect to /api/v2/ws using AG-UI");

        // 3. /api/v2/sessions/:id/ag-ui works normally
        const v2SnapshotRes = await fetch(`${url}/api/v2/sessions/${sessionId}`);
        expect(v2SnapshotRes.status).toBe(200);
        const snapshot = await v2SnapshotRes.json();
        expect(snapshot.threadId).toBe(sessionId);

        // 4. /api/v2/ws works normally (connects and handles AG-UI subscribe)
        const wsV2 = new WebSocket(`${wsUrl}/api/v2/ws`, {
          headers: { Authorization: `Bearer ${SECRET}` },
        });

        await new Promise<void>((resolve, reject) => {
          wsV2.once("open", () => resolve());
          wsV2.once("error", reject);
        });

        const snapshotDeliveryPromise = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timeout waiting for snapshot")), 3000);
          wsV2.on("message", (raw) => {
            const parsed = JSON.parse(raw.toString());
            if (parsed.type === "snapshot") {
              clearTimeout(timer);
              resolve(parsed);
            }
          });
        });

        wsV2.send(JSON.stringify({ type: "subscribe", sessionId }));
        const snapshotMsg = await snapshotDeliveryPromise;
        expect(snapshotMsg).toMatchObject({
          type: "snapshot",
          sessionId,
          snapshot: { threadId: sessionId },
        });

        wsV2.close();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.BARRY_DISABLE_APP_PROTOCOL_V1;
        } else {
          process.env.BARRY_DISABLE_APP_PROTOCOL_V1 = originalEnv;
        }
      }
    });
  });
});
