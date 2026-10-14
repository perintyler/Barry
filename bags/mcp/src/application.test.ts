import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { listenOnAssignedPort } from "@barry-rocks/sdk/services";
import type { BagRegistrySnapshot } from "@barry-rocks/sdk/bags";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Barry, type Service } from "@barry-rocks/sdk";
import { fakeServices } from "@barry-rocks/sdk/testing";
import { access, identities, owner } from "@barry-rocks/identities-bag";
import { sessions } from "@barry-rocks/sessions-bag";
import { closeIdentitiesStore, identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { approveExecutionScope } from "@barry-rocks/sdk/bounds";
import { mintWorkflowSessionCredential } from "@barry-rocks/sdk/internal/auth";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import * as sessionsClient from "@barry-rocks/sessions-bag/client";
import { WorkflowAuthorization } from "./workflow-authorization.js";
vi.mock("@barry-rocks/sdk/adapters/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/adapters/models")>(),
  createModels: vi.fn(() => ({
    embedding: () => ({ embed: async () => ({ embeddings: [[0]] }) }),
  })),
}));
import { createModels } from "@barry-rocks/sdk/adapters/models";
import { startMcpApplication } from "./application.js";
const handles: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
// The real subjects over each test's scratch stores, as server-main installs them.
beforeEach(() => Barry.use(identities, sessions));
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  if (directories.length) { closeIdentitiesStore(); closeSessionsDb(); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  Barry.reset();
});

it("requires a bound operator and strict original credentials on protected MCP control routes", async () => {
  closeIdentitiesStore();
  const directory = mkdtempSync(join(tmpdir(), "barry-mcp-authorization-"));
  directories.push(directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  vi.stubEnv("BARRY_SECRET", "fixture-secret");
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'one','user','One'),(2,'two','user','Two')").run();
  db.prepare("INSERT INTO identities(id,token,actor_id,name) VALUES(1,'identity-one',1,'One'),(2,'identity-two',2,'Two')").run();
  closeSessionsDb();
  const sessionDb = getSessionsSqlite();
  sessionDb.prepare("INSERT INTO sessions(id,user_id,identity_id,metadata) VALUES('owned',1,1,'{}'),('foreign',2,2,'{}'),('foreign-user',2,1,'{}')").run();
  const port = await reservePort();
  handles.push(await startMcpApplication({ port, snapshot }));
  const url = `http://127.0.0.1:${port}`;
  const refresh = (token: string, extra: Record<string, string> = {}, body: Record<string, unknown> = {}) => fetch(`${url}/refresh-tools`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body),
  });
  expect((await fetch(`${url}/health`)).status).toBe(200);
  const unresolved = await refresh("fixture-secret");
  expect(unresolved.status).toBe(503);
  expect(await unresolved.text()).not.toContain("owner unresolved");
  owner.installation().bind({ actorId: 1, actorToken: "one" });
  const accepted = await refresh("fixture-secret");
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ ok: true, sessions: {} });
  const changes = sessionDb.prepare("SELECT total_changes() AS n").get();
  for (const sessionId of ["foreign", "foreign-user", "missing"]) {
    expect((await refresh("fixture-secret", {}, { sessionId, authPrincipal: { actorId: 2 } })).status).toBe(403);
  }
  for (const identityId of ["2", "999"]) {
    expect((await refresh("fixture-secret", {}, { identityId })).status).toBe(403);
  }
  expect((await refresh("fixture-secret", {}, { identityId: "1junk" })).status).toBe(400);
  const owned = await refresh("fixture-secret", {}, { sessionId: "owned" });
  expect(owned.status).toBe(200);
  expect(await owned.json()).toEqual({ ok: true, sessions: { owned: { transports: 0, changed: 0 } } });
  expect(sessionDb.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect((await refresh("fixture-secret trailing")).status).toBe(401);
  expect((await refresh("fixture-secret", { "x-barry-secret": "different" })).status).toBe(401);
  const store = access.devices();
  const pending = store.request({ clientName: "Phone", requestedScopes: ["sessions:turn"], requestedIdentityIds: [1] }, "source");
  store.authorize(pending.pairingCode, 1, { scopes: ["sessions:turn"], identityIds: [1] });
  const claim = store.claim(pending.pollToken);
  if (claim.status !== "authorized") throw new Error("Fixture pairing failed");
  expect((await refresh(claim.deviceToken)).status).toBe(403);
  vi.stubEnv("BARRY_SECRET", "rotated-secret");
  expect((await refresh("fixture-secret")).status).toBe(401);
  expect((await refresh("rotated-secret")).status).toBe(200);
});
it("serves service control only to the instance secret, behind authentication", async () => {
  closeIdentitiesStore();
  const directory = mkdtempSync(join(tmpdir(), "barry-mcp-services-"));
  directories.push(directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  vi.stubEnv("BARRY_SECRET", "fixture-secret");
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'one','user','One')").run();
  db.prepare("INSERT INTO identities(id,token,actor_id,name) VALUES(1,'identity-one',1,'One')").run();
  owner.installation().bind({ actorId: 1, actorToken: "one" });
  const store = access.devices();
  const pending = store.request({ clientName: "Phone", requestedScopes: ["sessions:turn"], requestedIdentityIds: [1] }, "source");
  store.authorize(pending.pairingCode, 1, { scopes: ["sessions:turn"], identityIds: [1] });
  const claim = store.claim(pending.pollToken);
  if (claim.status !== "authorized") throw new Error("Fixture pairing failed");
  // The route acts as the owner when a request carries no principal, so only the mount order keeps it behind the secret.
  const service: Service = { key: "fixture.api", bag: "fixture", name: "api", kind: "service", state: "running", registered: true, enabled: true, system: false, pid: null, port: null, address: null, health: "unknown", restarts: 0, startedAt: null, lastExitCode: null, workingDirectory: "/fixture", loopbackOnly: null, conflict: null, problem: null };
  const list = vi.fn(async () => [service]), control = vi.fn(async () => service);
  Barry.use(fakeServices({ list, get: control, start: control, stop: control, restart: control }));
  const port = await reservePort();
  handles.push(await startMcpApplication({ port, snapshot }));
  const url = `http://127.0.0.1:${port}/api/v1/services`;
  for (const [method, path] of [["GET", ""], ["GET", "/fixture.api"], ["POST", "/fixture.api/start"], ["POST", "/fixture.api/stop"], ["POST", "/fixture.api/restart"]]) {
    const call = (credential?: string) => fetch(url + path, { method, headers: credential ? { Authorization: `Bearer ${credential}` } : {} });
    expect((await call()).status).toBe(401);
    expect((await call("wrong-secret")).status).toBe(401);
    expect((await call("bws3.fixture.fixture")).status).toBe(401);
    expect((await call(claim.deviceToken)).status).toBe(403);
    expect(list).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
    expect((await call("fixture-secret")).status).toBe(200);
    list.mockClear(); control.mockClear();
  }
});
const snapshot: BagRegistrySnapshot = {
  bags: [],
  registry: {},
  byName: new Map(),
};
async function reservePort() {
  const server = await listenOnAssignedPort(createServer(), { PORT: "0" });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
it("serves an explicitly supplied catalog and releases the listener on repeated close", async () => {
  vi.stubEnv("BARRY_SECRET", "fixture-secret");
  const port = await reservePort();
  const handle = await startMcpApplication({ port, snapshot });
  handles.push(handle);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    transports: 0,
    maxTransports: expect.any(Number),
    leakWarnTransports: expect.any(Number),
    ready: "ready",
  });
  await Promise.all([handle.close(), handle.close()]);
  const reused = await listenOnAssignedPort(createServer(), {
    PORT: String(port),
  });
  await new Promise<void>((resolve) => reused.close(() => resolve()));
});
it("cleans up a listener acquired before preparation fails", async () => {
  vi.stubEnv("BARRY_SECRET", "fixture-secret");
  const port = await reservePort();
  vi.mocked(createModels).mockImplementationOnce(() => {
    throw new Error("fixture preparation failed");
  });
  await expect(startMcpApplication({ port, snapshot })).rejects.toThrow(
    "fixture preparation failed",
  );
  const reused = await listenOnAssignedPort(createServer(), {
    PORT: String(port),
  });
  const closed = once(reused, "close");
  reused.close();
  await closed;
});

it.each(["credential", "ownership", "identity"] as const)("binds transports and closes idle streams after %s changes", async change => {
  closeIdentitiesStore(); closeSessionsDb();
  const directory = mkdtempSync(join(tmpdir(), "barry-mcp-transports-")); directories.push(directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
  vi.stubEnv("BARRY_SECRET", "fixture-secret");
  const identities = identitiesSqlite();
  identities.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'one','user','One'),(2,'two','user','Two')").run();
  identities.prepare("INSERT INTO identities(id,token,actor_id,name) VALUES(1,'identity-one',1,'One'),(2,'identity-two',2,'Two')").run();
  owner.installation().bind({ actorId: 1, actorToken: "one" });
  const sessions = getSessionsSqlite();
  sessions.prepare("INSERT INTO sessions(id,user_id,identity_id,metadata) VALUES('owned',1,1,'{}'),('other-owned',1,1,'{}'),('foreign',2,2,'{}'),('foreign-user',2,1,'{}')").run();
  const port = await reservePort(); handles.push(await startMcpApplication({ port, snapshot }));
  const url = `http://127.0.0.1:${port}`;
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } };
  const post = (path: string, body: unknown = initialize, id?: string) => fetch(url + path, { method: "POST", headers: { Authorization: "Bearer fixture-secret", "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(id ? { "mcp-session-id": id } : {}) }, body: JSON.stringify(body) });
  const before = sessions.prepare("SELECT total_changes() AS n").get();
  for (const endpoint of ["/mcp", "/mcp/ns/example"]) {
    for (const sessionId of ["foreign", "foreign-user", "missing"]) {
      const denied = await post(`${endpoint}?sessionId=${sessionId}`);
      expect(denied.status).toBe(403); await denied.text();
    }
  }
  expect(sessions.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ transports: 0 });
  const admitted = await post("/mcp?sessionId=owned");
  expect(admitted.status).toBe(200); await admitted.text();
  const id = admitted.headers.get("mcp-session-id"); expect(id).toEqual(expect.any(String));
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  for (const path of ["/mcp?sessionId=other-owned", "/mcp?sessionId=foreign", "/mcp/ns/example?sessionId=owned"]) {
    const denied = await post(path, list, id!); expect(denied.status).toBe(403); await denied.text();
  }
  const allowed = await post("/mcp", list, id!); expect(allowed.status).toBe(200); await allowed.text();
  const call = await post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tool_search", arguments: { query: "fixture" } } }, id!);
  expect(call.status).toBe(200);
  const frames = (await call.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  expect(frames).toContainEqual(expect.objectContaining({ id: 3, result: expect.objectContaining({ content: expect.any(Array) }) }));
  expect(frames.find(frame => frame.id === 3)?.result.isError).not.toBe(true);
  const namespace = await post("/mcp/ns/example?sessionId=other-owned");
  expect(namespace.status).toBe(200); await namespace.text();
  const namespaceId = namespace.headers.get("mcp-session-id"); expect(namespaceId).toEqual(expect.any(String));
  const namespaceAllowed = await post("/mcp/ns/example", list, namespaceId!);
  expect(namespaceAllowed.status).toBe(200); await namespaceAllowed.text();
  const namespaceDenied = await post("/mcp", list, namespaceId!);
  expect(namespaceDenied.status).toBe(403); await namespaceDenied.text();
  for (const method of ["GET", "DELETE"]) {
    const wrongEndpoint = await fetch(`${url}/mcp/ns/example`, { method, headers: { Authorization: "Bearer fixture-secret", "mcp-session-id": id!, Accept: "text/event-stream" } });
    expect(wrongEndpoint.status).toBe(403); await wrongEndpoint.text();
  }
  sessions.prepare("UPDATE sessions SET user_id=2 WHERE id='owned'").run();
  const denied = await post("/mcp", list, id!); expect([403, 404]).toContain(denied.status); await denied.text();
  const missing = await post("/mcp", list, "unknown-transport"); expect(missing.status).toBe(404); await missing.text();
  const stream = await fetch(`${url}/mcp/ns/example`, { headers: { Authorization: "Bearer fixture-secret", "mcp-session-id": namespaceId!, Accept: "text/event-stream" }, signal: AbortSignal.timeout(5000) });
  expect(stream.status).toBe(200);
  const revokedAt = performance.now();
  if (change === "credential") vi.stubEnv("BARRY_SECRET", "rotated-secret");
  else if (change === "ownership") sessions.prepare("UPDATE sessions SET user_id=2 WHERE id='other-owned'").run();
  else identities.prepare("UPDATE identities SET actor_id=2 WHERE id=1").run();
  if (change === "credential") {
    const stale = await fetch(`${url}/mcp/ns/example`, { method: "POST", headers: { Authorization: "Bearer rotated-secret", "mcp-session-id": namespaceId!, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(list) });
    expect([403, 404]).toContain(stale.status); await stale.text();
  }
  const reader = stream.body!.getReader();
  try { while (!(await reader.read()).done) { /* drain */ } }
  finally { reader.releaseLock(); }
  expect(performance.now() - revokedAt).toBeLessThan(2500);
  expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ transports: 0 });
});

it.each(["secret", "scope", "session-owner", "identity-owner", "identity-binding", "expiry", "disconnect", "end", "resume", "run"] as const)("invalidates signed workflow streams after %s changes", async change => {
  closeIdentitiesStore(); closeSessionsDb();
  const directory = mkdtempSync(join(tmpdir(), "barry-workflow-stream-")); directories.push(directory);
  vi.stubEnv("BARRY_HOME", directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  vi.stubEnv("BARRY_SESSIONS_DB", "");
  const secret = "workflow_fixture_signing_secret_with_enough_entropy";
  vi.stubEnv("BARRY_SECRET", secret);
  const stores = join(directory, "app-support", "stores");
  mkdirSync(join(stores, "generations", "fixture"), { recursive: true });
  writeFileSync(join(stores, "active.json"), JSON.stringify({ id: "fixture" }));
  const identities = identitiesSqlite();
  identities.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'one','user','One'),(2,'two','user','Two')").run();
  identities.prepare("INSERT INTO identities(id,token,actor_id,name) VALUES(1,'workflow-identity',1,'Workflow'),(2,'other-identity',1,'Other')").run();
  owner.installation().bind({ actorId: 1, actorToken: "one" });
  const port = await reservePort(); handles.push(await startMcpApplication({ port, snapshot }));
  const scope = await approveExecutionScope({ identity: installationRegistry().identityId(1), traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
  const metadata = { workflow_scope: scope, workflow_identity_id: 1 };
  const sessions = withStoreContext({ identity: "workflow" }, () => getSessionsSqlite());
  sessions.prepare("INSERT INTO sessions(id,user_id,identity_id,workflow_credential_id,metadata) VALUES('workflow',1,1,'11111111-1111-4111-8111-111111111111',?)").run(JSON.stringify(metadata));
  let token = mintWorkflowSessionCredential(secret, { credentialId: "11111111-1111-4111-8111-111111111111", actorId: 1, identityId: 1, sessionId: "workflow", identity: scope.identity!, scopeFingerprint: scope.fingerprint, expiresAt: Date.now() + (change === "expiry" ? 1500 : 60_000) });
  const url = `http://127.0.0.1:${port}/mcp?sessionId=workflow`;
  const post = (body: unknown, id?: string, signal?: AbortSignal) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(id ? { "mcp-session-id": id } : {}) }, body: JSON.stringify(body), signal });
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "workflow-fixture", version: "1" } } };
  if (change === "disconnect") {
    const record = await withStoreContext({ identity: "workflow" }, () => sessionsClient.getSession("workflow"));
    let started!: () => void;
    let finish!: (value: typeof record) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const lookup = vi.spyOn(sessionsClient, "getSession").mockImplementationOnce(async () => { started(); return await new Promise(resolve => { finish = resolve; }); });
    const checker = vi.spyOn(WorkflowAuthorization.prototype, "check");
    const cancellation = new AbortController();
    try {
      const pending = post(initialize, undefined, cancellation.signal).catch(error => error);
      await ready; cancellation.abort();
      expect((await pending).name).toBe("AbortError");
      await vi.waitFor(() => expect(checker.mock.calls[0]?.[0]?.aborted).toBe(true));
      finish(record); await new Promise<void>(resolve => setImmediate(resolve));
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({ transports: 0 });
    } finally { lookup.mockRestore(); checker.mockRestore(); }
    return;
  }
  const initialized = await post(initialize);
  expect(initialized.status).toBe(200); await initialized.text();
  const id = initialized.headers.get("mcp-session-id")!;
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tool_search", arguments: { query: "fixture" } } }, id);
  expect(call.status).toBe(200);
  const frames = (await call.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  expect(frames).toContainEqual(expect.objectContaining({ id: 2, result: expect.objectContaining({ content: expect.any(Array) }) }));
  expect(frames.find(frame => frame.id === 2)?.result.isError).not.toBe(true);
  const stream = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "mcp-session-id": id, Accept: "text/event-stream" }, signal: AbortSignal.timeout(6000) });
  expect(stream.status).toBe(200);
  const changedAt = performance.now();
  if (change === "secret") vi.stubEnv("BARRY_SECRET", "rotated_workflow_secret_with_enough_entropy");
  else if (change === "scope") sessions.prepare("UPDATE sessions SET metadata=? WHERE id='workflow'").run(JSON.stringify({ ...metadata, workflow_scope: { ...scope, tools: { "filesystem:write": "write" } } }));
  else if (change === "session-owner") sessions.prepare("UPDATE sessions SET user_id=2 WHERE id='workflow'").run();
  else if (change === "identity-owner") identities.prepare("UPDATE identities SET actor_id=2 WHERE id=1").run();
  else if (change === "identity-binding") sessions.prepare("UPDATE sessions SET identity_id=2,metadata=? WHERE id='workflow'").run(JSON.stringify({ ...metadata, workflow_identity_id: 2 }));
  else if (change === "run") sessions.prepare("UPDATE sessions SET workflow_credential_id='22222222-2222-4222-8222-222222222222' WHERE id='workflow'").run();
  else if (change === "end" || change === "resume") {
    sessions.prepare("UPDATE sessions SET state='closed',ended_at=? WHERE id='workflow'").run(new Date().toISOString());
    if (change === "resume") sessions.prepare("UPDATE sessions SET state='open',ended_at=NULL WHERE id='workflow'").run();
  }
  const reader = stream.body!.getReader();
  try { while (!(await reader.read()).done) { /* drain */ } }
  finally { reader.releaseLock(); }
  expect(performance.now() - changedAt).toBeLessThan(2500);
  const denied = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, id);
  expect(denied.status).toBe(401); expect(await denied.text()).not.toContain(token);
  if (change === "end" || change === "resume" || change === "run") {
    sessions.prepare("UPDATE sessions SET state='open',ended_at=NULL WHERE id='workflow'").run();
    const credentialId = await withStoreContext({ identity: "workflow" }, () => sessionsClient.issueWorkflowCredential("workflow", { actorId: 1, identityId: 1, scopeFingerprint: scope.fingerprint }));
    expect(credentialId).not.toBeNull();
    token = mintWorkflowSessionCredential(secret, { credentialId: credentialId!, actorId: 1, identityId: 1, sessionId: "workflow", identity: scope.identity!, scopeFingerprint: scope.fingerprint, expiresAt: Date.now() + 60_000 });
    const resumed = await post(initialize);
    expect(resumed.status).toBe(200); await resumed.text();
  }
});
