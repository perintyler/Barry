import { createServer, request, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isAuthorized, sessionToken } from "@barry-rocks/sdk/auth";
import { identityWorkRoute } from "./identity-work.js";

const secret = "identity-work-proxy-fixture";
const work = `work_${"a".repeat(32)}`;
const intent = { session_id: "owned", action: "fixture:script", request_id: "6c8ce043-769d-4523-aad9-5b0f94509c85", idempotency_key: "stable-key", inputs: { value: "input" } };
let server: Server, origin: string;
let reply: { status: number; body: unknown }, failure: Error | undefined;
const upstream = vi.fn(async (_path: string, _init?: { method?: string; body?: unknown }) => {
  if (failure) throw failure;
  return reply;
});

beforeEach(async () => {
  upstream.mockClear(); failure = undefined; reply = { status: 200, body: { sessions: [] } };
  server = createServer(async (req, res) => {
    // The production index applies this same real cookie/secret gate before identityWorkRoute.
    if (!isAuthorized(req, secret)) { res.writeHead(401); res.end('{}'); return; }
    if (!await identityWorkRoute(req, res, new URL(req.url!, origin), secret, upstream)) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { vi.unstubAllEnvs(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); });

function send(path: string, options: { method?: string; body?: unknown; raw?: string; cookie?: boolean; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, method: options.method ?? "GET", headers: {
      ...(options.cookie ? { Cookie: `barry_session=${sessionToken(secret)}` } : { Authorization: `Bearer ${secret}` }),
      ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }), ...options.headers,
    } }, res => {
      let result = ""; res.on("data", bytes => { result += String(bytes); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(result) }));
    });
    req.on("error", reject); if (payload !== undefined) req.write(payload); req.end();
  });
}

it("constructs only the dedicated owned-session and catalog upstream routes", async () => {
  reply.body = { sessions: [{ id: "owned", name: null, identity_id: 42, ended: false, private: "discarded" }], private: "discarded" };
  expect((await send("/api/work/sessions")).body).toEqual({ sessions: [{ id: "owned", name: null, identity_id: 42, ended: false }] });
  expect(upstream.mock.calls[0]).toEqual(["/actions/work-sessions"]);
  await send("/api/work/catalog?session_id=owned");
  expect(upstream.mock.calls[1]).toEqual(["/actions/work-catalog?session_id=owned", undefined]);
});

it("encodes opaque references and forwards the exact allowed body without browser scope or auth headers", async () => {
  await send("/api/work/start", { method: "POST", body: intent, headers: { "X-Workflow-Actor": "forged-actor", "X-Identity": "foreign", "X-Scope": "operator" } });
  expect(upstream.mock.calls[0]).toEqual(["/actions/fixture%3Ascript/work-start?session_id=owned", { method: "POST", body: { request_id: intent.request_id, idempotency_key: intent.idempotency_key, inputs: intent.inputs } }]);
  await send("/api/work/operations/key%2Fpart%3Foperator%3Dtrue?session_id=owned");
  expect(upstream.mock.calls[1]).toEqual(["/actions/work-operations/key%2Fpart%3Foperator%3Dtrue?session_id=owned", undefined]);
  await send(`/api/work/items/${work}?session_id=owned`); await send(`/api/work/items/${work}/result?session_id=owned`);
  expect(upstream.mock.calls.slice(2)).toEqual([[`/actions/work-items/${work}?session_id=owned`, undefined], [`/actions/work-items/${work}/result?session_id=owned`, undefined]]);
  const stopped = { request_id: intent.request_id, expected_revision: 2, reason: "  Stop this task  " };
  await send(`/api/work/items/${work}/stop?session_id=owned`, { method: "POST", body: stopped });
  expect(upstream.mock.calls[4]).toEqual([`/actions/work-items/${work}/stop?session_id=owned`, { method: "POST", body: { ...stopped, reason: "Stop this task" } }]);
  expect(JSON.stringify(upstream.mock.calls)).not.toContain(secret); expect(JSON.stringify(upstream.mock.calls)).not.toContain("forged-actor");
});

it.each([
  "/api/work/catalog", "/api/work/catalog?session_id=", "/api/work/catalog?session_id=owned&session_id=foreign", "/api/work/catalog?session_id=owned&operator=true",
  "/api/work/sessions?session_id=owned", "/api/work/operations/key?session_id=owned&scope=operator", `/api/work/items/${work}?session_id=owned&session_id=foreign`,
])("refuses ambiguous or unknown selected-session query before forwarding: %s", async path => {
  const result = await send(path); expect(result.status).toBe(422); expect(result.body.admission_disposition).toBe("refused"); expect(upstream).not.toHaveBeenCalled();
});

it.each([
  "/api/work/operations/../sessions", "/api/work/operations/%2e%2e/sessions", "/api/work/operations/%2E%2E/sessions", "/api/work/operations/.", "/api/work/operations/%2e",
  "/api/work/items/work_invalid/result?session_id=owned", "/api/work/items/%2Fapi%2Fworker?session_id=owned", "/api/work/operations/%ZZ?session_id=owned",
])("refuses raw path normalization and invalid references without changing endpoints: %s", async path => {
  const result = await send(path); expect([404, 422]).toContain(result.status); expect(upstream).not.toHaveBeenCalled();
});

it.each([
  ["GET", "/api/work/start"], ["POST", "/api/work/catalog?session_id=owned"], ["DELETE", `/api/work/items/${work}?session_id=owned`],
  ["POST", "/api/work/worker"], ["GET", "/api/work/admin"], ["GET", "/api/work/items/" + work + "/stop?session_id=owned"],
])("keeps the method/path allowlist narrow: %s %s", async (method, path) => {
  expect((await send(path, { method, headers: { "Content-Type": "application/json" } })).status).toBe(404); expect(upstream).not.toHaveBeenCalled();
});

it.each([
  { ...intent, workflow_bound: { identity: "foreign" } }, { ...intent, operator: true }, { ...intent, session_id: "" }, { ...intent, request_id: "not-a-uuid" },
  { ...intent, inputs: [] }, { ...intent, action: "fixture:script@1" },
])("marks malformed caller intent refused before forwarding", async body => {
  const result = await send("/api/work/start", { method: "POST", body });
  expect(result.status).toBe(422); expect(result.body.admission_disposition).toBe("refused"); expect(upstream).not.toHaveBeenCalled();
});

it("rejects invalid JSON, oversized bodies, and start query overrides before forwarding", async () => {
  for (const [path, raw] of [["/api/work/start", "{"], ["/api/work/start", JSON.stringify({ ...intent, inputs: { value: "x".repeat(1_000_001) } })], ["/api/work/start?session_id=foreign", JSON.stringify(intent)]]) {
    const result = await send(path, { method: "POST", raw }); expect(result.status).toBe(422); expect(result.body.admission_disposition).toBe("refused");
  }
  expect(upstream).not.toHaveBeenCalled();
});

it("requires cookie writes to have exact direct origin and JSON", async () => {
  const cases: Record<string, string>[] = [{}, { Origin: "https://foreign.example" }, { Origin: origin, "Sec-Fetch-Site": "cross-site" }, { Origin: origin, "Content-Type": "text/plain" }];
  for (const headers of cases) {
    expect((await send("/api/work/start", { method: "POST", body: intent, cookie: true, headers })).status).toBe(403);
  }
  expect(upstream).not.toHaveBeenCalled();
  expect((await send("/api/work/start", { method: "POST", body: intent, cookie: true, headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("only exempts a valid installation secret from origin checks, never an invalid bearer plus valid cookie", async () => {
  expect((await send("/api/work/start", { method: "POST", body: intent, cookie: true, headers: { Authorization: "Bearer invalid", Origin: "https://foreign.example" } })).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  expect((await send("/api/work/start", { method: "POST", body: intent, headers: { Origin: "https://foreign.example" } })).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("uses the configured exact public origin and never trusts forwarded origin headers", async () => {
  vi.stubEnv("BARRY_ACTIONS_ORIGIN", "https://actions.example");
  const cases: Record<string, string>[] = [{ Origin: origin }, { Origin: "http://actions.example" }, { Origin: "https://actions.example:444" }, { Origin: "https://evil.example", "X-Forwarded-Host": "actions.example", "X-Forwarded-Proto": "https" }];
  for (const headers of cases) {
    expect((await send("/api/work/start", { method: "POST", body: intent, cookie: true, headers })).status).toBe(403);
  }
  expect(upstream).not.toHaveBeenCalled();
  expect((await send("/api/work/start", { method: "POST", body: intent, cookie: true, headers: { Origin: "https://actions.example" } })).status).toBe(200);
});

it.each(["https://actions.example/path", "https://user:secret@actions.example", "https://actions.example?query=1", "https://actions.example#fragment", "file:///tmp/actions"])("refuses invalid configured public origins: %s", async configured => {
  vi.stubEnv("BARRY_ACTIONS_ORIGIN", configured);
  expect((await send("/api/work/start", { method: "POST", body: intent, cookie: true, headers: { Origin: origin } })).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

it("preserves actual upstream refusals and treats forwarding uncertainty as unknown, never proven refused", async () => {
  reply = { status: 409, body: { error: "WorkCredentialsUnavailable", admission_disposition: "refused" } };
  expect(await send("/api/work/start", { method: "POST", body: intent })).toEqual(reply);
  failure = new Error("private-upstream-canary");
  const result = await send("/api/work/start", { method: "POST", body: intent });
  expect(result.status).toBe(503); expect(result.body.retryable).toBe(true); expect(result.body).not.toHaveProperty("admission_disposition");
  expect(JSON.stringify(result.body)).not.toContain("private-upstream-canary");
});
