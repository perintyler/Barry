import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAuth } from "@barry-rocks/sdk/services/http";
import { AuthPrincipalSchema } from "@barry-rocks/sdk/internal/auth";
import { access } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { getSession } from "@barry-rocks/sessions-bag/client";
import { requestSessionId, sessionRequestAuthorization } from "./request-authorization.js";
import { sessionsRouter } from "./routes/sessions.js";

let server: Server;
let baseUrl: string;
let directory: string;
let handlerCalls: number;
let changeAfterVerification: "revoked" | "expired" | "grant" | undefined;
beforeEach(async () => {
  closeIdentitiesStore();
  closeSessionsDb();
  directory = mkdtempSync(join(tmpdir(), "barry-session-authorization-"));
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  identitiesSqlite().prepare("INSERT INTO actors (id, token, type, name) VALUES (1, 'one', 'user', 'one'), (2, 'two', 'user', 'two')").run();
  identitiesSqlite().prepare("INSERT INTO identities (id, token, actor_id, name) VALUES (1, 'identity-one', 1, 'one'), (2, 'identity-two', 2, 'two'), (3, 'identity-three', 1, 'three')").run();
  const insert = getSessionsSqlite().prepare("INSERT INTO sessions (id, user_id, identity_id, metadata) VALUES (?, ?, ?, ?)");
  for (const [id, user, identity] of [["owned", 1, 1], ["foreign", 2, 2], ["ungranted", 1, 3], ["mismatched", 2, 1], ["unowned", null, null], ["identity-owned", null, 1]] as const) insert.run(id, user, identity, JSON.stringify({ name: id }));
  handlerCalls = 0;
  changeAfterVerification = undefined;
  const app = express();
  app.use(express.json());
  const authorization = sessionRequestAuthorization();
  applyAuth(app, {
    ...authorization,
    verifyCredential: async (credential, signal) => {
      const result = await authorization.verifyCredential(credential, signal);
      const principal = result ? AuthPrincipalSchema.parse(result) : null;
      if (principal?.kind === "device" && changeAfterVerification) {
        if (changeAfterVerification === "revoked") access.devices().revoke(principal.actorId, principal.credentialId);
        else if (changeAfterVerification === "expired") identitiesSqlite().prepare("UPDATE device_credentials SET expires_at=? WHERE id=?").run(Date.now(), principal.credentialId);
        else identitiesSqlite().prepare("UPDATE device_credentials SET scopes='[\"sessions:turn\"]' WHERE id=?").run(principal.credentialId);
      }
      return principal;
    },
  });
  app.use("/api/v1/sessions", (request, response, next) => {
    if (request.path === "/" && request.method === "GET") return sessionsRouter(request, response, next);
    next();
  });
  app.use(async (request, response) => {
    handlerCalls++;
    const sessionId = requestSessionId(request);
    const session = sessionId ? await getSession(sessionId) : undefined;
    response.json({ session: session?.id, principal: request.authPrincipal, sessionId });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeSessionsDb();
  closeIdentitiesStore();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function pair(scope: "sessions:read" | "sessions:turn" = "sessions:read") {
  const store = access.devices();
  const pending = store.request({ clientName: "Phone", requestedScopes: [scope], requestedIdentityIds: [1] }, `source-${scope}`);
  store.authorize(pending.pairingCode, 1, { scopes: [scope], identityIds: [1] });
  const claim = store.claim(pending.pollToken);
  if (claim.status !== "authorized") throw new Error("Fixture pairing failed");
  return claim;
}
function request(token: string, path = "/api/v1/sessions/owned", body?: unknown, method = body === undefined ? "GET" : "POST") {
  return fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
describe("scoped session reads", () => {
  it.each(["revoked", "expired", "grant"] as const)("refuses a %s credential change after verification and before handler admission", async change => {
    const claim = pair();
    changeAfterVerification = change;
    const response = await request(claim.deviceToken);
    expect(response.status).toBe(403);
    expect(handlerCalls).toBe(0);
  });
  it("reads only a canonical granted identity with matching actor ownership", async () => {
    const claim = pair();
    const response = await request(claim.deviceToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: "owned", principal: { kind: "device", actorId: 1 } });
    expect((await request(claim.deviceToken, "/api/v1/sessions/identity-owned")).status).toBe(200);
    for (const id of ["foreign", "ungranted", "mismatched", "unowned", "missing"]) expect((await request(claim.deviceToken, `/api/v1/sessions/${id}`)).status, id).toBe(403);
    expect(handlerCalls).toBe(2);
  });
  it("classifies only bounded member reads and never permits an execution endpoint", async () => {
    const claim = pair();
    for (const suffix of ["", "/messages", "/messages/1/detail", "/context", "/changes"]) expect((await request(claim.deviceToken, `/api/v1/sessions/owned${suffix}`)).status, suffix).toBe(200);
    for (const path of ["/api/v1/sessions/picker", "/api/v1/sessions/search", "/api/v1/sessions/owned/messages/0/detail", "/api/v1/sessions/owned/context/1/detail", "/api/v1/sessions/owned/transcript", "/api/v2/sessions/owned/stream", "/api/v1/actions", "/api/v1/events", "/api/v1/sessions/%6fwned"]) expect((await request(claim.deviceToken, path)).status, path).toBe(403);
    for (const suffix of ["", "/message", "/stop", "/interrupt", "/attach", "/detach", "/messages/persist"]) expect((await request(claim.deviceToken, `/api/v1/sessions/owned${suffix}`, {}, "POST")).status, suffix).toBe(403);
    expect(handlerCalls).toBe(5);
  });
  it("rejects missing read scope, revocation and changed identity or session ownership", async () => {
    const turn = pair("sessions:turn");
    expect((await request(turn.deviceToken)).status).toBe(403);
    const claim = pair();
    getSessionsSqlite().prepare("UPDATE sessions SET user_id = 2 WHERE id = 'owned'").run();
    expect((await request(claim.deviceToken)).status).toBe(403);
    getSessionsSqlite().prepare("UPDATE sessions SET user_id = 1 WHERE id = 'owned'").run();
    access.devices().revoke(1, claim.deviceId);
    expect((await request(claim.deviceToken)).status).toBe(401);
    const renewed = pair();
    identitiesSqlite().prepare("UPDATE identities SET actor_id = 2 WHERE id = 1").run();
    expect((await request(renewed.deviceToken)).status).toBe(401);
    expect(handlerCalls).toBe(0);
  });
  it("ignores caller-supplied partition IDs on device reads", async () => {
    const claim = pair();
    const response = await request(claim.deviceToken, "/api/v1/sessions/owned?session_id=foreign&caller_session_id=foreign");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ session: "owned", sessionId: "owned" });
  });

  it("filters ownership before pagination and ignores attempted grant expansion", async () => {
    const claim = pair();
    const db = getSessionsSqlite();
    db.prepare("UPDATE sessions SET created_at = '2026-01-01T00:00:00.000Z'").run();
    db.prepare("UPDATE sessions SET created_at = '2026-03-01T00:00:00.000Z' WHERE id IN ('foreign','ungranted','mismatched','unowned')").run();
    const first = await request(claim.deviceToken, "/api/v1/sessions?limit=1&fields=id&identityIds=2,3&actorId=2&session_id=foreign");
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.sessions).toEqual([{ id: "owned" }]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await request(claim.deviceToken, `/api/v1/sessions?limit=1&fields=id&cursor=${encodeURIComponent(page.nextCursor)}`);
    expect(await second.json()).toEqual({ sessions: [{ id: "identity-owned" }], nextCursor: null });
    const enriched = await request(claim.deviceToken, "/api/v1/sessions?limit=10");
    expect(enriched.status).toBe(200);
    expect((await enriched.json()).sessions.map((session: { id: string }) => session.id)).toEqual(["owned", "identity-owned"]);
    const turn = pair("sessions:turn");
    expect((await request(turn.deviceToken, "/api/v1/sessions")).status).toBe(403);
  });
});
