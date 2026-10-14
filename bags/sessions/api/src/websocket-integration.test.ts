/**
 * Socket-level tests — the first in the repo that stand up a real
 * `WebSocketServer` and connect over TCP.
 *
 * These cover the parts unit tests can't: that `verifyClient` actually rejects
 * an unauthenticated upgrade, and that a subscribe → publish → deliver round
 * trip works across a genuine socket.
 *
 * The bus bridge itself is not started here — that needs a live database. The
 * cross-process notification path is verified separately against it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "http";
import { WebSocket, type WebSocketServer } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { owner } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";

const SECRET = "test-secret-for-ws-integration";

process.env.BARRY_SECRET = SECRET;

const { createWebSocketServer, startHeartbeat } = await import("./websocket.js");
const { publishToTopic, resetTopics } = await import("./bus-registry.js");

let server: Server;
let port: number;
let identitiesDirectory: string;
let wss: WebSocketServer;

beforeAll(async () => {
  closeIdentitiesStore();
  identitiesDirectory = mkdtempSync(join(tmpdir(), "barry-ws-owner-"));
  vi.stubEnv("BARRY_IDENTITIES_DB", join(identitiesDirectory, "identities.db"));
  owner.installation().provision({ username: "Socket fixture" });
  server = createServer();
  wss = createWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(resolve => wss.close(() => resolve()));
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeIdentitiesStore(); vi.unstubAllEnvs();
  rmSync(identitiesDirectory, { recursive: true, force: true });
});

beforeEach(() => resetTopics());

function connect(headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }) {
  return new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, { headers });
}

/** Resolve once the socket opens, or reject on the rejected-upgrade error. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/** Wait for the next message matching `predicate`. */
function nextMessage(ws: WebSocket, predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 2000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

describe("websocket auth", () => {
  it("rejects malformed and conflicting credentials on a real upgrade", async () => {
    const invalidHeaders: Record<string, string>[] = [
      { Authorization: `Bearer ${SECRET} ignored` },
      { Authorization: `Bearer ${SECRET}`, "x-barry-secret": "different" },
      { Authorization: "Basic wrong", "x-barry-secret": SECRET },
    ];
    for (const headers of invalidHeaders) {
      const ws = connect(headers);
      await expect(opened(ws)).rejects.toThrow(/403/);
      ws.close();
    }
  });
  it("applies the same secret and Origin checks to AG-UI subscriptions", async () => {
    for (const headers of [{}, { Authorization: `Bearer ${SECRET}`, Origin: "https://untrusted.invalid" }]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`, { headers });
      await expect(opened(ws)).rejects.toThrow(/403|Unexpected server response/);
      ws.close();
    }
    const allowed = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`, { headers: { Authorization: `Bearer ${SECRET}` } });
    await expect(opened(allowed)).resolves.toBeUndefined();
    allowed.close();
  });
  it("rejects an upgrade with no secret", async () => {
    const ws = connect({});
    await expect(opened(ws)).rejects.toThrow(/403|Unexpected server response/);
    ws.close();
  });

  it("rejects an upgrade with the wrong secret", async () => {
    const ws = connect({ Authorization: "Bearer wrong-secret" });
    await expect(opened(ws)).rejects.toThrow(/403|Unexpected server response/);
    ws.close();
  });

  it("accepts a Bearer token matching BARRY_SECRET", async () => {
    const ws = connect();
    await expect(opened(ws)).resolves.toBeUndefined();
    ws.close();
  });

  it("accepts the x-barry-secret header the web proxy injects", async () => {
    const ws = connect({ "x-barry-secret": SECRET });
    await expect(opened(ws)).resolves.toBeUndefined();
    ws.close();
  });
});

describe("topic subscribe over a real socket", () => {
  it("acknowledges a subscription", async () => {
    const ws = connect();
    await opened(ws);

    const ack = nextMessage(ws, (m) => m.type === "topic_subscribed");
    ws.send(JSON.stringify({ type: "subscribe_topic", topic: "events" }));

    expect(await ack).toMatchObject({ type: "topic_subscribed", topic: "events" });
    ws.close();
  });

  it("delivers a publish to a subscribed socket", async () => {
    const ws = connect();
    await opened(ws);

    await nextMessage(ws, (m) => m.type === "topic_subscribed").catch(() => {});
    ws.send(JSON.stringify({ type: "subscribe_topic", topic: "events" }));
    await new Promise((r) => setTimeout(r, 100)); // let the server register it

    const received = nextMessage(ws, (m) => m.type === "bus");
    publishToTopic("events", { type: "bus", topic: "events", id: "evt_live" });

    expect(await received).toMatchObject({ type: "bus", topic: "events", id: "evt_live" });
    ws.close();
  });

  it("does not deliver to a socket that never subscribed", async () => {
    const ws = connect();
    await opened(ws);
    await new Promise((r) => setTimeout(r, 100));

    let got = false;
    ws.on("message", (raw: Buffer) => {
      if (JSON.parse(raw.toString()).type === "bus") got = true;
    });

    publishToTopic("events", { type: "bus", topic: "events" });
    await new Promise((r) => setTimeout(r, 200));

    expect(got).toBe(false);
    ws.close();
  });

  it("stops delivering after the socket closes", async () => {
    const ws = connect();
    await opened(ws);
    ws.send(JSON.stringify({ type: "subscribe_topic", topic: "events" }));
    await new Promise((r) => setTimeout(r, 100));

    ws.close();
    await new Promise((r) => setTimeout(r, 200)); // let the close handler run

    // The registry must have dropped the socket, or it would leak forever.
    expect(publishToTopic("events", {})).toBe(0);
  });

  it("rejects an unsupported protocol version on subscription", async () => {
    const ws = connect();
    await opened(ws);
    const err = nextMessage(ws, (m) => m.type === "error");
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "sess_test", protocolVersion: 99 }));
    const result = await err;
    expect(result.type).toBe("error");
    expect(String(result.error)).toMatch(/unsupported protocol version 99/i);
    ws.close();
  });

  it("does not claim per-call gating for an inactive unknown session", async () => {
    const ws = connect();
    await opened(ws);
    const ack = nextMessage(ws, (m) => m.type === "subscribed");
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "sess_test", protocolVersion: 1 }));
    expect(await ack).toMatchObject({
      type: "subscribed",
      protocolVersion: 1,
      capabilities: {
        streaming: true,
        gating: false,
        listener: true,
        attachments: true,
      },
    });
    ws.close();
  });
});

describe("heartbeat", () => {
  /**
   * A client that dies without a clean close (power loss, `kill -9`) leaves a
   * half-open socket the server never hears from again. Without the reap it
   * stays in `wss.clients` and in every subscriber set forever.
   *
   * Simulated by suppressing the client's automatic pong reply, which leaves the
   * TCP connection open but makes the peer look unresponsive — the same thing
   * the server sees from a dead client.
   */
  it("terminates a socket that stops answering pings", async () => {
    const heartbeatServer = createServer();
    const wss = createWebSocketServer(heartbeatServer);
    await new Promise<void>((resolve) => heartbeatServer.listen(0, "127.0.0.1", resolve));
    const hbPort = (heartbeatServer.address() as { port: number }).port;

    const timer = startHeartbeat(wss, 60); // 60ms sweeps instead of 30s

    const ws = new WebSocket(`ws://127.0.0.1:${hbPort}/api/v1/ws`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // Go silent: receive pings but never reply.
    ws.pong = () => {};

    // Two sweeps: the first pings, the second finds no pong and terminates.
    // Poll the server's own client set — the client-side 'close' event can fire
    // before the server has finished dropping the socket.
    const deadline = Date.now() + 3000;
    while (wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(wss.clients.size).toBe(0);

    clearInterval(timer);
    await new Promise<void>((resolve) => heartbeatServer.close(() => resolve()));
  });

  it("keeps a responsive socket connected across sweeps", async () => {
    const heartbeatServer = createServer();
    const wss = createWebSocketServer(heartbeatServer);
    await new Promise<void>((resolve) => heartbeatServer.listen(0, "127.0.0.1", resolve));
    const hbPort = (heartbeatServer.address() as { port: number }).port;

    const timer = startHeartbeat(wss, 60);

    const ws = new WebSocket(`ws://127.0.0.1:${hbPort}/api/v1/ws`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // `ws` auto-pongs, so a healthy client should survive several sweeps.
    await new Promise((r) => setTimeout(r, 400));

    expect(wss.clients.size).toBe(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.close();
    clearInterval(timer);
    await new Promise<void>((resolve) => heartbeatServer.close(() => resolve()));
  });
});
