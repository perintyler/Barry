import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { BarryClient } from "./index.js";
let server: Server, base: string, legacy = false, control = true, ackMismatch: "none" | "request" | "revision" | "run" | "work" = "none";
let sessionEndpoint = true, inspectRevision = 5, onInspect: (() => void) | undefined;
const requests: { method: string; url: string }[] = [];
const seen: unknown[] = [];
const profiles: (string | undefined)[] = [];
const workflow = { work_id: "work-one", workflow_id: "workflow-one", owner: "owner", revision: 5, state: "stopping", current: true, stop_protocol: "work-stop-v1", url: "http://localhost:1234/work#work/work-one" };
beforeAll(async () => {
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    requests.push({ method: req.method!, url: req.url! });
    if (req.method === "POST" && new URL(req.url!, "http://fixture").pathname.endsWith("/work-stop") && !sessionEndpoint) {
      res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); return;
    }
    if (req.method === "POST") {
      let text = ""; for await (const bytes of req) text += String(bytes); const body = JSON.parse(text); seen.push(body);
      res.writeHead(202); res.end(JSON.stringify({ run_id: ackMismatch === "run" ? "arn_other" : "arn_one", work_id: ackMismatch === "work" ? "work-other" : "work-one", request_id: ackMismatch === "request" ? "8fc1b875-417c-4bb1-94bd-843d99add940" : body.request_id, applied_revision: ackMismatch === "revision" ? 4 : 6, stop_requested: true, status: "stop_requested" })); return;
    }
    profiles.push(req.headers.accept); onInspect?.();
    const run = { run_id: "arn_one", action: "fixture:report", bag: "fixture", session_id: null, status: "started", summary: null, started_at: new Date().toISOString(), completed_at: null,
      ...(!legacy ? { workflow: { ...workflow, revision: inspectRevision, stop_protocol: control ? "work-stop-v1" : undefined } } : {}) };
    res.end(JSON.stringify(req.url?.includes("/arn_one") ? { ...run, output: null, output_type: null } : { count: 1, runs: [{ ...run, has_output: false, output_type: null }] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
beforeEach(() => { legacy = false; control = true; ackMismatch = "none"; sessionEndpoint = true; inspectRevision = 5; onInspect = undefined; requests.length = 0; seen.length = 0; profiles.length = 0; });
it("retains the work owner/state/reference on detail and list without adding result payloads", async () => {
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  expect((await client.actions.getRun("arn_one"))?.work).toEqual({ workId: "work-one", workflowId: "workflow-one", owner: "owner", revision: 5, state: "stopping", current: true, stopProtocol: "work-stop-v1", url: workflow.url });
  expect((await client.actions.listRuns())[0].work).toMatchObject({ state: "stopping", current: true });
  expect(profiles).toEqual(["application/json;profile=barry-action-work-v1", "application/json;profile=barry-action-work-v1"]);
});
it("reads old action responses without a workflow reference", async () => {
  legacy = true; const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  expect(await client.actions.getRun("arn_one")).not.toHaveProperty("work");
  expect((await client.actions.listRuns())[0]).not.toHaveProperty("work");
});
it("keeps a supplied Stop ID, revision and reason across retries and reports acknowledgement only", async () => {
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" }), requestId = "b2caf316-3fe7-4575-8914-67ee8a237b75";
  const input = { reason: "Stop requested by operator", requestId, expectedRevision: 5 };
  const first = await client.actions.stopWorkflowRun("arn_one", input), second = await client.actions.stopWorkflowRun("arn_one", input);
  expect(first).toEqual(second); expect(first).toMatchObject({ status: "stop_requested", requestId, stopRequested: true });
  expect(seen).toEqual([{ reason: input.reason, request_id: requestId, expected_revision: 5 }, { reason: input.reason, request_id: requestId, expected_revision: 5 }]);
  expect(first).not.toHaveProperty("agentStopped");
});

it("does not POST to an older server's legacy cancel endpoint", async () => {
  legacy = true; const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  await expect(client.actions.stopWorkflowRun("arn_one", { reason: "Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 })).rejects.toMatchObject({ code: "work_control_unsupported" });
  expect(seen).toEqual([]);
});

it("does not treat a read-only workflow reference as permission to use legacy cancellation", async () => {
  control = false; const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  await expect(client.actions.stopWorkflowRun("arn_one", { reason: "Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 })).rejects.toMatchObject({ code: "work_control_unsupported" });
  expect(seen).toEqual([]);
});
it.each(["request", "revision", "run", "work"] as const)("rejects mismatched Stop acknowledgement %s without retrying or claiming cessation", async mismatch => {
  ackMismatch = mismatch; const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  await expect(client.actions.stopWorkflowRun("arn_one", { reason: "Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 })).rejects.toMatchObject({ code: "malformed_response", detail: { stopRequestId: "b2caf316-3fe7-4575-8914-67ee8a237b75" } });
  expect(seen).toHaveLength(1);
});

it("binds selected-session detail and Stop preflight/POST to the dedicated endpoint", async () => {
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" }), sessionId = "owned / session?";
  await client.actions.getRun("arn_one", { sessionId, timeoutMs: 2000 });
  await client.actions.stopWorkflowRun("arn_one", { reason: "Bound Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 }, { sessionId });
  expect(requests.map(value => ({ method: value.method, path: new URL(value.url, base).pathname, session: new URL(value.url, base).searchParams.get("session_id") }))).toEqual([
    { method: "GET", path: "/api/v1/actions/runs/arn_one", session: sessionId },
    { method: "GET", path: "/api/v1/actions/runs/arn_one", session: sessionId },
    { method: "POST", path: "/api/v1/actions/runs/arn_one/work-stop", session: sessionId },
  ]);
});
it("never falls back to legacy cancel when an older workflow server lacks the selected-session endpoint", async () => {
  sessionEndpoint = false;
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  await expect(client.actions.stopWorkflowRun("arn_one", { reason: "Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 }, { sessionId: "owned" })).rejects.toMatchObject({ status: 404 });
  expect(seen).toEqual([]); expect(requests.filter(value => value.method === "POST").map(value => new URL(value.url, base).pathname)).toEqual(["/api/v1/actions/runs/arn_one/work-stop"]);
});
it("preserves an earlier inspected revision for immutable Stop replay", async () => {
  inspectRevision = 8;
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  const input = { reason: "Replay Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 };
  await client.actions.stopWorkflowRun("arn_one", input, { sessionId: "owned" });
  expect(seen).toEqual([{ reason: input.reason, request_id: input.requestId, expected_revision: 5 }]);
});
it("snapshots the session and control intent before asynchronous inspection", async () => {
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  const input = { reason: "Original Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 }, options = { sessionId: "owned" };
  onInspect = () => { input.reason = "Changed"; input.expectedRevision = 8; options.sessionId = "other"; };
  await client.actions.stopWorkflowRun("arn_one", input, options);
  expect(requests.every(value => new URL(value.url, base).searchParams.get("session_id") === "owned")).toBe(true);
  expect(seen).toEqual([{ reason: "Original Stop", request_id: "b2caf316-3fe7-4575-8914-67ee8a237b75", expected_revision: 5 }]);
});
it.each(["", "x".repeat(501)])("refuses an invalid explicit session selection before any HTTP request", async sessionId => {
  const client = BarryClient.connect({ baseUrl: base, secret: "fixture" });
  await expect(client.actions.getRun("arn_one", { sessionId })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(client.actions.stopWorkflowRun("arn_one", { reason: "Stop", requestId: "b2caf316-3fe7-4575-8914-67ee8a237b75", expectedRevision: 5 }, { sessionId })).rejects.toMatchObject({ code: "invalid_request" });
  expect(requests).toEqual([]);
});
