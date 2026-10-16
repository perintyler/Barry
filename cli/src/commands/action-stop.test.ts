import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { CLI_TARGET } from "../target.js";

const mocks = vi.hoisted(() => ({ session: vi.fn(), authorize: vi.fn(), connection: vi.fn() }));
vi.mock("@barry-rocks/sessions-bag/client", () => ({ Sessions: { get: mocks.session } }));
vi.mock("../tool-bounds.js", () => ({ authorizeIdentityTool: mocks.authorize }));
vi.mock("@barry-rocks/sdk/services", async original => ({ ...await original<typeof import("@barry-rocks/sdk/services")>(), localConnection: mocks.connection }));
import { actionStopCommand } from "./action-stop.js";

const requestId = "cb9d7e14-52fa-4ca6-a9a0-a3d0e5be9bb8";
const options = { session: "owned", revision: "5", reason: "Stop this exact invocation", requestId };
const globals = globalThis as Record<symbol, unknown>;
let server: Server, baseUrl: string, fail = false, previousExitCode: typeof process.exitCode;
const order: string[] = [];
const requests: { method: string | undefined; path: string; body?: unknown }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    order.push("network");
    const path = new URL(req.url!, "http://fixture");
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer cli-stop-fixture") { res.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return; }
    if (req.method === "POST") {
      let raw = ""; for await (const bytes of req) raw += String(bytes); const body = JSON.parse(raw);
      requests.push({ method: req.method, path: req.url!, body });
      if (fail) { res.writeHead(503).end(JSON.stringify({ error: "WorkStopUnknown", retryable: true, message: "Original intent must be preserved." })); return; }
      res.writeHead(202).end(JSON.stringify({ run_id: "arn_one", work_id: "work-one", request_id: body.request_id, applied_revision: 6, stop_requested: true, status: "stop_requested" })); return;
    }
    requests.push({ method: req.method, path: req.url! });
    if (path.pathname !== "/api/v1/actions/runs/arn_one") { res.writeHead(404).end(JSON.stringify({ error: "unknown_run" })); return; }
    res.end(JSON.stringify({ run_id: "arn_one", action: "fixture:report", bag: "fixture", session_id: "owned", status: "started", summary: null,
      started_at: new Date().toISOString(), completed_at: null, output: null, output_type: null,
      workflow: { work_id: "work-one", workflow_id: "workflow-one", owner: "owner", revision: 5, state: "running", current: true, stop_protocol: "work-stop-v1" } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
beforeEach(() => {
  previousExitCode = process.exitCode; process.exitCode = undefined;
  globals[CLI_TARGET] = { kind: "identity", name: "selected", binding: { id: 42, home: "/fixture" } };
  requests.length = 0; order.length = 0; fail = false;
  mocks.session.mockReset().mockImplementation(async () => { order.push("session"); return { id: "owned", identity_id: 42, state: "open", ended_at: null }; });
  mocks.authorize.mockReset().mockImplementation(async () => { order.push("bounds"); return {
    identity: "canonical-identity", bags: [], bounds: [], bound: { nodes: { allow: ["canonical-node"] } }, allowedToolIds: ["workflows:cancel"], node: "canonical-node", bagConfigurations: {},
  }; });
  mocks.connection.mockReset().mockImplementation(async () => { order.push("connection"); return { baseUrl, secret: "cli-stop-fixture" }; });
  vi.spyOn(console, "error").mockImplementation((...args) => { order.push(`stderr:${args.join(" ")}`); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { delete globals[CLI_TARGET]; process.exitCode = previousExitCode; vi.restoreAllMocks(); });

it("requires an identity CLI before reading a session, bounds, credentials or the network", async () => {
  globals[CLI_TARGET] = { kind: "system" };
  await actionStopCommand("arn_one", options);
  expect(process.exitCode).toBe(1); expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});

it.each([
  ["missing", undefined],
  ["foreign", { id: "owned", identity_id: 7, state: "open", ended_at: null }],
  ["closed", { id: "owned", identity_id: 42, state: "closed", ended_at: "2026-10-01T00:00:00Z" }],
  ["ended", { id: "owned", identity_id: 42, state: "open", ended_at: "2026-10-01T00:00:00Z" }],
])("refuses a %s selected session before resolving bounds or connection credentials", async (_name, row) => {
  mocks.session.mockResolvedValue(row);
  await actionStopCommand("arn_one", options);
  expect(process.exitCode).toBe(1); expect(mocks.session).toHaveBeenCalledWith("owned"); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});

it("checks workflows cancel bounds before resolving any connection credentials", async () => {
  mocks.authorize.mockImplementation(async () => { order.push("bounds"); throw new Error("tool access denied: workflows:cancel"); });
  await actionStopCommand("arn_one", options);
  expect(process.exitCode).toBe(1); expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ namespace: "workflows", name: "cancel" }));
  expect(order.indexOf("session")).toBeLessThan(order.indexOf("bounds")); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});

it("keeps an ambient execution tool ceiling before connecting", async () => {
  await withStoreContext({ execution: { identity: "canonical-identity", bags: [], bounds: [], bound: null, allowedToolIds: [] } }, () => actionStopCommand("arn_one", options));
  expect(process.exitCode).toBe(1); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});

it("uses the canonical node bound and selected session, prints the key before credentials or network and emits acknowledgement JSON only", async () => {
  await actionStopCommand("arn_one", options);
  expect(process.exitCode).not.toBe(1);
  const printedKey = order.findIndex(event => event.startsWith("stderr:") && event.includes(requestId));
  expect(printedKey).toBeGreaterThanOrEqual(0); expect(printedKey).toBeLessThan(order.indexOf("connection")); expect(printedKey).toBeLessThan(order.indexOf("network"));
  expect(order.indexOf("bounds")).toBeLessThan(order.indexOf("connection"));
  expect(requests.map(request => new URL(request.path, baseUrl).searchParams.get("session_id"))).toEqual(["owned", "owned"]);
  expect(requests.filter(request => request.method === "POST")).toEqual([{ method: "POST", path: "/api/v1/actions/runs/arn_one/work-stop?session_id=owned", body: { reason: options.reason, request_id: requestId, expected_revision: 5 } }]);
  expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1);
  const ack = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));
  expect(ack).toMatchObject({ requestId, stopRequested: true, status: "stop_requested" }); expect(ack).not.toHaveProperty("agentStopped");
});

it("does not retry an unknown Stop and preserves its exact supplied key, revision and reason for recovery", async () => {
  fail = true; await actionStopCommand("arn_one", options);
  expect(process.exitCode).toBe(1); expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  const posts = requests.filter(request => request.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0].body).toEqual({ reason: options.reason, request_id: requestId, expected_revision: 5 });
  const diagnostics = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(diagnostics).toContain(requestId); expect(diagnostics).toContain("same session, revision and reason");
});

it("honors an ambient node ceiling before resolving connection credentials", async () => {
  await withStoreContext({ execution: { identity: "canonical-identity", bags: [], bounds: [], bound: { nodes: { allow: ["other-node"] } }, allowedToolIds: ["workflows:cancel"] } }, () => actionStopCommand("arn_one", options));
  expect(process.exitCode).toBe(1); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});

it("refuses an ambient identity mismatch before resolving connection credentials", async () => {
  await withStoreContext({ identity: "foreign-identity" }, () => actionStopCommand("arn_one", options));
  expect(process.exitCode).toBe(1); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});

it("prints an automatically allocated request key before credentials and uses that exact key once", async () => {
  await actionStopCommand("arn_one", { session: options.session, revision: options.revision, reason: options.reason });
  const ack = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]));
  expect(ack.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const printedKey = order.findIndex(event => event.startsWith("stderr:") && event.includes(ack.requestId));
  expect(printedKey).toBeGreaterThanOrEqual(0); expect(printedKey).toBeLessThan(order.indexOf("connection"));
  expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  expect(requests.find(request => request.method === "POST")!.body).toEqual({ reason: options.reason, request_id: ack.requestId, expected_revision: 5 });
});
