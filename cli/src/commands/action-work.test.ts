import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { CLI_TARGET } from "../target.js";

const mocks = vi.hoisted(() => ({ session: vi.fn(), authorize: vi.fn(), connection: vi.fn() }));
vi.mock("@barry-rocks/sessions-bag/client", () => ({ Sessions: { get: mocks.session } }));
vi.mock("../tool-bounds.js", () => ({ authorizeIdentityTool: mocks.authorize }));
vi.mock("@barry-rocks/sdk/services", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/services")>(), localConnection: mocks.connection,
}));
import { actionWorkStartCommand, actionWorkLookupCommand } from "./action-work.js";

// Actual SDK serialization and HTTP transport; selected local records/bounds and
// credential discovery are controlled seams, not end-to-end server authority.
const requestId = "ed8b122e-662a-4408-bef8-e8787baa201e";
const options = { session: "owned", requestId, key: "same explicit invocation", inputJson: '{"literal":"$(do not execute)","value":7}' };
const globals = globalThis as Record<symbol, unknown>;
let server: Server, baseUrl: string, failStart: boolean, lookupMissing: boolean;
let previousExitCode: typeof process.exitCode;
const order: string[] = [];
const requests: { method: string | undefined; path: string; body?: unknown }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    order.push("network");
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer cli-admission-fixture") {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" })); return;
    }
    if (req.method === "POST") {
      let raw = ""; for await (const bytes of req) raw += String(bytes);
      const body = JSON.parse(raw); requests.push({ method: req.method, path: req.url!, body });
      if (failStart) {
        res.writeHead(503).end(JSON.stringify({ error: "WorkAdmissionUnknown", retryable: true, message: "Preserve the original invocation." })); return;
      }
      res.writeHead(201).end(JSON.stringify({ run_id: "arn-one", work_id: "work-one", workflow_id: "workflow-one", idempotency_key: body.idempotency_key, created: true })); return;
    }
    requests.push({ method: req.method, path: req.url! });
    if (lookupMissing) { res.writeHead(404).end(JSON.stringify({ error: "WorkNotFound" })); return; }
    const key = decodeURIComponent(new URL(req.url!, "http://fixture").pathname.split("/").at(-1)!);
    res.end(JSON.stringify({ run_id: "arn-one", work_id: "work-one", workflow_id: "workflow-one", idempotency_key: key, created: false }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
beforeEach(() => {
  previousExitCode = process.exitCode; process.exitCode = undefined;
  globals[CLI_TARGET] = { kind: "identity", name: "selected", binding: { id: 42, home: "/fixture" } };
  requests.length = 0; order.length = 0; failStart = false; lookupMissing = false;
  mocks.session.mockReset().mockImplementation(async () => {
    order.push("session"); return { id: "owned", identity_id: 42, state: "open", ended_at: null };
  });
  mocks.authorize.mockReset().mockImplementation(async () => {
    order.push("bounds"); return { identity: "canonical-identity", node: "canonical-node", bags: [], bounds: [], bound: null,
      allowedToolIds: ["workflows:start", "workflows:get", "bash:Bash"], bagConfigurations: {} };
  });
  mocks.connection.mockReset().mockImplementation(async () => {
    order.push("connection"); return { baseUrl, secret: "cli-admission-fixture" };
  });
  vi.spyOn(console, "error").mockImplementation((...args) => { order.push(`stderr:${args.join(" ")}`); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { delete globals[CLI_TARGET]; process.exitCode = previousExitCode; vi.restoreAllMocks(); });

it("refuses system target before reading sessions, bounds or connection credentials", async () => {
  globals[CLI_TARGET] = { kind: "system" };
  await actionWorkStartCommand("fixture:script", options);
  await actionWorkLookupCommand(options.key, { session: options.session });
  expect(process.exitCode).toBe(1); expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});
it.each([
  ["missing", undefined],
  ["foreign", { identity_id: 7, state: "open", ended_at: null }],
  ["closed", { identity_id: 42, state: "closed", ended_at: "2026-10-15T00:00:00Z" }],
  ["ended", { identity_id: 42, state: "open", ended_at: "2026-10-15T00:00:00Z" }],
])("refuses %s session admission before bounds, credentials or network", async (_label, selected) => {
  mocks.session.mockResolvedValue(selected);
  await actionWorkStartCommand("fixture:script", options);
  expect(process.exitCode).toBe(1); expect(mocks.session).toHaveBeenCalledWith("owned");
  expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});
it("checks launch bounds and Bash before resolving credentials", async () => {
  mocks.authorize.mockImplementation(async () => { order.push("bounds"); throw new Error("tool access denied: workflows:start"); });
  await actionWorkStartCommand("fixture:script", options);
  expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
  expect(order.indexOf("session")).toBeLessThan(order.indexOf("bounds"));
  mocks.authorize.mockResolvedValue({ identity: "canonical-identity", node: "canonical-node", bags: [], bounds: [], bound: null, allowedToolIds: ["workflows:start"] });
  await actionWorkStartCommand("fixture:script", options);
  expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("bash:Bash");
});
it("retains a narrower ambient execution tool ceiling before credential discovery", async () => {
  await withStoreContext({ execution: { identity: "canonical-identity", bags: [], bounds: [], bound: null, allowedToolIds: ["workflows:start"] } },
    () => actionWorkStartCommand("fixture:script", options));
  expect(process.exitCode).toBe(1); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});
it("refuses an ambient identity mismatch and unsupported raw-script bounds before credentials", async () => {
  await withStoreContext({ identity: "foreign-identity" }, () => actionWorkStartCommand("fixture:script", options));
  await withStoreContext({ execution: { identity: "canonical-identity", bags: [], bounds: [], bound: { files: { allow: [] } }, allowedToolIds: ["workflows:start", "bash:Bash"] } },
    () => actionWorkStartCommand("fixture:script", options));
  expect(process.exitCode).toBe(1); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});
it("prints the stable key before credentials and sends exact selected-session intent only to dedicated admission", async () => {
  await actionWorkStartCommand("fixture:script", options);
  expect(process.exitCode).not.toBe(1);
  const printed = order.findIndex(event => event.startsWith("stderr:") && event.includes(options.key));
  expect(printed).toBeGreaterThanOrEqual(0); expect(printed).toBeLessThan(order.indexOf("connection")); expect(printed).toBeLessThan(order.indexOf("network"));
  expect(requests).toEqual([{ method: "POST", path: "/api/v1/actions/fixture%3Ascript/work-start?session_id=owned",
    body: { request_id: requestId, idempotency_key: options.key, inputs: JSON.parse(options.inputJson) } }]);
  expect(mocks.authorize).toHaveBeenCalledWith({ namespace: "workflows", name: "start", access: "write" });
  expect(vi.mocked(console.log)).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toEqual({ runId: "arn-one", workId: "work-one", workflowId: "workflow-one", idempotencyKey: options.key, created: true });
});
it("does not automatically retry an unknown admission and keeps the exact intent for an explicit retry", async () => {
  failStart = true;
  await actionWorkStartCommand("fixture:script", options);
  expect(process.exitCode).toBe(1); expect(requests).toHaveLength(1); expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  const diagnostics = vi.mocked(console.error).mock.calls.flat().join("\n");
  expect(diagnostics).toContain(options.key); expect(diagnostics).toContain("same session and inputs");
  await actionWorkStartCommand("fixture:script", options);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});
it("looks up retained work from an ended owned session with read permission after launch authority is removed", async () => {
  mocks.session.mockResolvedValue({ id: "owned", identity_id: 42, state: "closed", ended_at: "2026-10-15T00:00:00Z" });
  mocks.authorize.mockResolvedValue({ identity: "canonical-identity", node: "canonical-node", bags: [], bounds: [], bound: null, allowedToolIds: ["workflows:get"] });
  await actionWorkLookupCommand(options.key, { session: options.session });
  expect(process.exitCode).not.toBe(1); expect(mocks.authorize).toHaveBeenCalledWith({ namespace: "workflows", name: "get", access: "read" });
  expect(requests).toEqual([{ method: "GET", path: "/api/v1/actions/work-operations/same%20explicit%20invocation?session_id=owned" }]);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toMatchObject({ idempotencyKey: options.key, created: false });
});
it("keeps an ambient read denial ahead of credentials even when identity bounds permit lookup", async () => {
  await withStoreContext({ execution: { identity: "canonical-identity", bags: [], bounds: [], bound: { tools: { deny: ["*:get"] } }, allowedToolIds: ["workflows:get"] } },
    () => actionWorkLookupCommand(options.key, { session: options.session }));
  expect(process.exitCode).toBe(1); expect(mocks.connection).not.toHaveBeenCalled(); expect(requests).toEqual([]);
});
it("reports a missing lookup without authorizing a replacement submission", async () => {
  lookupMissing = true;
  await actionWorkLookupCommand(options.key, { session: options.session });
  expect(requests).toHaveLength(1); expect(requests[0].method).toBe("GET");
  expect(vi.mocked(console.log)).toHaveBeenCalledWith("null");
  expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("in-flight submission may still commit");
});
