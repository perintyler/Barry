import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import { access } from "@barry-rocks/identities-bag";
import { sessionRuntime, type WsMessage } from "./session-runtime.js";
import { admitCompatibilityTurn, submitTurnRuling, turnExecutionService } from "./turn-execution.js";
import { subscribeCompatibilityTurns } from "./turn-compatibility.js";
import { getSessionRecord } from "./db.js";
import { registerListener } from "@barry-rocks/sessions-bag/client";
import type { DeliveryGuarantee } from "@barry-rocks/sessions-bag/delivery";

import { createLogger } from "@barry-rocks/sdk/logging";
import { authenticateCredential, requestCredential, type CredentialAuthorization } from "@barry-rocks/sdk/internal/auth";
import { authorizeSessionExecution, SessionExecutionResourceUnavailable } from "@barry-rocks/sessions-bag/execution-authorization";
import { getHostingConfig, originAllowed } from "@barry-rocks/sdk/services";
import { validateRepoPath } from "./repo-paths.js";
import { subscribeTopic, unsubscribeTopic, clearTopics } from "./bus-registry.js";
import { attachAgUiSubscription } from "./ag-ui-websocket.js";
import { SocketPublications } from "./socket-publications.js";
import { sessionMcpServers } from "./mcp-config.js";
import { Barry, requestCaller, type Bound, type Caller, type Tool } from "@barry-rocks/sdk";

const log = createLogger("barry-ws");
const compatibilitySubscriptions = new WeakMap<SocketPublications, Map<string, () => void>>();
async function subscribeTurns(socket: SocketPublications, sessionId: string): Promise<void> {
  let subscriptions = compatibilitySubscriptions.get(socket);
  if (!subscriptions) { subscriptions = new Map(); compatibilitySubscriptions.set(socket, subscriptions); }
  subscriptions.get(sessionId)?.();
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  subscriptions.set(sessionId, cancel);
  const row = await getSessionRecord(sessionId);
  if (cancelled || socket.readyState !== 1) return;
  if (!row) { subscriptions.delete(sessionId); return; }
  subscriptions.set(sessionId, subscribeCompatibilityTurns(turnExecutionService().store, sessionId, socket));
}

interface ClientMessage {
  type:
    | "subscribe"
    | "unsubscribe"
    | "activity"
    | "message"
    | "start"
    | "stop"
    | "remove"
    | "list"
    | "subscribe_topic"
    | "unsubscribe_topic"
    | "register_listener"
    | "ruling";
  protocolVersion?: number;
  afterSequence?: number;
  /** Bus topic for subscribe_topic / unsubscribe_topic. */
  topic?: string;
  sessionId?: string;
  content?: string;
  prompt?: string;
  repoPath?: string;
  name?: string;
  mcpPreset?: string;
  mcpTools?: string[];
  bags?: string[];
  bounds?: Array<Bound | string>;
  bound?: Bound | null;
  metadata?: Record<string, unknown>;
  identityId?: number;
  useWorktree?: boolean;
  provider?: string;
  model?: string;
  attachmentIds?: string[];
  requestId?: string;
  decision?: "allow" | "deny";
  reason?: string;
  guarantee?: DeliveryGuarantee;
}

export function isLoopbackAddress(ip: string): boolean {
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

export function getClientIp(req: IncomingMessage): string {
  const remoteAddress = req.socket.remoteAddress || "";
  const trustProxy = process.env.BARRY_TRUST_PROXY === "true";

  // Only trust forwarded headers when explicitly enabled and the direct peer is loopback.
  if (trustProxy && isLoopbackAddress(remoteAddress)) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const clientIp = ips.split(",")[0]?.trim();
      if (clientIp) return clientIp;
    }
  }

  return remoteAddress;
}

export function createWebSocketServer(server: Server, options: { authorizationIntervalMs?: number } = {}): WebSocketServer {
  const authorizationIntervalMs = options.authorizationIntervalMs ?? 1000;
  if (!Number.isInteger(authorizationIntervalMs) || authorizationIntervalMs < 10 || authorizationIntervalMs > 10000) throw new RangeError("Invalid socket authorization interval");
  const admissions = new WeakMap<IncomingMessage, CredentialAuthorization>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1 * 1024 * 1024, // 1MB
    verifyClient: (info, callback) => {
      const clientIp = getClientIp(info.req);
      const credential = requestCredential(info.req);

      // Validate Origin header to prevent WebSocket CSRF
      const origin = info.origin || info.req.headers.origin;
      if (origin) {
        try {
          const url = new URL(origin);
          const hostingConfig = getHostingConfig();
          const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
          const isAllowedDomain = hostingConfig.allowedOrigins?.some(allowed => originAllowed(origin, allowed));
          if (!isLocalhost && !isAllowedDomain) {
            log.warn("websocket.origin_denied", { ip: clientIp, origin });
            callback(false, 403, "Origin not allowed");
            return;
          }
        } catch {
          log.warn("websocket.origin_invalid", { ip: clientIp, origin });
          callback(false, 403, "Invalid origin");
          return;
        }
      }

      if (!credential) { callback(false, 403, "Access denied"); return; }
      const controller = new AbortController();
      let authorization: CredentialAuthorization | null = null;
      info.req.socket.once("close", () => { controller.abort(); authorization?.dispose(); });
      void authenticateCredential(credential, { verifyCredential: access.verifyCredential, signal: controller.signal }).then(verified => {
        authorization = verified;
        if (!verified || controller.signal.aborted || (verified.principal.kind === "device" && new URL(info.req.url ?? "/", "http://localhost").pathname !== "/api/v2/ws")) {
          verified?.dispose(); callback(false, 403, "Access denied"); return;
        }
        admissions.set(info.req, verified);
        callback(true);
      }).catch(() => { callback(false, 503, "Authorization unavailable"); });
    },
  });

  const upgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/api/v1/ws" && path !== "/api/v2/ws") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
  server.on("upgrade", upgrade);
  wss.on("close", () => server.off("upgrade", upgrade));

  log.info("websocket.init", { path: "/api/v1/ws" });

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const authorization = admissions.get(request);
    admissions.delete(request);
    if (!authorization) { ws.close(1008, "Authorization unavailable"); return; }
    let authorizationTimer: NodeJS.Timeout | undefined;
    let pending: Promise<void> | undefined;
    let invalidated = false;
    const native = ws as WebSocket & { _socket?: { cork():void; uncork():void } };
    const publications = new SocketPublications({
      get readyState(){return ws.readyState;}, get bufferedAmount(){return ws.bufferedAmount;},
      send:(data,callback)=>ws.send(data,callback), close:(code,reason)=>ws.close(code,reason),
      on:(event,listener)=>ws.on(event,listener),
      cork:()=>native._socket?.cork(), uncork:()=>native._socket?.uncork(),
    }, authorization);
    let unsubscribeAuthorization: (() => void) | undefined;
    const dispose = () => {
      if (authorizationTimer) clearTimeout(authorizationTimer);
      unsubscribeAuthorization?.(); unsubscribeAuthorization = undefined;
      authorization.dispose();
    };
    const check = async () => {
      if (!await authorization.revalidate()) { dispose(); ws.close(1008, "Authorization unavailable"); }
    };
    const revalidate = () => {
      pending ??= (async () => {
        do { invalidated = false; await check(); } while (invalidated && ws.readyState === 1);
      })().finally(() => { pending = undefined; });
      return pending;
    };
    const poll = async () => {
      await revalidate();
      if (ws.readyState === 1) { authorizationTimer = setTimeout(() => { void poll(); }, authorizationIntervalMs); authorizationTimer.unref(); }
    };
    unsubscribeAuthorization = access.subscribe(() => { invalidated = true; publications.invalidateAuthorization(); void revalidate(); });
    authorizationTimer = setTimeout(() => { void poll(); }, authorizationIntervalMs); authorizationTimer.unref();
    ws.once("close", dispose);
    if (new URL(request?.url ?? "/", "http://localhost").pathname === "/api/v2/ws") {
      attachAgUiSubscription(ws, authorization); return;
    }
    if (process.env.BARRY_DISABLE_APP_PROTOCOL_V1 === "true") {
      ws.close(1008, "Barry App Protocol v1 is disabled; connect to /api/v2/ws using AG-UI");
      return;
    }
    log.info("websocket.connect", { clients: wss.clients.size });
    const publisher = publications;

    sessionRuntime.broadcastSessionList(publisher);

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (!await authorization.revalidate()) { authorization.dispose(); ws.close(1008, "Authorization unavailable"); return; }
        await handleMessage(publisher, message, authorization);
      } catch (err) {
        log.error("websocket.message_error", { error: err instanceof Error ? err.message : String(err) });
        sendError(publisher, "Invalid message format");
      }
    });

    ws.on("close", () => {
      log.info("websocket.disconnect", { clients: wss.clients.size });
      sessionRuntime.unsubscribeAll(publisher);
      for (const stop of compatibilitySubscriptions.get(publisher)?.values() ?? []) stop();
      compatibilitySubscriptions.delete(publisher);
      clearTopics(publisher);
    });

    ws.on("error", (err) => {
      log.error("websocket.error", { error: err.message });
    });
  });

  startHeartbeat(wss);

  return wss;
}

/**
 * Reap half-open sockets. Without this a client that dies without a clean close
 * stays in `wss.clients` and in every subscriber set forever.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Exported so tests can drive it with a short interval. */
export function startHeartbeat(
  wss: WebSocketServer,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): NodeJS.Timeout {
  const alive = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        log.info("websocket.reap_unresponsive");
        ws.terminate();
        continue;
      }
      alive.delete(ws); // must pong before the next sweep
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, intervalMs);

  // Don't hold the event loop open on shutdown.
  timer.unref?.();
  wss.once("close", () => clearInterval(timer));
  return timer;
}

async function handleMessage(ws: SocketPublications, message: ClientMessage, authorization: CredentialAuthorization): Promise<void> {
  const sessionId = message.sessionId;
  if (["message", "start", "stop", "remove", "ruling", "register_listener"].includes(message.type)) {
    try { await authorizeSessionExecution(authorization.principal, { ...(sessionId ? { sessionId } : {}), ...(message.identityId != null ? { identityId: message.identityId } : {}) }); }
    catch (error) { sendError(ws, error instanceof SessionExecutionResourceUnavailable ? "Session not found" : "Session execution forbidden"); return; }
  }
  log.debug("websocket.message", { type: message.type, sessionId });

  switch (message.type) {
    case "subscribe":
      if (sessionId) {
        if (message.protocolVersion !== undefined && message.protocolVersion !== 1) {
          sendError(ws, `Unsupported protocol version ${message.protocolVersion}. Supported version: 1`);
          return;
        }
        sessionRuntime.subscribe(sessionId, ws, { protocolVersion: message.protocolVersion, afterSequence: message.afterSequence });
        await subscribeTurns(ws, sessionId);
      }
      break;

    case "activity":
      if (sessionId) {
        const active=sessionRuntime.getActiveSession(sessionId);
        if (active?.subscribers.has(ws)) active.session?.touch?.();
      }
      break;
    case "unsubscribe":
      if (sessionId) {
        sessionRuntime.unsubscribe(sessionId, ws);
        compatibilitySubscriptions.get(ws)?.get(sessionId)?.();
        compatibilitySubscriptions.get(ws)?.delete(sessionId);
      }
      break;

    // Bus topics are independent of session subscriptions: a client can watch
    // "events" or "services" without any session being live.
    case "subscribe_topic":
      if (message.topic) {
        subscribeTopic(ws, message.topic);
        ws.send(JSON.stringify({ type: "topic_subscribed", topic: message.topic }));
      }
      break;

    case "unsubscribe_topic":
      if (message.topic) unsubscribeTopic(ws, message.topic);
      break;

    case "message":
      if (sessionId && message.content) {
        try {
          await admitCompatibilityTurn(sessionId, message.content, message.attachmentIds, authorization.principal);
        } catch (err) {
          sendError(ws, err instanceof Error ? err.message : String(err));
        }
      }
      break;

    case "register_listener":
      if (sessionId) {
        try {
          const guarantee = message.guarantee ?? "wake";
          await registerListener(sessionId, "client", guarantee);
          send(ws, {
            type: "listener_registered",
            sessionId,
            metadata: { kind: "client", guarantee },
          });
        } catch (err) {
          sendError(ws, err instanceof Error ? err.message : String(err));
        }
      }
      break;

    case "ruling":
      if (sessionId && message.requestId && message.decision) {
        const applied = await submitTurnRuling(
          sessionId,
          message.requestId,
          message.decision,
          message.reason,
          authorization.principal,
        );
        send(ws, {
          type: "ruling_result",
          sessionId,
          requestId: message.requestId,
          status: applied ? "applied" : "expired",
        });
      } else {
        sendError(ws, "sessionId, requestId, and decision ('allow' | 'deny') are required for ruling");
      }
      break;

    case "start":
      if (message.prompt && message.repoPath) {
        const validated = validateRepoPath(message.repoPath);
        if (!validated.ok) {
          sendError(ws, validated.error);
          return;
        }
        const repoPath = validated.path;

        try {
          const mcpServers = await sessionMcpServers(sessionId, await startTools(message, requestCaller(authorization.principal)));
          const activeSession = await sessionRuntime.startSession({
            sessionId,
            prompt: message.prompt,
            prepareOnly: true,
            repoPath,
            name: message.name,
            bags: message.bags,
            bound: message.bound,
            bounds: message.bounds,
            mcpServers,
            metadata: message.metadata,
            identityId: message.identityId,
            useWorktree: !!message.useWorktree,
            provider: message.provider || undefined,
            model: message.model || undefined,
          }, authorization.principal);

          sessionRuntime.subscribe(activeSession.id, ws);
          await subscribeTurns(ws, activeSession.id);
          await admitCompatibilityTurn(activeSession.id, message.prompt, message.attachmentIds, authorization.principal);
          sessionRuntime.broadcastSessionList();

          send(ws, {
            type: "session_started",
            sessionId: activeSession.id,
            content: `Session started: ${activeSession.name || activeSession.id.slice(0, 8)}`,
          });
        } catch (err) {
          sendError(ws, err instanceof Error ? err.message : String(err));
        }
      } else {
        sendError(ws, "prompt and repoPath are required");
      }
      break;

    case "stop":
      if (sessionId) {
        try {
          await sessionRuntime.stopSession(sessionId, authorization.principal);
        } catch (err) {
          sendError(ws, err instanceof Error ? err.message : String(err));
        }
      }
      break;

    case "remove":
      if (sessionId) {
        try {
          await sessionRuntime.removeSession(sessionId, authorization.principal);
        } catch (err) {
          sendError(ws, err instanceof Error ? err.message : String(err));
        }
      }
      break;

    case "list":
      sessionRuntime.broadcastSessionList(ws);
      break;

    default:
      sendError(ws, `Unknown message type: ${(message).type}`);
  }
}

/**
 * The tools a session a client starts receives: its row's tools when it names
 * an existing session; otherwise what the start selects.
 */
async function startTools(message: ClientMessage, caller: Caller): Promise<Tool[]> {
  const asked = Barry.as(caller);
  if (message.sessionId) {
    const row = await getSessionRecord(message.sessionId);
    if (row) {
      return asked.tools(row.identity_id ?? null, row.bags ?? [], (row.bound as Bound | null) ?? row.bounds ?? []);
    }
  }
  const requestedBounds: Array<Bound | string> = [
    ...(message.bounds ?? []),
    ...(message.bound ? [message.bound] : []),
  ];
  return asked.tools(message.identityId ?? null, message.bags, requestedBounds);
}

function send(ws: SocketPublications, message: WsMessage): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws: SocketPublications, error: string): void {
  send(ws, { type: "error", error });
}
