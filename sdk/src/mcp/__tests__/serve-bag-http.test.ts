import { describe, it, expect, afterEach } from "vitest";
import { serveBagOverHttp } from "../bag-server.js";

/**
 * SDK-5: the "serve a local bag as a remote bag" HTTP path must not be wedged
 * by a single bad POST, must bound request bodies, must gate on the instance
 * secret when one is configured, and must evict idle sessions.
 */
const FIXTURE_BAG_DIR = new URL("../../../../bags/events", import.meta.url).pathname;

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(opts: { secret?: string } = {}) {
  const handle = await serveBagOverHttp({ bagDir: FIXTURE_BAG_DIR, port: 0, ...opts });
  close = handle.close;
  return handle.url;
}

describe("serveBagOverHttp hardening (SDK-5)", () => {
  it("answers 400 for malformed JSON instead of hanging the connection", async () => {
    const url = await serve();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    // Crucially, the response is ended — the request resolves rather than hanging.
    await res.text();
  });

  it("answers 413 for a body over the 1 MB cap", async () => {
    const url = await serve();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_000_001),
    });
    expect(res.status).toBe(413);
    await res.text();
  });

  it("serves /health unauthenticated", async () => {
    const url = await serve({ secret: "s3cret-value" });
    const health = url.replace(/\/mcp$/, "/health");
    const res = await fetch(health);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects /mcp without the configured secret, admits it with one", async () => {
    const secret = "barry_serve_test_secret";
    const url = await serve({ secret });

    const unauth = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(unauth.status).toBe(401);
    await unauth.text();

    // With the secret the request gets past the gate (no session → 400, not 401).
    const authed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });
    expect(authed.status).toBe(400);
    expect(await authed.text()).toContain("No session");
  });

  it("initializes a session and returns a session id when unauthenticated-by-design", async () => {
    const url = await serve();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    await res.text();
  });
});
