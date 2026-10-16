import express from "express";
import type { Request } from "express";
import { it, expect } from "vitest";
import { authorizeRequest, requestCredential, mintWorkflowSessionCredential, verifyWorkflowSessionCredential, type WorkflowSessionCredential } from "@barry-rocks/sdk/internal/auth";


import { TransportAuthorization } from "./transport-authorization.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

it("keeps verified workflow grants separate from operators and differently scoped workflow grants", async () => {
  const secret = "fixture-workflow-signing-secret-at-least-32";
  const claims = { credentialId: "11111111-1111-4111-8111-111111111111", actorId: 1, identityId: 1, sessionId: "work-a", identity: "identity-a", boundFingerprint: "a".repeat(64), expiresAt: Date.now() + 60_000 };
  const workflow = new WeakMap<Request, WorkflowSessionCredential>();
  let workflowValid = true;
  let invalidateBeforeDispatch = false;
  const authorization = new TransportAuthorization(request => workflow.get(request), async () => workflowValid);
  const operator = authorizeRequest({ verifyCredential: token => token === "operator" ? { kind: "installation", actorId: 1, credentialId: "installation" } : null, policy: () => null });
  const app = express(); app.use(express.json());
  app.use((request, response, next) => {
    const token = requestCredential(request);
    if (!token?.startsWith("bws3.")) return operator(request, response, next);
    try { workflow.set(request, verifyWorkflowSessionCredential(token, secret)); next(); }
    catch { response.status(401).end(); }
  });
  app.use(authorization.middleware);
  let effects = 0;
  let frames = 0;
  let closures = 0;
  const transport: Transport = { start: async () => {}, send: async () => { frames++; }, close: async () => { closures++; } };
  app.post("/mcp", async (request, response) => {
    if (request.body?.method === "initialize") { authorization.bind("transport-1", request, transport); response.json({ id: "transport-1" }); }
    else {
      if (invalidateBeforeDispatch) workflowValid = false;
      if (!await authorization.authorizeCall()) { response.status(403).end(); return; }
      effects++; response.json({ ok: true });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const request = (token: string, id?: string, body: unknown = { method: "tools/call", authPrincipal: { kind: "workflow", ...claims } }) => fetch(`${url}?sessionId=work-a`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(id ? { "mcp-session-id": id } : {}) }, body: JSON.stringify(body) });
  try {
    const token = mintWorkflowSessionCredential(secret, claims);
    const initial = await request(token, undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });
    expect(initial.status).toBe(200); await initial.text();
    for (const credential of ["operator", mintWorkflowSessionCredential(secret, { ...claims, credentialId: "22222222-2222-4222-8222-222222222222" }), mintWorkflowSessionCredential(secret, { ...claims, actorId: 2 }), mintWorkflowSessionCredential(secret, { ...claims, identityId: 2 }), mintWorkflowSessionCredential(secret, { ...claims, identity: "identity-b" }), mintWorkflowSessionCredential(secret, { ...claims, boundFingerprint: "b".repeat(64) }), mintWorkflowSessionCredential(secret, { ...claims, expiresAt: claims.expiresAt + 1000 })]) {
      const denied = await request(credential, "transport-1"); expect(denied.status).toBe(403); await denied.text();
    }
    expect(effects).toBe(0);
    const accepted = await request(token, "transport-1"); expect(accepted.status).toBe(200); await accepted.text(); expect(effects).toBe(1);
    await transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(frames).toBe(1);
    invalidateBeforeDispatch = true;
    const stale = await request(token, "transport-1"); expect(stale.status).toBe(403); await stale.text(); expect(effects).toBe(1);
    await expect(transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).rejects.toThrow("Transport unavailable");
    expect(frames).toBe(1); expect(closures).toBe(1);
    authorization.release("transport-1");
    const released = await request(token, "transport-1"); expect(released.status).toBe(404); await released.text(); expect(effects).toBe(1);
  } finally { authorization.release("transport-1"); await new Promise<void>(resolve => server.close(() => resolve())); }
});
