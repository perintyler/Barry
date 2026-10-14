import { afterEach, expect, it } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { request } from "node:http";
import { ActivityWorker, WorkflowOwner, StorageHealth, connectOwner } from "@barry-rocks/sdk/internal/workflows";
import { DatabaseSync } from "node:sqlite";
import { workflowActorSigner } from "@barry-rocks/sdk/internal/auth";
import { sessionToken } from "@barry-rocks/sdk/auth";
import { listenOnAssignedPort, writeServiceRegistry } from "@barry-rocks/sdk/services";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";

import { callWorkflows } from "./client.js";
import { createWorkflowServer, type IdentityGrant } from "./server.js";
import { approveExecutionScope } from "@barry-rocks/sdk/bounds";
import { definitions, activities } from "./definitions.js";

const cleanup: (() => void | Promise<void>)[] = [];
const WORKER_TOKEN = "barry_wk_test-worker-credential-0123456789";
const asWorker = (token = WORKER_TOKEN) => ({ Authorization: `Bearer ${token}` });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function service(options: Partial<Parameters<typeof createWorkflowServer>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-http-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const owner = new WorkflowOwner({ id: "owner", path: join(root, "workflows.db"), definitions }); cleanup.push(() => owner.close());
  const server = createWorkflowServer({ owner, secret: "test-secret", authenticateWorker: credential => credential === WORKER_TOKEN ? "worker" : null, ...options });
  await listenOnAssignedPort(server, { PORT: "0" });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, headers: Record<string, string> = { Authorization: "Bearer test-secret" }) => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { owner, server, call, url, path: join(root, "workflows.db") };
}

it("runs a workflow through authenticated HTTP with an external activity worker", async () => {
  const { owner, call } = await service();
  const response = await call("/api/runs", { id: "network-job", type: "echo", version: "1", input: { message: "hello over HTTP" } });
  expect(response.status).toBe(201);
  const connection = connectOwner("owner", async request => {
    const response = await call("/api/worker", { request }, asWorker());
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  const worker = new ActivityWorker({ connections: [connection], activities }); cleanup.push(() => worker.stop());
  await expect.poll(async () => { await worker.tick(); return owner.get("network-job").status; }).toBe("completed");
  const detail = await (await call("/api/runs/network-job")).json();
  expect(detail.run.status).toBe("completed");
  expect((await (await call("/api/runs/network-job/payloads")).json()).outcome).toEqual({ ok: true, value: "hello over HTTP" });
  expect((await (await call(`/api/runs/network-job/command?id=${encodeURIComponent(detail.commands[0].id)}`)).json()).attempts[0].worker).toBe("worker");
  expect(owner.history("network-job").at(-1)?.type).toBe("WorkflowClosed");
  expect(await (await call("/api/runs?status=completed&search=network")).json()).toHaveLength(1);
  expect(await (await call("/api/runs?search=missing")).json()).toHaveLength(0);
});

it("rejects anonymous access, unknown worker credentials, the installation secret as a worker, and cross-site writes", async () => {
  const { call } = await service();
  expect((await call("/api/overview", undefined, {})).status).toBe(401);
  expect((await call("/api/worker", { request: { version: 1, operation: "claim" } }, asWorker("barry_wk_revoked-or-never-issued-0123456789"))).status).toBe(401);
  // The installation secret and a browser session are not worker credentials.
  expect((await call("/api/worker", { request: { version: 1, operation: "claim" } })).status).toBe(403);
  const cookie = { Cookie: `barry_session=${sessionToken("test-secret")}` };
  expect((await call("/api/runs", {}, { ...cookie, Origin: "https://evil.example" })).status).toBe(403);
  expect((await call("/api/worker", { request: { version: 1, operation: "claim" } }, cookie)).status).toBe(403);
  expect((await call("/api/worker", { request: { version: 1, operation: "cancel", id: "job" } }, asWorker())).status).toBe(400);
});

it("accepts a worker credential on POST /api/worker only, and attributes work to the worker it was issued to", async () => {
  const { owner, call } = await service();
  for (const [path, body] of [["/api/overview", undefined], ["/api/runs", { id: "x", type: "echo", version: "1", input: null }], ["/", undefined], ["/api/workers/worker", undefined]] as const) {
    expect((await call(path, body, asWorker())).status, path).toBe(401);
  }
  // The body cannot name another worker: the strict schema refuses the field.
  expect((await call("/api/worker", { worker: "other", request: { version: 2, operation: "hello", session: "s1" } }, asWorker())).status).toBe(400);
  const hello = await call("/api/worker", { request: { version: 2, operation: "hello", session: "s1" } }, asWorker());
  expect(hello.status).toBe(200);
  const { owner: answered, epoch } = await hello.json() as { owner: string; epoch: string };
  expect(answered).toBe("owner");
  expect(() => owner.assertSession("worker", "s1", epoch)).not.toThrow();
  expect(() => owner.assertSession("other", "s1", epoch)).toThrow();
});

it("rejects malformed request URLs without terminating the service", async () => {
  const { url, call } = await service();
  const address = new URL(url);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({ hostname: address.hostname, port: address.port, path: "http://[", method: "GET" }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
  expect(status).toBe(400);
  expect((await call("/health", undefined, {})).status).toBe(200);
});

it("serves a signed-in runs console and supports durable signal and cancellation controls", async () => {
  const { call, url } = await service();
  const cookie = { Cookie: `barry_session=${sessionToken("test-secret")}`, Origin: url };
  const html = await call("/", undefined, cookie);
  expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await html.text()).toContain("Start a run");
  expect((await call("/app.js", undefined, cookie)).status).toBe(200);
  // A module the page imports but the server does not list answers 404, and
  // the whole console then fails to load; waiting-reasons.js once did.
  for (const file of readdirSync(new URL("../web", import.meta.url)).filter(name => name.endsWith(".js"))) {
    expect((await call(`/${file}`, undefined, cookie)).status, file).toBe(200);
  }
  await call("/api/runs", { id: "waiting", type: "echo", version: "1", input: { message: "done", waitForSignal: true } }, cookie);
  expect((await call("/api/runs/waiting/signal", { signalId: "one", name: "continue", payload: null }, cookie)).status).toBe(200);
  const cancelled = await (await call("/api/runs/waiting/cancel", {}, cookie)).json();
  expect(cancelled.status).toBe("cancelled");
  expect((await call("/api/runs/waiting/resume", {}, cookie)).status).toBe(409);
});

it("compiles the authored workflow schema into the SDK runtime catalog", () => {
  const generated = readFileSync(new URL("../../../sdk/src/workflows/generated/migrations.ts", import.meta.url), "utf8");
  const catalog = JSON.parse(generated.slice(generated.indexOf("export default ") + "export default ".length).trim().replace(/;$/, ""));
  const authored = readdirSync(new URL("../migrations/workflows", import.meta.url)).sort().map(name => ({
    name, sql: readFileSync(new URL(`../migrations/workflows/${name}`, import.meta.url), "utf8"),
  }));
  expect(catalog).toEqual(authored);
});

it("shows frozen and current run permissions without silently expanding the grant", async () => {
  let access: "read" | "write" = "read";
  const resolve = async (job: { traits: string[]; identity?: string; harness?: string }) => approveExecutionScope({ identity: job.identity, harness: job.harness, traitNames: job.traits, traits: { documents: { name: "documents", namespaces: ["documents"], access: "readwrite" } }, tools: [{ namespace: "documents", toolName: "read", access }], boundByName: async () => undefined });
  const { call } = await service({ runAuthorization: resolve, currentRunScope: resolve });
  const request = { id: "scoped", type: "echo", version: "1", input: { message: "hello" }, job: { traits: ["documents"] } };
  expect((await call("/api/runs", request)).status).toBe(201);
  const before = await (await call("/api/runs/scoped/permissions")).json();
  expect(before.effective.allowedToolIds).toEqual(["documents:read"]);
  access = "write";
  const after = await (await call("/api/runs/scoped/permissions")).json();
  expect(after.grant.scope.tools).toEqual({ "documents:read": "read" });
  expect(after.effective.allowedToolIds).toEqual([]);
  expect(after.currentPolicyAvailable).toBe(true);
  expect((await (await call("/api/runs/scoped/resources")).json()).containmentEvidence).toBe("not-observed");
});

it("enforces signed identity visibility, operation grants, payload permission and immediate revocation", async () => {
  const key = "test-engine-key-longer-than-thirty-two-bytes";
  let revoked = false, payloadRead = false;
  const { owner, call } = await service({ actorKey: key, grants: (): Record<string, IdentityGrant> => revoked ? {} : { alice: { types: ["echo"], operations: ["start", "list", "get"], payloadRead } } });
  const sign = workflowActorSigner({ identity: "alice", traits: [], bound: null, allowedToolIds: ["workflows:start", "workflows:list", "workflows:get", "workflows:cancel"] }, key);
  const asAlice = (path: string, body?: unknown) => call(path, body, { Authorization: "Bearer test-secret", "X-Workflow-Actor": sign(path, body) });
  owner.start({ id: "operator", type: "echo", version: "1", input: { message: "operator-private" } });
  const request = { id: "alice", type: "echo", version: "1", input: { message: "alice-private" } };
  expect((await asAlice("/api/runs", request)).status).toBe(201);
  const page = await (await asAlice("/api/v2/runs")).json();
  expect(page.items.map((run: { id: string }) => run.id)).toEqual(["alice"]);
  expect(JSON.stringify(page)).not.toContain("alice-private");
  expect((await asAlice("/api/runs/operator")).status).toBe(404);
  expect((await asAlice("/api/runs/alice/payloads")).status).toBe(403);
  expect((await asAlice("/api/runs/alice/cancel", {})).status).toBe(403);
  payloadRead = true;
  expect((await asAlice("/api/runs/alice/payloads")).status).toBe(200);
  const forged = await call("/api/runs", { ...request, id: "forged" }, { Authorization: "Bearer test-secret", "X-Workflow-Actor": sign("/api/runs", request) });
  expect(forged.status).toBe(403);
  revoked = true;
  expect((await asAlice("/api/v2/runs")).status).toBe(403);
  const audit = await (await call("/api/audit")).json();
  expect(audit.items.some((entry: { principal: string; reason: string }) => entry.principal === "alice" && entry.reason === "workflow identity revoked or not granted")).toBe(true);
  expect(JSON.stringify(audit)).not.toContain("alice-private");
  expect(JSON.stringify(audit)).not.toContain(key);
});

it("awaits an asynchronous context signer before sending an authenticated workflow request", async () => {
  const key = "async-owned-workflow-key-longer-than-thirty-two";
  const { url, path } = await service({ actorKey: key, grants: () => ({ alice: { types: ["echo"], operations: ["list"], payloadRead: false } }) });
  const previousSecret = process.env.BARRY_SECRET;
  const previousRegistry = process.env.BARRY_SERVICE_REGISTRY;
  const registry = join(dirname(path), "service-registry.json");
  process.env.BARRY_SECRET = "test-secret";
  process.env.BARRY_SERVICE_REGISTRY = registry;
  try {
    writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: { "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url } } }, registry);
    const sign = workflowActorSigner({ identity: "alice", traits: [], bound: null, allowedToolIds: ["workflows:list"] }, key);
    const result = await withStoreContext({ identity: "alice", workflowActor: async (path, body) => Promise.resolve(sign(path, body)) }, () => callWorkflows("/api/v2/runs"));
    expect(result).toMatchObject({ items: [] });
  } finally {
    if (previousSecret === undefined) delete process.env.BARRY_SECRET; else process.env.BARRY_SECRET = previousSecret;
    if (previousRegistry === undefined) delete process.env.BARRY_SERVICE_REGISTRY; else process.env.BARRY_SERVICE_REGISTRY = previousRegistry;
  }
});

it("refreshes actor verification keys and refuses missing or failed key readers without fallback", async () => {
  const first = "first-owned-workflow-key-longer-than-thirty-two";
  const rotated = "rotated-owned-workflow-key-longer-than-thirty-two";
  let selected: string | undefined = first;
  let failure = false;
  const { call } = await service({
    actorKey: first,
    readActorKey: async () => { if (failure) throw new Error("private-backend-canary"); return selected; },
    grants: () => ({ alice: { types: ["echo"], operations: ["list"], payloadRead: false } }),
  });
  const actor = (key: string) => workflowActorSigner({ identity: "alice", traits: [], bound: null, allowedToolIds: ["workflows:list"] }, key)("/api/v2/runs");
  const request = (key: string) => call("/api/v2/runs", undefined, { Authorization: "Bearer test-secret", "X-Workflow-Actor": actor(key) });
  expect((await request(first)).status).toBe(200);
  selected = rotated;
  expect((await request(first)).status).toBe(403);
  expect((await request(rotated)).status).toBe(200);
  selected = undefined;
  expect((await request(first)).status).toBe(403);
  failure = true;
  const response = await request(first);
  expect(response.status).toBe(403);
  expect(JSON.stringify(await response.json())).not.toContain("private-backend-canary");
});

it("sanitizes SQLite faults and degrades readiness without creating an authored failure", async () => {
  const storageHealth = new StorageHealth();
  const { path, owner, call } = await service({ storageHealth });
  const db = new DatabaseSync(path); cleanup.push(() => db.close());
  db.exec("CREATE TRIGGER fault BEFORE INSERT ON workflow_commands BEGIN SELECT RAISE(ABORT,'private-sql-storage-fault'); END");
  const response = await call("/api/runs", { id: "fault", type: "echo", version: "1", input: { message: "hello" } });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private-sql");
  expect(owner.list()).toHaveLength(0);
  expect((await call("/ready")).status).toBe(503);
  expect((await call("/live")).status).toBe(200);
});
