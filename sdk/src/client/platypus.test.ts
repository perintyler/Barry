/**
 * Platypus against a real HTTP server — so headers, URL building, status
 * handling and parsing are exercised as the API would see them, not as a
 * fetch mock imagines them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Barry } from "../index.js";
import { BarryApiError, BarryClient } from "./index.js";
import { join } from "node:path";
import * as vaultAccount from "../vault/account.js";
import { apiBaseUrl, type RequestOptions } from "./http.js";
import { connectLocal } from "./local.js";
import { setInstanceEnvValue } from "../services/instance-env.js";
import { barryEnvPath, barryConfigDir } from "../services/home.mjs";
import { tmpdir } from "node:os";
import { writeServiceRegistry } from "../services/service-registry.js";
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: unknown }
type Handler = (req: Seen, res: ServerResponse) => void;

let server: Server;
let origin: string;
let seen: Seen[] = [];
let handler: Handler = (_req, res) => { res.writeHead(500).end(); };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const entry = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { seen = []; });

const json = (status: number, body: unknown, type = "application/json"): Handler => (_req, res) => {
  res.writeHead(status, { "Content-Type": type }).end(JSON.stringify(body));
};
const barry = (options: ConstructorParameters<typeof BarryClient>[0] = {}) =>
  new BarryClient({ baseUrl: origin, secret: "s3cret", ...options });

const SESSION = {
  id: "abc", name: "n", systemPrompt: null, summary: null, repoPath: null, identityId: null,
  identitySource: null, status: "running", bags: [], bounds: [], bound: null, pinned: false, useWorktree: false,
  worktreeStatus: null, worktreePath: null, baseRepoPath: null, source: null, provider: "claude",
  model: null, createdAt: "2026-09-24T00:00:00.000Z", startedAt: null,
};
const EVENT = {
  id: "e1", type: "notification", sessionId: null, source: "bag", title: "Done", body: null,
  severity: "info", data: {}, metadata: {}, deliveredVia: [], readAt: null, createdAt: "2026-09-24T00:00:00.000Z",
};

describe("base URL", () => {
  it.each([
    ["http://h:1", "http://h:1/api/v1"],
    ["http://h:1/", "http://h:1/api/v1"],
    ["http://h:1/api/v1", "http://h:1/api/v1"],
    ["http://h:1/api/v1/", "http://h:1/api/v1"],
  ])("normalizes %s", (input, expected) => {
    expect(apiBaseUrl(input)).toBe(expected);
  });

  it("requires an explicit endpoint", () => {
    expect(() => apiBaseUrl()).toThrow("requires baseUrl");
  });

  it.each(["file:///tmp/barry", "https://token@example.com", "https://example.com?token=secret", "https://example.com#fragment"])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => apiBaseUrl(endpoint)).toThrow("HTTP(S) URL");
  });

});

describe("every request", () => {
  it("authenticates with the configured vault reference and closes it before requests", async () => {
    const configPath = join(barryConfigDir(), "barry.yaml");
    const close = vi.fn(async () => {});
    const getItem = vi.fn(async () => ({ password: "vault-instance" }));
    const open = vi.spyOn(vaultAccount, "openVault").mockResolvedValue({ getItem, close } as never);
    mkdirSync(barryConfigDir(), { recursive: true });
    writeFileSync(configPath, "vault: test-instance\nsecrets:\n  BARRY_SECRET:\n    in: vault\n    item: instance-auth\n    field: password\n");
    vi.stubEnv("BARRY_SECRET", "ambient-secret");
    try {
      handler = json(200, SESSION);
      const client = await connectLocal({ baseUrl: origin });
      expect(open).toHaveBeenCalledWith("test-instance");
      expect(getItem).toHaveBeenCalledWith("instance-auth");
      expect(close).toHaveBeenCalledOnce();
      await client.sessions.get("abc");
      expect(seen.at(-1)?.headers.authorization).toBe("Bearer vault-instance");
      getItem.mockResolvedValue({ password: "" });
      const requestCount = seen.length;
      await expect(connectLocal({ baseUrl: origin })).rejects.toThrow("absent or empty");
      expect(close).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(requestCount);
      await (await connectLocal({ baseUrl: origin, secret: "explicit-device" })).sessions.get("abc");
      expect(open).toHaveBeenCalledTimes(2);
      expect(seen.at(-1)?.headers.authorization).toBe("Bearer explicit-device");
      const resolveCredential = vi.fn(() => "resolved-device");
      const resolved = await connectLocal({ baseUrl: origin, resolveCredential });
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(2);
      await resolved.sessions.get("abc");
      expect(seen.at(-1)?.headers.authorization).toBe("Bearer resolved-device");
    } finally {
      rmSync(configPath, { force: true });
      open.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("uses the local instance file rather than ambient credentials, with explicit caller override", async () => {
    vi.stubEnv("BARRY_SECRET", "ambient-secret");
    const filename = barryEnvPath();
    try {
      handler = json(200, SESSION);
      setInstanceEnvValue("BARRY_SECRET", "owned-instance", filename);
      await (await connectLocal({ baseUrl: origin })).sessions.get("abc");
      expect(seen.at(-1)?.headers.authorization).toBe("Bearer owned-instance");
      await (await connectLocal({ baseUrl: origin, secret: "explicit-device" })).sessions.get("abc");
      expect(seen.at(-1)?.headers.authorization).toBe("Bearer explicit-device");
      rmSync(filename);
      await (await connectLocal({ baseUrl: origin })).sessions.get("abc");
      expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    } finally {
      rmSync(filename, { force: true });
      vi.unstubAllEnvs();
    }
  });
  it("does not send ambient environment credentials", async () => {
    vi.stubEnv("BARRY_SECRET", "ambient-secret");
    try {
      handler = json(200, SESSION);
      await new BarryClient({ baseUrl: origin }).sessions.get("abc");
      expect(seen[0].headers.authorization).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("carries the secret and a JSON content type, and contacts nothing at construction", async () => {
    const client = barry();
    expect(seen).toHaveLength(0);
    handler = json(200, SESSION);
    await client.sessions.get("abc");
    expect(seen[0].url).toBe("/api/v1/sessions/abc");
    expect(seen[0].headers.authorization).toBe("Bearer s3cret");
    expect(seen[0].headers["content-type"]).toBe("application/json");
  });
});

describe("sessions", () => {
  it("answers null for an unknown session rather than throwing", async () => {
    handler = json(404, { title: "Not Found", status: 404 }, "application/problem+json");
    expect(await barry().sessions.get("missing")).toBeNull();
  });

  it("refuses a response that does not match the session contract", async () => {
    handler = json(200, { id: "abc" });
    await expect(barry().sessions.get("abc")).rejects.toMatchObject({ code: "malformed_response", status: 200 });
  });

  it("lists with its filters on the query string", async () => {
    handler = json(200, { sessions: [SESSION], nextCursor: null });
    const page = await barry().sessions.list({ active: true, limit: 5 });
    expect(page.sessions[0].id).toBe("abc");
    expect(seen[0].url).toBe("/api/v1/sessions?active=true&limit=5");
  });
});

describe("identities", () => {
  it("reads bounds as the bounds route serves them", async () => {
    handler = json(200, { bounds: [{
      name: "readonly", description: "Read-only bound", tools: { deny: ["*:write"] },
    }] });
    const bounds = await barry({ identities: { baseUrl: origin, secret: "s3cret" } }).identities.bounds();
    expect(bounds[0]).toMatchObject({ name: "readonly", tools: { deny: ["*:write"] } });
    expect(seen[0].url).toBe("/api/v1/bounds");
  });
});

describe("events", () => {
  it("creates an event and returns it", async () => {
    handler = json(201, { event: EVENT });
    const event = await barry().events.create({ type: "notification", title: "Done" });
    expect(event.id).toBe("e1");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/v1/events", body: { type: "notification", title: "Done" } });
  });

  it("rejects an invalid event without sending it", async () => {
    // @ts-expect-error — not an event type
    await expect(barry().events.create({ type: "gossip", title: "x" })).rejects.toMatchObject({ code: "invalid_request", status: null });
    expect(seen).toHaveLength(0);
  });
});

describe("actions", () => {
  it("translates the snake_case wire to camelCase, both ways", async () => {
    handler = json(200, { run_id: "r1", status: "complete", output: "{}", output_type: "json" });
    const result = await barry().actions.run("summarize", { inputs: { a: 1 }, timeoutS: 30 });
    expect(result).toEqual({ runId: "r1", status: "complete", output: "{}", outputType: "json" });
    expect(seen[0]).toMatchObject({ url: "/api/v1/actions/summarize/run", body: { inputs: { a: 1 }, timeout_s: 30 } });
  });

  it("begins a run, sending the session and translating the result", async () => {
    handler = json(201, {
      run_id: "r2", action: "web:extract-title", action_dir: "/a", prompt: "do it",
      expected_output: { schema: { type: "string" } }, next: "complete it",
    });
    const begun = await barry().actions.begin("extract-title", { sessionId: "s1", inputs: { url: "u" } });
    expect(seen[0]).toMatchObject({ url: "/api/v1/actions/extract-title/begin", body: { session_id: "s1", inputs: { url: "u" } } });
    expect(begun).toEqual({
      runId: "r2", action: "web:extract-title", actionDir: "/a", prompt: "do it", warnings: [],
      willBeChecked: [], expectedOutputSchema: { type: "string" }, next: "complete it",
    });
  });

  it("surfaces the actions routes' own error code", async () => {
    handler = json(409, { error: "context_session", message: "needs a session" });
    const error = await barry().actions.run("wrap-up").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BarryApiError);
    expect(error).toMatchObject({ status: 409, code: "context_session" });
  });

  it("reads the catalog with its scope", async () => {
    handler = json(200, {
      count: 1,
      actions: [{ name: "a", qualified_name: "bag:a", bag: "bag", description: "d", executable: true, input_names: [] }],
      scope: { kind: "identity", identity: "bux", bags: ["bag"] },
    });
    const catalog = await barry().actions.catalog();
    expect(catalog.actions[0]).toEqual({ name: "a", qualifiedName: "bag:a", bag: "bag", description: "d", executable: true });
    expect(catalog.scope.identity).toBe("bux");
  });
});

describe("schedules", () => {
  const SCHEDULE = {
    id: "sch_1", bag: "maint", action: "maint:reap", inputs: { session_id: "s1" },
    dueAt: "2030-01-01T00:00:00.000Z", createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    status: "pending", reason: null, idempotencyKey: "k", timeoutS: 600, retryAttempts: 2, failures: 0, recoveries: 0,
  };

  it("schedules with the time as ISO and the options on the wire, inputs untouched", async () => {
    handler = json(201, { schedule: SCHEDULE });
    const s = await barry().schedules.schedule(new Date("2030-01-01T00:00:00Z"), {
      action: "maint:reap", inputs: { session_id: "s1" }, idempotencyKey: "k", attempts: 2,
    });
    expect(s.inputs).toEqual({ session_id: "s1" });
    expect(seen[0]).toMatchObject({
      url: "/api/v1/schedules/once",
      body: { action: "maint:reap", dueAt: "2030-01-01T00:00:00.000Z", inputs: { session_id: "s1" }, idempotencyKey: "k", retry: { attempts: 2 } },
    });
  });

  it.each([
    { identity: "fixture", bags: ["script"], bounds: ["restricted"] },
    { bags: [], bounds: [] },
    {},
  ])("preserves explicit schedule permissions on the HTTP wire: %j", async (permissions) => {
    handler = json(201, { schedule: SCHEDULE });
    await barry().schedules.schedule("2030-01-01", { action: "maint:reap", ...permissions });
    const body = seen[0].body as Record<string, unknown>;
    for (const key of ["identity", "bags", "bounds"] as const) {
      expect(Object.hasOwn(body, key)).toBe(Object.hasOwn(permissions, key));
      expect(body[key]).toEqual(permissions[key]);
    }
  });

  it("refuses an unparseable time without sending", async () => {
    await expect(barry().schedules.schedule("whenever", { action: "b:s" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(seen).toHaveLength(0);
  });

  it("answers null for an unknown schedule", async () => {
    handler = json(404, { title: "Unknown schedule", status: 404 }, "application/problem+json");
    expect(await barry().schedules.get("sch_nope")).toBeNull();
  });
});

describe("jobs", () => {
  const RUN = {
    id: "sch_9", job: "ops:greet", status: "pending", reason: null, key: "k", callerSessionId: null, attempts: 0,
    runId: null, output: null, outputType: null, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
  };

  it("starts a job with its inputs and options on the wire, and reads its checked output", async () => {
    const states = [RUN, { ...RUN, status: "succeeded", attempts: 1, runId: "arn_1", output: "{\"greeting\":\"hi\"}", outputType: "json" }];
    handler = (req, res) => {
      res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" }).end(JSON.stringify({ run: states.shift() }));
    };
    const run = await barry().jobs.run("ops:greet", { name: "barry" }, { key: "k", callerSessionId: "sess-1" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/v1/jobs/ops%3Agreet/runs", body: { inputs: { name: "barry" }, key: "k", callerSessionId: "sess-1" } });
    expect(await run.output()).toEqual({ greeting: "hi" });
    expect(seen[1]).toMatchObject({ method: "GET", url: "/api/v1/jobs/runs/sch_9?waitS=60" });
  });

  it("throws, naming why, when the run did not succeed", async () => {
    handler = json(201, { run: { ...RUN, status: "failed", reason: "exited 1" } });
    const run = await barry().jobs.run("ops:greet");
    await expect(run.output()).rejects.toMatchObject({ code: "job_failed", message: "Job ops:greet failed: exited 1" });
  });

  it("answers null for an unknown run", async () => {
    handler = json(404, { title: "Unknown job run", status: 404 }, "application/problem+json");
    expect(await barry().jobs.get("sch_nope")).toBeNull();
  });
});

describe("failures carry a reason", () => {
  it("names a problem+json refusal, e.g. a missing secret", async () => {
    handler = json(403, { type: "about:blank", title: "Forbidden", status: 403, detail: "secret required" }, "application/problem+json");
    await expect(barry().sessions.list()).rejects.toMatchObject({ status: 403, code: "http_403", message: expect.stringContaining("secret required") });
  });

  it("times out instead of hanging", async () => {
    handler = () => { /* never answer */ };
    await expect(barry({ timeoutMs: 200 }).sessions.list()).rejects.toMatchObject({ status: null, code: "timeout" });
  });

  it("reports an unreachable API as such", async () => {
    await expect(new BarryClient({ baseUrl: "http://127.0.0.1:1", secret: "x" }).sessions.list())
      .rejects.toMatchObject({ status: null, code: "unreachable" });
  });

  it("answers Barry's questions over HTTP once Barry.connect names a Barry", async () => {
    handler = json(200, { events: [], nextCursor: null });
    Barry.connect({ baseUrl: origin, secret: "s3cret" });
    try {
      expect(await Barry.events()).toEqual([]);
      expect(seen.at(-1)?.url).toContain("/api/v1/events");
    } finally {
      Barry.reset();
    }
    expect(BarryClient.connect({ baseUrl: origin, secret: "s3cret" })).toBeInstanceOf(BarryClient);
  });
});

describe("request cancellation and deadlines", () => {
  it("refuses an already cancelled request before sending", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private-abort-reason"));
    await expect(barry().sessions.list({}, { signal: controller.signal }))
      .rejects.toMatchObject({ status: null, code: "cancelled" });
    expect(seen).toHaveLength(0);
  });

  it("cancels an in-flight write without repeating it or exposing the abort reason", async () => {
    let received!: () => void;
    let closed!: () => void;
    const ready = new Promise<void>(resolve => { received = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    handler = (_request, response) => {
      response.once("close", closed);
      received();
    };
    const controller = new AbortController();
    const result = barry().events.create({ type: "notification", title: "Once" }, { signal: controller.signal }).catch(error => error);
    await ready;
    controller.abort(new Error("private-abort-reason"));
    const error = await result;
    await disconnected;
    expect(error).toBeInstanceOf(BarryApiError);
    expect(error).toMatchObject({ status: null, code: "cancelled" });
    expect(String(error)).not.toContain("private-abort-reason");
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ type: "notification", title: "Once" });
  });

  it("cancels while reading the response body and preserves its request ID", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "x-request-id": "partial-body" });
      response.write('{"sessions":[');
    };
    let reading!: () => void;
    const ready = new Promise<void>(resolve => { reading = resolve; });
    const nativeFetch = globalThis.fetch;
    const client = barry({ fetch: async (input, init) => {
      const response = await nativeFetch(input, init);
      const text = response.text.bind(response);
      response.text = () => { reading(); return text(); };
      return response;
    } });
    const controller = new AbortController();
    const result = client.sessions.list({}, { signal: controller.signal }).catch(error => error);
    await ready;
    controller.abort();
    expect(await result).toMatchObject({ code: "cancelled", status: 200, requestId: "partial-body" });
  });

  it("applies a per-request deadline to an unfinished response body", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "x-request-id": "body-deadline" });
      response.write('{"sessions":[');
    };
    await expect(barry({ timeoutMs: 10_000 }).sessions.list({}, { timeoutMs: 200 }))
      .rejects.toMatchObject({ status: 200, code: "timeout", requestId: "body-deadline" });
    expect(seen[0].url).toBe("/api/v1/sessions");
  });

  it.each([0, -1, NaN, Infinity, 1.5, 2_147_483_648])("refuses invalid timeout %s", async timeoutMs => {
    expect(() => barry({ timeoutMs })).toThrow(BarryApiError);
    await expect(barry().sessions.get("abc", { timeoutMs })).rejects.toMatchObject({ code: "invalid_request" });
    expect(seen).toHaveLength(0);
  });

  it("retains request IDs on authorization and malformed-response errors", async () => {
    handler = (_request, response) => {
      response.writeHead(403, { "x-request-id": "denied-request" }).end(JSON.stringify({ error: "scope_required", message: "sessions:read" }));
    };
    await expect(barry().sessions.list()).rejects.toMatchObject({ code: "scope_required", status: 403, requestId: "denied-request" });
    handler = (_request, response) => {
      response.writeHead(200, { "x-request-id": "invalid-response" }).end('{}');
    };
    await expect(barry().sessions.list()).rejects.toMatchObject({ code: "malformed_response", requestId: "invalid-response" });
  });

  it("does not expose a credential included in a transport exception", async () => {
    const client = barry({ fetch: async () => { throw new Error("private-transport-secret"); } });
    const error = await client.sessions.list().catch(error => error);
    expect(error).toMatchObject({ code: "unreachable" });
    expect(String(error)).not.toContain("private-transport-secret");
  });
});

const cancellableCalls: [string, (client: BarryClient, request: RequestOptions) => Promise<unknown>][] = [
  ["sessions.get", (client, request) => client.sessions.get("session", request)],
  ["sessions.list", (client, request) => client.sessions.list({}, request)],
  ["sessions.search", (client, request) => client.sessions.search("query", {}, request)],
  ["events.create", (client, request) => client.events.create({ type: "notification", title: "Once" }, request)],
  ["events.list", (client, request) => client.events.list({}, request)],
  ["actions.catalog", (client, request) => client.actions.catalog(request)],
  ["actions.trigger", (client, request) => client.actions.trigger("action", {}, request)],
  ["actions.begin", (client, request) => client.actions.begin("action", {}, request)],
  ["actions.run", (client, request) => client.actions.run("action", {}, request)],
  ["actions.getRun", (client, request) => client.actions.getRun("run", request)],
  ["actions.listRuns", (client, request) => client.actions.listRuns({}, request)],
  ["schedules.schedule", (client, request) => client.schedules.schedule("2030-01-01", { action: "bag:action" }, request)],
  ["schedules.get", (client, request) => client.schedules.get("schedule", request)],
  ["schedules.list", (client, request) => client.schedules.list({}, request)],
  ["schedules.cancel", (client, request) => client.schedules.cancel("schedule", request)],
  ["jobs.run", (client, request) => client.jobs.run("bag:job", {}, {}, request)],
  ["jobs.get", (client, request) => client.jobs.get("run", {}, request)],
  ["jobs.cancel", (client, request) => client.jobs.cancel("run", request)],
];
it.each(cancellableCalls)("%s honours cancellation before any HTTP request", async (_name, call) => {
  const signal = AbortSignal.abort();
  await expect(call(barry(), { signal })).rejects.toMatchObject({ code: "cancelled" });
  expect(seen).toHaveLength(0);
});

it("reports the deadline when it aborts before the caller's signal", async () => {
  const controller = new AbortController();
  const client = barry({ fetch: async (_input, options) => new Promise<Response>((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => {
      controller.abort(new Error("later-private-reason"));
      reject(new Error("transport-aborted"));
    }, { once: true });
  }) });
  await expect(client.sessions.list({}, { signal: controller.signal, timeoutMs: 100 }))
    .rejects.toMatchObject({ code: "timeout", status: null });
});

describe("cursor iteration", () => {
  it("walks session pages lazily and preserves filters and the initial cursor", async () => {
    handler = (request, response) => {
      const cursor = new URL(request.url, origin).searchParams.get("cursor");
      response.end(JSON.stringify({ sessions: [{ ...SESSION, id: cursor === "start" ? "first" : "second" }], nextCursor: cursor === "start" ? "next" : null }));
    };
    const options = { limit: 1, active: true, cursor: "start" };
    const pages = barry().sessions.pages(options);
    options.active = false;
    expect(seen).toHaveLength(0);
    expect((await pages.next()).value.sessions[0].id).toBe("first");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/v1/sessions?limit=1&active=true&cursor=start");
    expect((await pages.next()).value.sessions[0].id).toBe("second");
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toBe("/api/v1/sessions?limit=1&active=true&cursor=next");
    expect((await pages.next()).done).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("iterates events across empty intermediate pages", async () => {
    handler = (request, response) => {
      const cursor = new URL(request.url, origin).searchParams.get("cursor");
      response.end(JSON.stringify(cursor === "empty"
        ? { events: [], nextCursor: "last" }
        : { events: [{ ...EVENT, id: cursor === "last" ? "second" : "first" }], nextCursor: cursor === "last" ? null : "empty" }));
    };
    const ids: string[] = [];
    for await (const event of barry().events.iterate({ unread: true })) ids.push(event.id);
    expect(ids).toEqual(["first", "second"]);
    expect(seen).toHaveLength(3);
    expect(seen[2].url).toBe("/api/v1/events?unread=true&cursor=last");
  });

  it("stops without requesting another page when the loop exits early", async () => {
    handler = json(200, { sessions: [SESSION], nextCursor: "more" });
    for await (const session of barry().sessions.iterate()) {
      expect(session.id).toBe("abc");
      break;
    }
    expect(seen).toHaveLength(1);
  });

  it("honours cancellation while consuming a buffered page", async () => {
    handler = json(200, { sessions: [SESSION, { ...SESSION, id: "buffered" }], nextCursor: "more" });
    const controller = new AbortController();
    const records = barry().sessions.iterate({}, { signal: controller.signal });
    expect((await records.next()).value.id).toBe("abc");
    controller.abort();
    await expect(records.next()).rejects.toMatchObject({ code: "cancelled" });
    expect(seen).toHaveLength(1);
  });

  it.each(["pages", "iterate"] as const)("refuses a cancelled event %s iterator before fetching", async method => {
    const iterator = barry().events[method]({}, { signal: AbortSignal.abort() });
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
    expect(seen).toHaveLength(0);
  });

  it.each(["", "start"])("rejects a non-advancing cursor %j without an infinite fetch loop", async nextCursor => {
    handler = json(200, { sessions: [SESSION], nextCursor });
    const pages = barry().sessions.pages({ cursor: "start" });
    await expect(pages.next()).rejects.toMatchObject({ code: "invalid_pagination" });
    expect(seen).toHaveLength(1);
  });

  it("detects a cursor cycle across multiple pages", async () => {
    handler = (request, response) => {
      const cursor = new URL(request.url, origin).searchParams.get("cursor");
      response.end(JSON.stringify({ sessions: [], nextCursor: cursor === "first" ? "second" : "first" }));
    };
    const pages = barry().sessions.pages({ cursor: "first" });
    expect((await pages.next()).done).toBe(false);
    await expect(pages.next()).rejects.toMatchObject({ code: "invalid_pagination" });
    expect(seen).toHaveLength(2);
  });

  it("keeps traversal fixed when a consumer edits a returned page", async () => {
    handler = (request, response) => {
      const cursor = new URL(request.url, origin).searchParams.get("cursor");
      response.end(JSON.stringify({ sessions: [], nextCursor: cursor ? null : "actual" }));
    };
    const pages = barry().sessions.pages();
    const first = await pages.next();
    first.value.nextCursor = "edited";
    await pages.next();
    expect(seen[1].url).toBe("/api/v1/sessions?cursor=actual");
  });
});

describe("request credential resolution", () => {
  it("resolves fresh credentials lazily for each real HTTP request", async () => {
    handler = json(200, SESSION);
    let token = "first-token";
    const resolveCredential = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      return token;
    });
    const client = new BarryClient({ baseUrl: origin, resolveCredential });
    expect(resolveCredential).not.toHaveBeenCalled();
    await client.sessions.get("abc");
    token = "rotated-token";
    await client.sessions.get("abc");
    expect(seen.map(request => request.headers.authorization)).toEqual(["Bearer first-token", "Bearer rotated-token"]);
    expect(resolveCredential).toHaveBeenCalledTimes(2);
  });

  it("rejects ambiguous credentials before invoking a resolver", () => {
    const resolveCredential = vi.fn(() => "token");
    expect(() => new BarryClient({ baseUrl: origin, secret: "token", resolveCredential })).toThrow("Choose secret or resolveCredential");
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it.each(["", "token\nprivate", "token with space"])("refuses invalid resolved credentials without sending (%j)", async token => {
    const client = new BarryClient({ baseUrl: origin, resolveCredential: () => token });
    await expect(client.sessions.get("abc")).rejects.toMatchObject({ code: "credential_error", status: null, detail: undefined });
    expect(seen).toEqual([]);
  });

  it("redacts resolver failures and does not retry", async () => {
    const resolveCredential = vi.fn(async () => { throw new Error("private-refresh-token"); });
    const client = new BarryClient({ baseUrl: origin, resolveCredential });
    await expect(client.sessions.get("abc")).rejects.toMatchObject({ code: "credential_error", message: "Barry credential could not be resolved", detail: undefined });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("times out an uncooperative resolver and never sends its late token", async () => {
    let finish!: (token: string) => void;
    const client = new BarryClient({ baseUrl: origin, resolveCredential: () => new Promise(resolve => { finish = resolve; }) });
    await expect(client.sessions.get("abc", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    finish("late-token");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
  });

  it("cancels credential resolution even when the resolver ignores its signal", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const client = new BarryClient({ baseUrl: origin, resolveCredential: () => { started(); return new Promise<string>(() => {}); } });
    const request = client.sessions.get("abc", { signal: controller.signal });
    const assertion = expect(request).rejects.toMatchObject({ code: "cancelled" });
    await ready;
    controller.abort("private-token");
    await assertion;
    expect(seen).toEqual([]);
  });

  it("does not resolve credentials for a pre-cancelled request", async () => {
    const resolveCredential = vi.fn(() => "token");
    const client = new BarryClient({ baseUrl: origin, resolveCredential });
    await expect(client.sessions.get("abc", { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

describe("session writes", () => {
  it("creates an idle session with schema defaults and explicit policy", async () => {
    handler = json(201, SESSION);
    const result = await barry().sessions.create({ systemPrompt: "Assist with the project", identityId: 12, reviewPolicy: { mode: "review_required" } });
    expect(result).toEqual(SESSION);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/v1/sessions", body: { systemPrompt: "Assist with the project", identityId: 12, reviewPolicy: { mode: "review_required" } } });
    expect("started" in result).toBe(false);
  });

  it.each([
    { started: true },
    { started: false, startError: "Selected provider is unavailable" },
  ])("preserves a created session's first-turn outcome %j", async outcome => {
    handler = json(201, { ...SESSION, ...outcome });
    const result = await barry().sessions.create({ systemPrompt: "Assist", prompt: "Start the task", bags: ["browser"], bound: { tools: { deny: [] } } });
    expect(result).toEqual({ ...SESSION, ...outcome });
    expect(seen[0].body).toMatchObject({ prompt: "Start the task", bags: ["browser"], bound: { tools: { deny: [] } } });
    expect(seen).toHaveLength(1);
  });

  it.each([
    { started: false },
    { started: true, startError: "Contradictory failure" },
    { startError: "Missing outcome" },
  ])("rejects contradictory creation responses %j", async outcome => {
    handler = json(201, { ...SESSION, ...outcome });
    await expect(barry().sessions.create({ systemPrompt: "Assist" })).rejects.toMatchObject({ code: "malformed_response", status: 201 });
    expect(seen).toHaveLength(1);
  });

  it("updates only specified fields and encodes session IDs", async () => {
    handler = json(200, { ...SESSION, pinned: true });
    await barry().sessions.update("id/with space", { pinned: true });
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/api/v1/sessions/id%2Fwith%20space", body: { pinned: true } });
    expect(seen[0].body).not.toHaveProperty("bags");
    await barry().sessions.update("abc", { bags: [], bounds: [], bound: null });
    expect(seen[1].body).toEqual({ bags: [], bounds: [], bound: null });
  });

  it("rejects invalid creation and ignored update fields without resolving credentials", async () => {
    const resolveCredential = vi.fn(() => "token");
    const client = new BarryClient({ baseUrl: origin, resolveCredential });
    await expect(client.sessions.create({ systemPrompt: "" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.sessions.update("abc", { prompt: "ignored" } as never)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.sessions.update("abc", { useWorktree: true } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("preserves write scope failures and does not retry creation", async () => {
    handler = json(403, { error: "scope_denied", message: "Missing sessions:write" });
    await expect(barry().sessions.create({ systemPrompt: "Assist" })).rejects.toMatchObject({ status: 403, code: "scope_denied" });
    expect(seen).toHaveLength(1);
  });

  it("cancels writes before sending", async () => {
    const request = { signal: AbortSignal.abort("private-token") };
    await expect(barry().sessions.create({ systemPrompt: "Assist" }, request)).rejects.toMatchObject({ code: "cancelled" });
    await expect(barry().sessions.update("abc", { name: "Updated" }, request)).rejects.toMatchObject({ code: "cancelled" });
    expect(seen).toEqual([]);
  });
});

const IDENTITY = {
  id: 1, token: "barry-test", name: "assistant", displayName: null,
  bags: [], bounds: [], adapters: {}, envKeys: [], vaultEmail: null, isDefault: false,
  createdAt: "2026-10-03T00:00:00.000Z", lastUsedAt: null,
};

describe("identity service client", () => {
  const client = () => barry({ identities: { baseUrl: `${origin}/admin`, secret: "identity-token" } });

  it("requires an explicit identity endpoint without blocking session requests", async () => {
    handler = json(200, SESSION);
    const api = barry();
    await expect(api.identities.list()).rejects.toMatchObject({ code: "service_unconfigured", status: null });
    expect(seen).toEqual([]);
    await api.sessions.get("abc");
    expect(seen).toHaveLength(1);
  });

  it("uses the identity endpoint and its own credential", async () => {
    handler = (request, res) => json(200, request.url.startsWith("/admin") ? { identity: IDENTITY } : SESSION)(request, res);
    const api = client();
    await api.identities.get(1);
    await api.sessions.get("abc");
    expect(seen.map(request => [request.url, request.headers.authorization])).toEqual([
      ["/admin/api/v1/identities/1", "Bearer identity-token"],
      ["/api/v1/sessions/abc", "Bearer s3cret"],
    ]);
  });

  it("never forwards a root credential to an explicitly configured service", async () => {
    handler = json(401, { error: "unauthorized" });
    const api = barry({ identities: { baseUrl: `${origin}/admin` } });
    await expect(api.identities.list()).rejects.toMatchObject({ status: 401 });
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it("lists identities and supports stable file IDs in the reserved positive range", async () => {
    handler = json(200, { identities: [IDENTITY] });
    expect(await client().identities.list()).toEqual([IDENTITY]);
    handler = json(200, { identity: { ...IDENTITY, id: 1_000_000_123 } });
    expect((await client().identities.get(1_000_000_123))?.id).toBe(1_000_000_123);
    expect(seen[1].url).toBe("/admin/api/v1/identities/1000000123");
    handler = json(404, { error: "Identity not found" });
    expect(await client().identities.get(99)).toBeNull();
  });

  it("preserves effective identity provenance and repository filters", async () => {
    const effective = { identity: IDENTITY, source: "repo", repoRoot: "/tmp/project" };
    handler = json(200, effective);
    expect(await client().identities.effective({ repoPath: "/tmp/project with space" })).toEqual(effective);
    const endpoint = new URL(seen[0].url, origin);
    expect(endpoint.pathname).toBe("/admin/api/v1/identities/effective");
    expect(endpoint.searchParams.get("repoPath")).toBe("/tmp/project with space");
  });

  it("preserves mutation warnings and sends only requested updates", async () => {
    const warnings = [{ kind: "missing_binary", bag: "browser", message: "Install browser" }];
    handler = json(201, { identity: IDENTITY, warnings });
    expect(await client().identities.create({ name: "assistant", bags: ["browser"], source: "file" })).toEqual({ identity: IDENTITY, warnings });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/admin/api/v1/identities", body: { name: "assistant", bags: ["browser"], source: "file" } });
    handler = json(200, { identity: IDENTITY, warnings });
    expect((await client().identities.update(1, { displayName: "Assistant" })).warnings).toEqual(warnings);
    expect(seen[1]).toMatchObject({ method: "PATCH", body: { displayName: "Assistant" } });
    await client().identities.update(1, { bags: [], bounds: [] });
    expect(seen[2].body).toEqual({ bags: [], bounds: [] });
  });

  it("resolves service credentials independently without eager authentication", async () => {
    const root = vi.fn(() => "root-token");
    const identity = vi.fn(() => "scoped-token");
    const api = new BarryClient({ baseUrl: origin, resolveCredential: root, identities: { baseUrl: `${origin}/admin`, resolveCredential: identity } });
    expect(root).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    handler = json(200, { identity: IDENTITY });
    await api.identities.get(1);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(root).not.toHaveBeenCalled();
    expect(seen[0].headers.authorization).toBe("Bearer scoped-token");
  });

  it("rejects invalid IDs and inputs before credential resolution", async () => {
    const resolveCredential = vi.fn(() => "token");
    const api = barry({ identities: { baseUrl: origin, resolveCredential } });
    for (const id of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(api.identities.get(id)).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(api.identities.create({ name: "" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(api.identities.update(1, { unrelated: true } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("preserves scope errors and never retries a mutation", async () => {
    handler = json(403, { error: "scope_denied", message: "Missing identities:write" });
    await expect(client().identities.create({ name: "assistant" })).rejects.toMatchObject({ code: "scope_denied", status: 403 });
    expect(seen).toHaveLength(1);
  });

  it("rejects malformed identity responses", async () => {
    handler = json(200, { identity: { ...IDENTITY, bags: "invalid" } });
    await expect(client().identities.get(1)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("cancels identity writes before sending", async () => {
    await expect(client().identities.create({ name: "assistant" }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    expect(seen).toEqual([]);
  });

  it("discovers the selected local identity service and respects explicit overrides", async () => {
    const home = mkdtempSync(join(tmpdir(), "barry-local-identity-"));
    vi.stubEnv("BARRY_HOME", home);
    try {
      writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
        "identities.identities": { bag: "identities", name: "identities", kind: "service", url: `${origin}/admin` },
      } });
      handler = json(200, { identity: IDENTITY });
      const local = await connectLocal({ baseUrl: origin, secret: "instance-token" });
      await local.identities.get(1);
      expect(seen[0]).toMatchObject({ url: "/admin/api/v1/identities/1", headers: { authorization: "Bearer instance-token" } });
      const explicit = await connectLocal({ baseUrl: origin, secret: "instance-token", identities: { baseUrl: `${origin}/override`, secret: "other-token" } });
      await explicit.identities.get(1);
      expect(seen[1]).toMatchObject({ url: "/override/api/v1/identities/1", headers: { authorization: "Bearer other-token" } });
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});


it("encodes a named identity and refuses an empty reference before HTTP", async () => {
  const client = barry({ identities: { baseUrl: origin } });
  handler = json(404, { error: "missing" });
  expect(await client.identities.get("named/identity")).toBeNull();
  expect(seen[0].url).toBe("/api/v1/identities/named%2Fidentity");
  await expect(client.identities.get("")).rejects.toMatchObject({ code: "invalid_request" });
  expect(seen).toHaveLength(1);
});

it("accepts hosted message admission 202 and keeps the queued/warm receipt",async()=>{
 handler=json(202,{ok:true,sessionId:"abc",deliveryState:"accepted",turn:"queued",warm:0});
 const result=await barry().sessions.send("abc","hello",{clientMessageId:"once"});
 expect(result).toMatchObject({ok:true,turn:"queued",warm:0});expect(seen[0].body).toEqual({content:"hello",clientMessageId:"once"});
});
it("surfaces retryable recording-backlog 503 instead of treating it as admission",async()=>{
 handler=json(503,{ok:false,error:"Recording delayed",code:"persistence_lagging",retryable:true});
 await expect(barry().sessions.send("abc","later")).rejects.toMatchObject({status:503});
});
