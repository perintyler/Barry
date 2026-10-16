import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { BarryClient } from "./platypus.js";

const workId = `work_${"1".repeat(32)}`, requestId = "b2caf316-3fe7-4575-8914-67ee8a237b75";
const summary = { version: 2, work_id: workId, workflow_id: "workflow-one", action_id: "arn-one", job_run_id: null, title: "Canonical work",
  source: { kind: "action", reference: "fixture:script", catalog_namespace: "fixture" }, origin: { entry_point: "sessions-work-api", trigger: "invocation", caller_session_id: "owned" },
  namespace: { installation: "installation-one", principal_kind: "identity", principal_id: "identity-one", identity_id: "identity-one", caller_session_id: "owned" },
  accepted_at: 1, first_started_at: 2, dispatch_deadline: 100, execution_deadline: 100, revision: 5, state: "running",
  facts: { coordinator: "running", phase: "executing", wait: "none", physical: "running", effect: "uncertain", stop_requested: false,
    has_result: false, can_continue: false, can_retry_step: false, can_respond: false }, reason: null, receipt_ref: null,
  allowed_actions: ["inspect", "result", "stop"], can_review_reconciliation: false };
let server: Server, baseUrl: string, failureStatus: number, mismatch: string;
const calls: { method: string; path: string; session: string | null; body: unknown }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ""; for await (const data of req) raw += String(data);
    const url = new URL(req.url!, "http://fixture"), body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method!, path: url.pathname, session: url.searchParams.get("session_id"), body });
    res.setHeader("Content-Type", "application/json");
    if (failureStatus) { res.writeHead(failureStatus).end(JSON.stringify({ error: "PayloadDenied", message: "fixture canonical refusal" })); return; }
    if (req.method === "POST") {
      res.writeHead(202).end(JSON.stringify({ version: 2, work_id: mismatch === "work" ? "other" : workId,
        request_id: mismatch === "request" ? "8fc1b875-417c-4bb1-94bd-843d99add940" : body.request_id,
        applied_revision: mismatch === "revision" ? 4 : 6, applied_at: 10, stop_requested: true })); return;
    }
    if (url.pathname.endsWith("/result")) {
      res.end(JSON.stringify({ version: 2, work_id: mismatch === "work" ? "other" : workId, revision: 6, status: "available", receipt_ref: null,
        outcome: { ok: true, value: { answer: "actual canonical payload" } }, retained_output: null, logs: [] })); return;
    }
    res.end(JSON.stringify({ ...summary, work_id: mismatch === "work" ? "other" : workId,
      namespace: mismatch === "identity" ? { ...summary.namespace, principal_kind: "operator" } : summary.namespace }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
beforeEach(() => { calls.length = 0; failureStatus = 0; mismatch = ""; });

it("uses canonical selected-session routes without requiring an Actions projection", async () => {
  const client = BarryClient.connect({ baseUrl, secret: "fixture" }), sessionId = "owned / session?";
  expect(await client.actions.getWorkflowWork(workId, { sessionId })).toMatchObject({ work_id: workId, state: "running" });
  expect(await client.actions.getWorkflowWorkResult(workId, { sessionId })).toMatchObject({ outcome: { ok: true } });
  expect(calls).toEqual([
    { method: "GET", path: `/api/v1/actions/work-items/${workId}`, session: sessionId, body: null },
    { method: "GET", path: `/api/v1/actions/work-items/${workId}/result`, session: sessionId, body: null },
  ]);
});
it("sends one immutable cancel-only Stop directly, preserving its earlier revision on replay", async () => {
  const client = BarryClient.connect({ baseUrl, secret: "fixture" }), input = { requestId, expectedRevision: 5, reason: "Original reason" };
  const first = await client.actions.stopWorkflowWork(workId, input, { sessionId: "owned" });
  expect(await client.actions.stopWorkflowWork(workId, input, { sessionId: "owned" })).toEqual(first);
  expect(first).toMatchObject({ stop_requested: true, applied_revision: 6 });
  expect(first).not.toHaveProperty("ceased");
  expect(calls).toEqual([0, 1].map(() => ({ method: "POST", path: `/api/v1/actions/work-items/${workId}/stop`, session: "owned",
    body: { request_id: requestId, expected_revision: 5, reason: "Original reason" } })));
});
it.each(["..", ".", "../work", "work_", "work_" + "g".repeat(32)])("rejects invalid work path %s before any HTTP request", async id => {
  const client = BarryClient.connect({ baseUrl, secret: "fixture" });
  await expect(client.actions.getWorkflowWork(id, { sessionId: "owned" })).rejects.toMatchObject({ code: "invalid_request" }); expect(calls).toEqual([]);
});
it("requires explicit nonempty selection and valid Stop intent before HTTP", async () => {
  const client = BarryClient.connect({ baseUrl, secret: "fixture" });
  await expect(client.actions.getWorkflowWork(workId, { sessionId: "" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(client.actions.getWorkflowWork(workId, {} as never)).rejects.toMatchObject({ code: "invalid_request" });
  await expect(client.actions.stopWorkflowWork(workId, { requestId: "invalid", expectedRevision: 5, reason: "Stop" }, { sessionId: "owned" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(calls).toEqual([]);
});
it.each(["work", "identity"])("rejects mismatched canonical summary %s", async wrong => {
  mismatch = wrong;
  await expect(BarryClient.connect({ baseUrl, secret: "fixture" }).actions.getWorkflowWork(workId, { sessionId: "owned" })).rejects.toMatchObject({ code: "malformed_response" });
});
it("rejects a result belonging to a different work ID", async () => {
  mismatch = "work";
  await expect(BarryClient.connect({ baseUrl, secret: "fixture" }).actions.getWorkflowWorkResult(workId, { sessionId: "owned" })).rejects.toMatchObject({ code: "malformed_response" });
});
it.each(["work", "request", "revision"])("preserves uncertainty after mismatched canonical Stop acknowledgement %s", async wrong => {
  mismatch = wrong;
  await expect(BarryClient.connect({ baseUrl, secret: "fixture" }).actions.stopWorkflowWork(workId, { requestId, expectedRevision: 5, reason: "Stop" }, { sessionId: "owned" })).rejects.toMatchObject({ code: "malformed_response" });
  expect(calls).toHaveLength(1);
});
it("preserves payload denial rather than substituting a projected result", async () => {
  failureStatus = 403;
  await expect(BarryClient.connect({ baseUrl, secret: "fixture" }).actions.getWorkflowWorkResult(workId, { sessionId: "owned" })).rejects.toMatchObject({ status: 403, code: "PayloadDenied" });
  expect(calls).toHaveLength(1);
});
it("does not fall back or retry when an older server lacks canonical Stop", async () => {
  failureStatus = 404;
  await expect(BarryClient.connect({ baseUrl, secret: "fixture" }).actions.stopWorkflowWork(workId, { requestId, expectedRevision: 5, reason: "Stop" }, { sessionId: "owned" })).rejects.toMatchObject({ status: 404 });
  expect(calls.map(call => call.path)).toEqual([`/api/v1/actions/work-items/${workId}/stop`]);
});
