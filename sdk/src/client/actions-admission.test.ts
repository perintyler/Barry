import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { BarryClient } from "./platypus.js";

let server: Server, baseUrl: string, status = 201, wrongKey = false;
const calls: { method: string | undefined; path: string; body: unknown }[] = [];
const key = "original invocation", requestId = "318461ca-c1b1-4653-8f9a-cbf9bd47fd44";
const input = { requestId, idempotencyKey: key, inputs: { text: "original", count: 3, enabled: true } };
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ""; for await (const data of req) raw += String(data);
    calls.push({ method: req.method, path: req.url!, body: raw ? JSON.parse(raw) : null });
    res.setHeader("Content-Type", "application/json");
    if (status >= 400) { res.writeHead(status).end(JSON.stringify({ error: "fixture refusal" })); return; }
    const created = req.method === "POST" && status === 201;
    res.writeHead(created ? 201 : 200).end(JSON.stringify({ run_id: "arn_one", work_id: "work-one", workflow_id: "workflow-one", idempotency_key: wrongKey ? "other" : key, created }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
beforeEach(() => { status = 201; wrongKey = false; calls.length = 0; });
const client = () => BarryClient.connect({ baseUrl, secret: "fixture-hop" });

it("binds typed admission and independent lookup to the original session/key without a legacy producer", async () => {
  const api = client(), sessionId = "owned / session?";
  expect(await api.actions.startWorkflowRun("fixture:script", input, { sessionId })).toEqual({ runId: "arn_one", workId: "work-one", workflowId: "workflow-one", idempotencyKey: key, created: true });
  expect(await api.actions.lookupWorkflowRun(key, { sessionId })).toMatchObject({ idempotencyKey: key, created: false });
  expect(calls.map(call => ({ method: call.method, path: new URL(call.path, baseUrl).pathname, session: new URL(call.path, baseUrl).searchParams.get("session_id") }))).toEqual([
    { method: "POST", path: "/api/v1/actions/fixture%3Ascript/work-start", session: sessionId },
    { method: "GET", path: "/api/v1/actions/work-operations/original%20invocation", session: sessionId },
  ]);
  expect(calls[0].body).toEqual({ request_id: requestId, idempotency_key: key, inputs: input.inputs });
});
it.each([404, 503])("does not retry or invoke a legacy producer after admission HTTP%s", async refusal => {
  status = refusal;
  await expect(client().actions.startWorkflowRun("fixture:script", input, { sessionId: "owned" })).rejects.toMatchObject({ status: refusal });
  expect(calls).toHaveLength(1); expect(calls[0].path).toContain("/work-start?");
});
it("keeps read lookup separate after a lost submission acknowledgement", async () => {
  const api = client(); status = 503;
  await expect(api.actions.startWorkflowRun("fixture:script", input, { sessionId: "owned" })).rejects.toMatchObject({ status: 503 });
  status = 200;
  expect(await api.actions.lookupWorkflowRun(key, { sessionId: "owned" })).toMatchObject({ idempotencyKey: key, created: false });
  expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
});
it("returns missing lookup without submitting another invocation", async () => {
  status = 404; expect(await client().actions.lookupWorkflowRun(key, { sessionId: "owned" })).toBeNull();
  expect(calls.map(call => call.method)).toEqual(["GET"]);
});
it("rejects an acknowledgement for another key", async () => {
  wrongKey = true;
  await expect(client().actions.startWorkflowRun("fixture:script", input, { sessionId: "owned" })).rejects.toMatchObject({ code: "malformed_response" });
  await expect(client().actions.lookupWorkflowRun(key, { sessionId: "owned" })).rejects.toMatchObject({ code: "malformed_response" });
});
it("requires an explicit valid session and JSON intent before HTTP", async () => {
  for (const sessionId of ["", "x".repeat(201)]) {
    await expect(client().actions.startWorkflowRun("fixture:script", input, { sessionId })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client().actions.lookupWorkflowRun(key, { sessionId })).rejects.toMatchObject({ code: "invalid_request" });
  }
  await expect(client().actions.startWorkflowRun("fixture:script", { ...input, requestId: "wrong" }, { sessionId: "owned" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(calls).toEqual([]);
});
