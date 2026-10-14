import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAuth } from "@barry-rocks/sdk/services/http";
import type { DeviceScope } from "@barry-rocks/sdk/internal/auth";
import { Barry } from "@barry-rocks/sdk";
import { access, identities, owner } from "@barry-rocks/identities-bag";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";
import { WebSocket, type WebSocketServer } from "ws";
import { sessionRequestAuthorization } from "../request-authorization.js";
import { createWebSocketServer } from "../websocket.js";
import { publishToTopic } from "../bus-registry.js";

const fixture = vi.hoisted(() => ({ store: null as TurnContinuations | null, cancel: vi.fn(), notifications: true }));
vi.mock("../turn-execution.js", () => ({ turnExecutionService: () => ({ store: fixture.store, execution: { cancel: fixture.cancel } }) }));
vi.mock("@barry-rocks/identities-bag", async importOriginal => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return { ...actual, access: { ...actual.access, subscribe: (listener: () => void) => fixture.notifications ? actual.access.subscribe(listener) : () => {} } };
});
const { createAgUiRouter, closeAgUiStreams } = await import("./ag-ui.js");
const SCOPES: DeviceScope[] = ["sessions:read", "events:read", "events:subscribe"];
let server: Server;
let url: string;
let directory: string;
let afterFrame: (() => void) | undefined;
let blockWrites: boolean;
let writes: string[];
let wss: WebSocketServer;
let sockets: WebSocket[];

beforeEach(async () => {
  closeIdentitiesStore(); closeSessionsDb();
  directory = mkdtempSync(join(tmpdir(), "barry-stream-authorization-"));
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  vi.stubEnv("BARRY_SECRET", "stream-installation-secret");
  identitiesSqlite().exec("INSERT INTO actors (id, token, type, name) VALUES (1,'one','user','one'),(2,'two','user','two'); INSERT INTO identities (id,token,actor_id,name) VALUES (1,'identity-one',1,'one'),(2,'identity-two',2,'two');");
  owner.installation().bind({ actorId: 1, actorToken: "one" });
  // Installed as the service installs them: the real subjects over this store.
  Barry.use(identities, sessions);
  getSessionsSqlite().exec("INSERT INTO sessions (id,user_id,identity_id) VALUES ('owned',1,1),('foreign',2,2),('wrong-identity',1,2);");
  fixture.store = new TurnContinuations(getSessionsSqlite());
  writes = []; afterFrame = undefined; blockWrites = false;
  sockets = [];
  fixture.cancel.mockReset().mockResolvedValue({ id: "turn", sessionId: "owned", runId: "run", state: "cancelled", revision: 1, reviewPolicy: { mode: "review_required" }, interrupts: [] });
  fixture.notifications = true;
  await startServer();
});
async function startServer(authorizationIntervalMs = 10000) {
  const app = express();
  app.use(express.json());
  applyAuth(app, sessionRequestAuthorization());
  app.use((_request, response, next) => {
    const write = response.write.bind(response);
    response.write = ((chunk: string) => {
      const writable = write(chunk);
      writes.push(chunk);
      afterFrame?.();
      return blockWrites ? false : writable;
    }) as typeof response.write;
    next();
  });
  app.use("/api/v2/sessions", createAgUiRouter({ authorizationIntervalMs }));
  server = app.listen(0, "127.0.0.1");
  wss = createWebSocketServer(server, { authorizationIntervalMs });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  url = `http://127.0.0.1:${address.port}`;
}
async function stopServer() {
  closeAgUiStreams();
  for (const socket of sockets) socket.terminate();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
afterEach(async () => {
  await stopServer();
  Barry.reset();
  closeSessionsDb(); closeIdentitiesStore(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function pair(scopes = SCOPES) {
  const store = access.devices();
  const pending = store.request({ clientName: "Stream fixture", requestedScopes: scopes, requestedIdentityIds: [1] }, `source-${scopes.join(",")}`);
  store.authorize(pending.pairingCode, 1, { scopes, identityIds: [1] });
  const claim = store.claim(pending.pollToken);
  if (claim.status !== "authorized") throw new Error("Fixture pairing failed");
  return claim;
}
function open(token: string, path = "/api/v2/sessions/owned/events") {
  return fetch(url + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
}
function appendEvents() {
  const store = fixture.store!;
  const turn = store.admit({ sessionId: "owned", requestId: "request", runId: "run", actor: "user:1", content: { text: "Work" }, policy: { mode: "automatic" } });
  store.append("owned", turn.id, { type: "partial", text: "First" });
  store.append("owned", turn.id, { type: "partial", text: "Second" });
}

function connect(token: string, path = "/api/v2/ws") {
  const socket = new WebSocket(url.replace("http:", "ws:") + path, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(socket);
  const messages: Array<{ type: string; sessionId?: string; cursor?: string }> = [];
  socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
  const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
  const opened = new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, messages, closed, opened };
}

async function revokeInAnotherProcess(deviceId: string) {
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import Database from 'better-sqlite3';
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout = 5000');
    db.prepare('UPDATE device_credentials SET revoked_at=? WHERE id=?').run(Date.now(),process.argv[2]);
    db.close();
  `, join(directory, "identities.db"), deviceId], { timeout: 2000 });
}

describe("authenticated AG-UI subscriptions", () => {
  it("refuses operator mutations of foreign sessions before any execution or durable writes", async () => {
    const db = getSessionsSqlite();
    const changes = db.prepare("SELECT total_changes() AS n").get();
    for (const id of ["foreign", "wrong-identity"]) {
      for (const suffix of ["ag-ui", "turns/turn/cancel"]) {
        const response = await fetch(`${url}/api/v2/sessions/${id}/${suffix}`, { method: "POST", headers: { Authorization: "Bearer stream-installation-secret", "Content-Type": "application/json" }, body: JSON.stringify({ authPrincipal: { actorId: 2 }, actorId: 2, sessionId: "owned" }) });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ title: "Session execution forbidden", status: 403 });
      }
    }
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  });
  it("reports missing sessions separately from ownership refusal without durable writes", async () => {
    const db = getSessionsSqlite();
    const changes = db.prepare("SELECT total_changes() AS n").get();
    for (const suffix of ["ag-ui", "turns/turn/cancel"]) {
      const response = await fetch(`${url}/api/v2/sessions/missing/${suffix}`, { method: "POST", headers: { Authorization: "Bearer stream-installation-secret", "Content-Type": "application/json" }, body: JSON.stringify({ authPrincipal: { actorId: 2 }, actorId: 2, sessionId: "owned" }) });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ title: "Session not found", status: 404 });
    }
    expect(fixture.cancel).not.toHaveBeenCalled();
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  });
  it("allows the authenticated operator to cancel an owned session", async () => {
    const response = await fetch(`${url}/api/v2/sessions/owned/turns/turn/cancel`, { method: "POST", headers: { Authorization: "Bearer stream-installation-secret" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "cancelled" });
    expect(fixture.cancel).toHaveBeenCalledExactlyOnceWith("owned", "turn");
  });
  it.each(SCOPES)("requires %s as well as the other subscription scopes", async missing => {
    expect((await open(pair(SCOPES.filter(scope => scope !== missing)).deviceToken)).status).toBe(403);
    expect(writes).toEqual([]);
  });
  it("refuses foreign sessions and does not enable snapshots or execution endpoints", async () => {
    const claim = pair();
    for (const path of ["/api/v2/sessions/foreign/events", "/api/v2/sessions/owned", "/api/v2/sessions/owned/stream"]) {
      expect((await open(claim.deviceToken, path)).status).toBe(403);
    }
    expect((await fetch(url + "/api/v2/sessions/owned/ag-ui", { method: "POST", headers: { Authorization: `Bearer ${claim.deviceToken}`, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect(writes).toEqual([]);
  });
  it.each(["revoke", "expire", "identity", "session", "grant"] as const)("stops before the next frame after a %s change", async change => {
    const claim = pair(); appendEvents();
    afterFrame = () => {
      afterFrame = undefined;
      if (change === "revoke") access.devices().revoke(1, claim.deviceId);
      if (change === "expire") identitiesSqlite().prepare("UPDATE device_credentials SET expires_at=? WHERE id=?").run(Date.now(), claim.deviceId);
      if (change === "identity") identitiesSqlite().exec("UPDATE identities SET actor_id=2 WHERE id=1");
      if (change === "session") getSessionsSqlite().exec("UPDATE sessions SET user_id=2 WHERE id='owned'");
      if (change === "grant") identitiesSqlite().prepare("UPDATE device_credentials SET scopes='[\"sessions:read\"]' WHERE id=?").run(claim.deviceId);
    };
    const response = await open(claim.deviceToken);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(writes[0]);
    expect(writes).toHaveLength(1);
    expect((await open(claim.deviceToken)).status).toBe(change === "session" || change === "grant" ? 403 : 401);
  });
  it("ends an idle subscription after revocation without waiting for another event", async () => {
    const claim = pair();
    const response = await open(claim.deviceToken, "/api/v2/sessions/owned/events?session_id=foreign&caller_session_id=foreign");
    expect(response.status).toBe(200);
    access.devices().revoke(1, claim.deviceId);
    expect(await response.text()).toBe("");
    expect(writes).toEqual([]);
  });
  it("keeps checking authorization while the response waits for drain", async () => {
    const claim = pair(); appendEvents(); blockWrites = true;
    const response = await open(claim.deviceToken);
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    access.devices().revoke(1, claim.deviceId);
    expect(await response.text()).toBe(writes[0]);
    expect(writes).toHaveLength(1);
  });
  it("closes a blocked stream on cross-process revocation before the fallback timer", async () => {
    const claim = pair(); appendEvents(); blockWrites = true;
    const response = await open(claim.deviceToken);
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    await revokeInAnotherProcess(claim.deviceId);
    expect(await response.text()).toBe(writes[0]);
    expect(writes).toHaveLength(1);
  });
  it("closes a blocked stream through periodic verification when notifications are lost", async () => {
    await stopServer(); fixture.notifications = false; await startServer(20);
    const claim = pair(); appendEvents(); blockWrites = true;
    const response = await open(claim.deviceToken);
    access.devices().revoke(1, claim.deviceId);
    expect(await response.text()).toBe(writes[0]);
    expect(writes).toHaveLength(1);
  });
  it("keeps a blocked stream valid when a surrounding revocation transaction rolls back", async () => {
    const claim = pair(); appendEvents(); blockWrites = true;
    const response = await open(claim.deviceToken);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect(() => identitiesSqlite().transaction(() => {
      access.devices().revoke(1, claim.deviceId);
      throw new Error("Rollback");
    })()).toThrow("Rollback");
    let ended = false;
    const next = reader.read().then(frame => { ended = frame.done; return frame; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(ended).toBe(false);
    access.devices().revoke(1, claim.deviceId);
    expect((await next).done).toBe(true);
    reader.releaseLock();
  });
  it("rechecks the admitted installation credential between frames", async () => {
    appendEvents();
    afterFrame = () => { afterFrame = undefined; vi.stubEnv("BARRY_SECRET", "rotated-installation-secret"); };
    const response = await open("stream-installation-secret");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(writes[0]);
    expect(writes).toHaveLength(1);
    expect((await open("stream-installation-secret")).status).toBe(401);
  });
});

describe("authenticated WebSocket subscriptions", () => {
  it("does not publish a legacy topic signal after the installation credential rotates", async () => {
    const connection = connect("stream-installation-secret", "/api/v1/ws");
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe_topic", topic: "events" }));
    await vi.waitFor(() => expect(connection.messages.some(message => message.type === "topic_subscribed")).toBe(true));
    vi.stubEnv("BARRY_SECRET", "rotated-publication-secret");
    publishToTopic("events", { type: "bus", id: "blocked" });
    await vi.waitFor(() => expect(connection.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 2000 });
    expect(await connection.closed).toBe(1008);
    expect(connection.messages.filter(message => message.type === "bus")).toEqual([]);
  });
  it("rechecks the credential between legacy topic frames queued together", async () => {
    let rotated = false;
    wss.on("connection", socket => {
      const send = socket.send.bind(socket);
      socket.send = ((bytes: string, callback?: (error?: Error) => void) => {
        send(bytes, callback);
        if (!rotated && JSON.parse(bytes).type === "bus") {
          rotated = true; vi.stubEnv("BARRY_SECRET", "rotated-between-publications");
        }
      }) as typeof socket.send;
    });
    const connection = connect("stream-installation-secret", "/api/v1/ws");
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe_topic", topic: "events" }));
    await vi.waitFor(() => expect(connection.messages.some(message => message.type === "topic_subscribed")).toBe(true));
    publishToTopic("events", { type: "bus", id: "allowed" });
    publishToTopic("events", { type: "bus", id: "blocked" });
    await vi.waitFor(() => expect(connection.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 2000 });
    expect(await connection.closed).toBe(1008);
    expect(connection.messages.filter(message => message.type === "bus")).toEqual([{ type: "bus", id: "allowed" }]);
  });
  it.each(SCOPES)("does not publish a snapshot or events without %s", async missing => {
    const connection = connect(pair(SCOPES.filter(scope => scope !== missing)).deviceToken);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe", sessionId: "owned" }));
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toEqual([]);
  });
  it("refuses a device upgrade to the legacy protocol and refuses foreign resource expansion", async () => {
    const claim = pair();
    const legacy = connect(claim.deviceToken, "/api/v1/ws");
    await expect(legacy.opened).rejects.toThrow(/403/);
    const connection = connect(claim.deviceToken);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe", sessionId: "foreign" }));
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toEqual([]);
  });
  it("rejects caller-supplied grants without publishing resource data", async () => {
    const connection = connect(pair().deviceToken);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe", sessionId: "foreign", actorId: 2, identityId: 2 }));
    await vi.waitFor(() => expect(connection.messages).toEqual([{ type: "error", message: "Invalid subscription request" }]));
  });
  it.each(["revoke", "expire", "identity", "session", "grant"] as const)("stops event batches immediately after a %s change", async change => {
    const claim = pair(); appendEvents();
    let changed = false;
    wss.on("connection", socket => {
      const send = socket.send.bind(socket);
      socket.send = ((bytes: string) => {
        send(bytes);
        if (changed || JSON.parse(bytes).type !== "event") return;
        changed = true;
        if (change === "revoke") access.devices().revoke(1, claim.deviceId);
        if (change === "expire") identitiesSqlite().prepare("UPDATE device_credentials SET expires_at=? WHERE id=?").run(Date.now(), claim.deviceId);
        if (change === "identity") identitiesSqlite().exec("UPDATE identities SET actor_id=2 WHERE id=1");
        if (change === "session") getSessionsSqlite().exec("UPDATE sessions SET user_id=2 WHERE id='owned'");
        if (change === "grant") identitiesSqlite().prepare("UPDATE device_credentials SET scopes='[\"sessions:read\"]' WHERE id=?").run(claim.deviceId);
      }) as typeof socket.send;
    });
    const connection = connect(claim.deviceToken);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe", sessionId: "owned", after: "0" }));
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toHaveLength(1);
    expect(connection.messages[0]).toMatchObject({ type: "event", sessionId: "owned" });
  });
  it("closes an idle socket after revocation, including before it subscribes", async () => {
    const claim = pair();
    const connection = connect(claim.deviceToken);
    await connection.opened;
    access.devices().revoke(1, claim.deviceId);
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toEqual([]);
  });
  it("closes an unsubscribed idle socket on cross-process revocation before the fallback timer", async () => {
    const claim = pair();
    const connection = connect(claim.deviceToken);
    await connection.opened;
    await revokeInAnotherProcess(claim.deviceId);
    await vi.waitFor(() => expect(connection.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 2000 });
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toEqual([]);
  });
  it("closes an idle socket through periodic verification when notifications are lost", async () => {
    await stopServer(); fixture.notifications = false; await startServer(20);
    const claim = pair();
    const connection = connect(claim.deviceToken);
    await connection.opened;
    access.devices().revoke(1, claim.deviceId);
    await vi.waitFor(() => expect(connection.socket.readyState).toBe(WebSocket.CLOSED));
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toEqual([]);
  });
  it("closes an idle authorized subscription after its session ownership changes", async () => {
    const connection = connect(pair().deviceToken);
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe", sessionId: "owned" }));
    await vi.waitFor(() => expect(connection.messages).toHaveLength(1));
    expect(connection.messages[0]).toMatchObject({ type: "snapshot", sessionId: "owned" });
    getSessionsSqlite().exec("UPDATE sessions SET user_id=2 WHERE id='owned'");
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toHaveLength(1);
  });
  it("rejects legacy operator mutations of foreign sessions without durable writes", async () => {
    const connection = connect("stream-installation-secret", "/api/v1/ws");
    await connection.opened;
    const db = getSessionsSqlite();
    const before = db.prepare("SELECT total_changes() AS n").get();
    for (const type of ["message", "start", "stop", "remove", "ruling", "register_listener"]) {
      connection.socket.send(JSON.stringify({ type, sessionId: "foreign", content: "spoof", prompt: "spoof", repoPath: directory, actorId: 2, identityId: 2 }));
    }
    await vi.waitFor(() => expect(connection.messages.filter(message => message.type === "error")).toHaveLength(6));
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });
  it("closes an installation subscription on credential rotation before the next event", async () => {
    appendEvents();
    let rotated = false;
    wss.on("connection", socket => {
      const send = socket.send.bind(socket);
      socket.send = ((bytes: string) => {
        send(bytes);
        if (!rotated && JSON.parse(bytes).type === "event") {
          rotated = true; vi.stubEnv("BARRY_SECRET", "rotated-socket-secret");
        }
      }) as typeof socket.send;
    });
    const connection = connect("stream-installation-secret");
    await connection.opened;
    connection.socket.send(JSON.stringify({ type: "subscribe", sessionId: "owned", after: "0" }));
    expect(await connection.closed).toBe(1008);
    expect(connection.messages).toHaveLength(1);
  });
});
