import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyAuth } from "@barry-rocks/sdk/services/http";
import { InstallationPrincipalSchema } from "@barry-rocks/sdk/internal/auth";
import { Barry } from "@barry-rocks/sdk";
import { identities, owner } from "@barry-rocks/identities-bag";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { authorizeSessionExecution, SessionExecutionResourceUnavailable } from "@barry-rocks/sessions-bag/execution-authorization";
import { sessionLifecycleRouter } from "./routes/session-lifecycle.js";
import { sessionRuntime } from "./session-runtime.js";
import { sessionsRouter } from "./routes/sessions.js";

let dir: string;
let server: Server | undefined;
const principal = InstallationPrincipalSchema.parse({ kind: "installation", actorId: 2, credentialId: "installation" });
beforeEach(() => {
  closeIdentitiesStore(); closeSessionsDb();
  dir = mkdtempSync(join(tmpdir(), "barry-runtime-authority-"));
  vi.stubEnv("BARRY_IDENTITIES_DB", join(dir, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(dir, "sessions.db"));
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id, token, type, name) VALUES(1,'one','user','One'),(2,'two','user','Two')").run();
  db.prepare("INSERT INTO identities(id, token, actor_id, name) VALUES(1,'id-one',1,'One'),(2,'id-two',2,'Two')").run();
  owner.installation().bind({ actorId: 2, actorToken: "two" });
  // Installed as the service installs them: the real subjects over this store.
  Barry.use(identities, sessions);
  const insert = getSessionsSqlite().prepare("INSERT INTO sessions(id, user_id, identity_id, metadata) VALUES(?,?,?,'{}')");
  insert.run("owned", 2, 2); insert.run("foreign", 1, 1);
  insert.run("wrong-identity", 2, 1); insert.run("legacy-owned", null, 2);
});
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
  Barry.reset();
  closeSessionsDb(); closeIdentitiesStore(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function listen(verifyCredential: (credential: string) => typeof principal | null = credential => credential === "fixture" ? principal : null): Promise<string> {
  const app = express(); app.use(express.json());
  applyAuth(app, { verifyCredential, policy: () => null });
  app.use("/api/v1/sessions", sessionsRouter, sessionLifecycleRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  return `http://127.0.0.1:${address.port}/api/v1/sessions`;
}

it("checks the current owner, session user and canonical identity before execution", async () => {
  expect(Object.isFrozen(await authorizeSessionExecution(principal, { sessionId: "owned" }))).toBe(true);
  await expect(authorizeSessionExecution(principal, { sessionId: "legacy-owned" })).resolves.toEqual(principal);
  await expect(authorizeSessionExecution(principal, { identityId: 2 })).resolves.toEqual(principal);
  for (const sessionId of ["foreign", "wrong-identity", "missing"]) await expect(authorizeSessionExecution(principal, { sessionId })).rejects.toThrow();
  await expect(authorizeSessionExecution(principal, { identityId: 1 })).rejects.toThrow("ownership mismatch");
  await expect(authorizeSessionExecution({ kind: "installation", actorId: 1, credentialId: "installation" }, {})).rejects.toThrow("owner is unavailable");
});

it("keeps device execution closed until full tool and execution-bound enforcement is available", async () => {
  await expect(authorizeSessionExecution({ kind: "device", credentialId: "device", actorId: 2, identityIds: [2], scopes: ["sessions:turn"] }, { sessionId: "owned" })).rejects.toThrow("not available");
});

it("refuses HTTP session mutations before delivery or session side effects, ignoring body principals", async () => {
  const url = await listen();
  const db = getSessionsSqlite();
  const changes = db.prepare("SELECT total_changes() AS n").get();
  for (const [method, path] of [["POST", "foreign/message"], ["POST", "foreign/stop"], ["POST", "foreign/interrupt"], ["POST", "foreign/attach"], ["POST", "foreign/detach"], ["PATCH", "foreign"], ["DELETE", "foreign"]]) {
    const response = await fetch(`${url}/${path}`, { method, headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ content: "spoof", clientMessageId: "spoof", authPrincipal: { actorId: 1 }, actorId: 1 }) });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("two");
  }
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(db.prepare("SELECT user_id, identity_id, metadata FROM sessions WHERE id='foreign'").get()).toEqual({ user_id: 1, identity_id: 1, metadata: "{}" });
});

it("forwards the middleware's verified principal separately to live session delivery", async () => {
  const url = await listen();
  vi.spyOn(sessionRuntime, "getActiveSession").mockReturnValue({ id: "owned", sessionId: "hosted", status: "waiting" } as never);
  const send = vi.spyOn(sessionRuntime, "sendMessage").mockResolvedValue(undefined);
  const response = await fetch(`${url}/owned/message`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
  expect(response.status).toBe(200);
  expect(send).toHaveBeenCalledWith("owned", "hello", { clientMessageId: undefined, reuseClientMessageRow: false }, principal);
});

it("denies hook and archive mutations of foreign sessions before any durable writes", async () => {
  const url = await listen();
  const db = getSessionsSqlite();
  const before = db.prepare("SELECT total_changes() AS n").get();
  for (const sessionId of ["foreign", "wrong-identity"]) {
    for (const [path, body] of [
      ["start", { session_id: sessionId, name: "spoof", identity_id: 2 }],
      ["end", { session_id: sessionId }],
      [`${sessionId}/archive`, {}],
    ] as const) {
      const response = await fetch(`${url}/${path}`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ ...body, authPrincipal: { actorId: 1 }, actorId: 1 }) });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("ownership mismatch");
    }
  }
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 4 });
});

it("denies new hook sessions selecting foreign identities explicitly or through the server environment", async () => {
  const url = await listen();
  const db = getSessionsSqlite();
  const before = db.prepare("SELECT total_changes() AS n").get();
  for (const identity_id of [1, 999]) {
    const response = await fetch(`${url}/start`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "new", identity_id }) });
    expect(response.status).toBe(403);
  }
  vi.stubEnv("BARRY_ID", "1");
  const response = await fetch(`${url}/start`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "new" }) });
  expect(response.status).toBe(403);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(db.prepare("SELECT id FROM sessions WHERE id='new'").get()).toBeUndefined();
});

it("allows the installation owner to archive an owned session", async () => {
  const url = await listen();
  const foreign = getSessionsSqlite().prepare("SELECT state FROM sessions WHERE id='foreign'").get();
  const response = await fetch(`${url}/owned/archive`, { method: "POST", headers: { Authorization: "Bearer fixture" } });
  expect(response.status).toBe(200);
  expect(getSessionsSqlite().prepare("SELECT state FROM sessions WHERE id='owned'").get()).toEqual({ state: "archived" });
  expect(getSessionsSqlite().prepare("SELECT state FROM sessions WHERE id='foreign'").get()).toEqual(foreign);
});

it("invalidates only owned sessions for an owned canonical identity", async () => {
  const url = await listen();
  getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,metadata) VALUES('foreign-user',1,2,'{}')").run();
  vi.spyOn(sessionRuntime, "getActiveSessionIds").mockReturnValue(["owned", "foreign", "foreign-user", "missing"]);
  const invalidate = vi.spyOn(sessionRuntime, "invalidateSessionTools").mockReturnValue(undefined);
  const response = await fetch(`${url}/invalidate-tools`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ identityId: "2" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, invalidated: 1 });
  expect(invalidate.mock.calls).toEqual([["owned"]]);
});

it("refuses foreign, missing and malformed identity refresh targets without invalidating tools", async () => {
  const url = await listen();
  const active = vi.spyOn(sessionRuntime, "getActiveSessionIds").mockReturnValue(["owned", "foreign"]);
  const invalidate = vi.spyOn(sessionRuntime, "invalidateSessionTools").mockReturnValue(undefined);
  for (const [identityId, status] of [[1, 403], [999, 403], ["2junk", 400], ["0", 400], [{ actorId: 2 }, 400]] as const) {
    const response = await fetch(`${url}/invalidate-tools`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ identityId, authPrincipal: { actorId: 1 } }) });
    expect(response.status).toBe(status);
  }
  expect(active).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
});

it("rechecks the original credential after selecting sessions and before a tool invalidation", async () => {
  let valid = true;
  const url = await listen(credential => credential === "fixture" && valid ? principal : null);
  vi.spyOn(sessionRuntime, "getActiveSessionIds").mockImplementation(() => { valid = false; return ["owned"]; });
  const invalidate = vi.spyOn(sessionRuntime, "invalidateSessionTools").mockReturnValue(undefined);
  const response = await fetch(`${url}/invalidate-tools`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ identityId: 2 }) });
  expect(response.status).toBe(403);
  expect(invalidate).not.toHaveBeenCalled();
});

it("records a launch's guarantees on an owned session, keeping only the guarantee fields", async () => {
  identitiesSqlite().prepare("INSERT INTO actors(id, token, type, name) VALUES(3,'barry','agent','Barry')").run();
  const url = await listen();
  const guarantees = { capture: "post-hoc", delivery: "tool-call", steer: false, interrupt: false, gating: "static", keepsVendorUi: true, identity: "mcp-url" };
  const response = await fetch(`${url}/start`, {
    method: "POST",
    headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "owned", mode: "guest", guarantees: { ...guarantees, injected: "ignored", steer: "yes" } }),
  });
  expect(response.status).toBe(200);
  const row = getSessionsSqlite().prepare("SELECT metadata FROM sessions WHERE id='owned'").get() as { metadata: string };
  const { steer: _steer, ...wellTyped } = guarantees;
  expect(JSON.parse(row.metadata)).toMatchObject({ mode: "guest", guarantees: wellTyped });
  expect(JSON.parse(row.metadata).guarantees).not.toHaveProperty("injected");
});

it("classifies a missing session as unavailable rather than another user's resource", async () => {
  await expect(authorizeSessionExecution(principal, { sessionId: "missing" })).rejects.toBeInstanceOf(SessionExecutionResourceUnavailable);
  const url = await listen();
  const response = await fetch(`${url}/missing/message`, { method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("cannot control");
});
