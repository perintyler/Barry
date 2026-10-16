import { afterEach, expect, it, vi } from "vitest";
import { Barry } from "./index.js";

afterEach(() => Barry.reset());

function remote(...bodies: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(bodies.shift()));
  Barry.connect({ baseUrl: "http://example.test", secret: "test", fetch, identities: { baseUrl: "http://example.test", secret: "test", fetch } });
  return fetch;
}

const wireRun = {
  run_id: "r1", action: "bag:action", bag: "bag", session_id: "s1", status: "complete",
  summary: "done", started_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:00:01Z",
  output: "ok", output_type: "text", metadata: null, validated_at: null,
};
const wireSchedule = {
  id: "bag/nightly", trigger: "cron 0 0 * * *", action: "bag:action", enabled: true, paused: false,
  next_fire_at: null, last_fired_at: null, last_status: null, last_summary: null, last_run_id: null,
  consecutive_failures: 0, skipped_fires: 0, missed_fires: 0,
};

it("stops a session through the client and accepts the route's message", async () => {
  const fetch = remote({ message: "Stopped" });
  await Barry.identity(3).session("s/1").end();
  expect(String(fetch.mock.calls[0][0])).toBe("http://example.test/api/v1/sessions/s%2F1/stop");
  expect(fetch.mock.calls[0][1]?.method).toBe("POST");
});

it("sends the identity filter to the sessions route", async () => {
  const fetch = remote({ sessions: [], nextCursor: null });
  expect(await Barry.identity(3).sessions()).toEqual([]);
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("identityId")).toBe("3");
});

it("forwards an action's identity and session caller, then maps its recorded summary", async () => {
  const fetch = remote({ run_id: "r1", status: "complete", output: "ok", output_type: "text" }, wireRun);
  const result = await Barry.as({ kind: "session", identity: "bux", sessionId: "s1" })
    .action("bag:action").run({ path: "a" }, { identity: "bux" });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    inputs: { path: "a" }, identity: "bux", caller_session_id: "s1",
  });
  expect(result).toMatchObject({ id: "r1", status: "succeeded", summary: "done", endedAt: wireRun.completed_at });
});

it("composes action and schedule handles through the runs query", async () => {
  const fetch = remote({ count: 0, runs: [] }, { count: 0, runs: [] });
  await Barry.action("bag:action").runs();
  await Barry.schedule("bag/nightly").runs();
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("action")).toBe("bag:action");
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("schedule_id")).toBe("bag/nightly");
});

it("maps recurring schedules and scheduler health from the existing route", async () => {
  const body = { scheduler: { status: "degraded", reason: "late", heartbeat_at: null }, schedules: [wireSchedule], load_errors: ["missing"] };
  const fetch = remote(body, body);
  expect(await Barry.schedules()).toMatchObject([{ id: "bag/nightly", nextFireAt: null, consecutiveFailures: 0 }]);
  expect(await Barry.scheduler()).toEqual({ status: "degraded", reason: "late", heartbeatAt: null, loadErrors: ["missing"] });
  expect(String(fetch.mock.calls[0][0])).toBe("http://example.test/api/v1/schedules");
});

it("forwards the at-schedule query", async () => {
  const fetch = remote({ schedules: [] });
  await Barry.atSchedules({ status: "pending", limit: 7 });
  const query = new URL(String(fetch.mock.calls[0][0])).searchParams;
  expect(query.get("status")).toBe("pending");
  expect(query.get("limit")).toBe("7");
});

it("refuses a job identity before the client could discard it", async () => {
  const fetch = remote();
  await expect(Barry.bag("bag").job("job").run({}, { identity: "bux" })).rejects.toMatchObject({ reason: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

it("forwards a numeric action identity as identity_id", async () => {
  const fetch = remote({ run_id: "r1", status: "complete", output: "ok", output_type: "text" }, wireRun);
  await Barry.action("bag:action").run({}, { identity: 3 });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ identity_id: 3 });
});

const wireIdentity = {
  id: 3, name: "bux", token: "identity-token", vaultEmail: null, isDefault: false, createdAt: "2026-09-24T00:00:00Z", lastUsedAt: null, displayName: null, bags: [], bounds: [], bound: null,
  adapters: {}, envKeys: [],
};
const wireSession = {
  id: "s1", name: "Session", systemPrompt: null, summary: null, repoPath: null, identityId: 3,
  identitySource: null, status: "running", bags: [], bounds: [], bound: null, pinned: false, useWorktree: false,
  worktreeStatus: null, worktreePath: null, baseRepoPath: null, source: null, provider: "claude",
  model: null, createdAt: "2026-09-24T00:00:00Z", startedAt: null,
};

it("gets and updates a named identity directly", async () => {
  const fetch = remote({ identity: wireIdentity }, { identity: wireIdentity });
  await Barry.identity("bux").get();
  await Barry.identity("bux").update({ adapters: { codex: { default: true } } });
  expect(String(fetch.mock.calls[0][0])).toBe("http://example.test/api/v1/identities/bux");
  expect(String(fetch.mock.calls[1][0])).toBe("http://example.test/api/v1/identities/bux");
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ adapters: { codex: { default: true } } });
});

it("resolves a reserved identity name through the list", async () => {
  const identity = { ...wireIdentity, name: "effective" };
  const fetch = remote({ identities: [identity] }, { identity });
  expect((await Barry.identity("effective").get()).name).toBe("effective");
  expect(String(fetch.mock.calls[1][0])).toBe("http://example.test/api/v1/identities/3");
});

it("refuses any update field the wire schema cannot accept", async () => {
  const fetch = remote();
  await expect(Barry.identity("bux").update({ aliases: ["helper"] })).rejects.toMatchObject({ reason: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

it("maps session changes after checking the session", async () => {
  const fetch = remote(wireSession, { changes: [{ id: 1, sessionId: "s1", filePath: "a.ts", tool: "Edit", diff: null, sizeBytes: null, createdAt: "2026-10-01 12:00:00" }] });
  expect(await Barry.identity(3).session("s1").changes()).toEqual([{ sessionId: "s1", path: "a.ts", tool: "Edit", at: "2026-10-01T12:00:00.000Z" }]);
  expect(String(fetch.mock.calls[1][0])).toBe("http://example.test/api/v1/changes/session/s1");
});

it("maps the session's action catalog", async () => {
  const fetch = remote({ count: 1, actions: [{ name: "local", qualified_name: "local", bag: "", description: "Session action", executable: true, input_names: ["path"], input_schema: { properties: { path: { type: "string" } } } }], scope: { kind: "identity", identity: "bux", bags: [] } });
  expect(await Barry.identity(3).session("s1").actions()).toMatchObject([{ name: "local", bag: "", inputs: ["path"] }]);
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("session_id")).toBe("s1");
});

it("filters session pages without losing the continuation cursor", async () => {
  const fetch = remote({ sessions: [wireSession], nextCursor: "older" }, { sessions: [{ ...wireSession, id: "s2", status: "completed", pinned: true }], nextCursor: null });
  const result = await Barry.identity(3).sessions({ status: ["completed"], pinned: true, since: "2026-09-01T00:00:00Z" });
  expect(result.map(session => session.id)).toEqual(["s2"]);
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("cursor")).toBe("older");
});

it("reads messages from the first sequence and continues through the history", async () => {
  const message = { type: "text", sessionId: "s1", content: "first", role: "user", sequence: 0, createdAt: "2026-10-01T00:00:00Z" };
  const fetch = remote({ messages: [message], nextSequence: 0, hasMore: true }, { messages: [{ ...message, content: "second", sequence: 1 }], nextSequence: 1, hasMore: false });
  const result = await Barry.identity(3).session("s1").messages();
  expect(result.map(record => record.sequence)).toEqual([0, 1]);
  // A session's first message is sequence 0, and `after` is exclusive.
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("after")).toBe("-1");
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("after")).toBe("0");
});

const wireMessage = { type: "text", sessionId: "s1", content: "message", role: "user", sequence: 0, createdAt: "2026-10-01T00:00:00Z" };

it("forwards active and activity order and maps created order", async () => {
  const fetch = remote({ sessions: [], nextCursor: null }, { sessions: [], nextCursor: null });
  await Barry.identity(3).sessions({ active: true, order: "activity" });
  await Barry.identity(3).sessions({ order: "created" });
  const first = new URL(String(fetch.mock.calls[0][0])).searchParams;
  expect(first.get("active")).toBe("true");
  expect(first.get("order")).toBe("activity");
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("order")).toBe("created_at");
});

it("refuses active false without asking the route", async () => {
  const fetch = remote();
  await expect(Barry.identity(3).sessions({ active: false })).rejects.toMatchObject({ reason: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

it("pages backward from the lowest sequence and carries brief", async () => {
  const fetch = remote(
    { messages: [{ ...wireMessage, sequence: 3 }, { ...wireMessage, sequence: 4 }], nextSequence: 4, hasMore: true },
    { messages: [{ ...wireMessage, sequence: 2 }], nextSequence: 2, hasMore: false },
  );
  const result = await Barry.identity(3).session("s1").messages({ before: 5, brief: true });
  expect(result.map(message => message.sequence)).toEqual([4, 3, 2]);
  const first = new URL(String(fetch.mock.calls[0][0])).searchParams;
  expect(first.get("before")).toBe("5");
  expect(first.get("after")).toBeNull();
  expect(first.get("summary")).toBe("true");
  expect(first.get("limit")).toBe("500");
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("before")).toBe("3");
});

it("reads the newest page without a bound and resumes after an explicit sequence", async () => {
  const fetch = remote(
    { messages: [wireMessage], nextSequence: 0, hasMore: false },
    { messages: [{ ...wireMessage, sequence: 8 }], nextSequence: 8, hasMore: false },
  );
  await Barry.identity(3).session("s1").messages({ newestFirst: true });
  await Barry.identity(3).session("s1").messages({ after: 7 });
  const first = new URL(String(fetch.mock.calls[0][0])).searchParams;
  expect(first.get("before")).toBeNull();
  expect(first.get("after")).toBeNull();
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("after")).toBe("7");
});

it("reads one message and refuses absent or nonmatching sequences", async () => {
  const fetch = remote(
    { messages: [{ ...wireMessage, sequence: 2 }], nextSequence: 2, hasMore: true },
    { messages: [], nextSequence: null, hasMore: false },
    { messages: [{ ...wireMessage, sequence: 4 }], nextSequence: 4, hasMore: false },
  );
  const session = Barry.identity(3).session("s1");
  expect((await session.message(2)).sequence).toBe(2);
  await expect(session.message(3)).rejects.toMatchObject({ reason: "not_found" });
  await expect(session.message(3)).rejects.toMatchObject({ reason: "not_found" });
  const query = new URL(String(fetch.mock.calls[0][0])).searchParams;
  expect(query.get("after")).toBe("1");
  expect(query.get("limit")).toBe("1");
});

it("reports listeners and guarantees while preserving session-id keys", async () => {
  const fetch = remote(
    { guarantees: { s_one: { guarantee: "none", listeners: [{}] } } },
    { guarantees: { s_one: { guarantee: "wake", listeners: [] } } },
    { guarantees: { s_one: { guarantee: "none", listeners: [] } } },
    { guarantees: {} },
  );
  const session = Barry.identity(3).session("s_one");
  expect(await session.listening()).toBe(true);
  expect(await session.listening()).toBe(true);
  expect(await session.listening()).toBe(false);
  expect(await session.listening()).toBe(false);
  expect(String(fetch.mock.calls[0][0])).toBe("http://example.test/api/v1/prompts/guarantee");
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ sessionIds: ["s_one"] });
});

it("refuses lastChanges over HTTP", async () => {
  const fetch = remote();
  await expect(Barry.lastChanges(["a.ts"])).rejects.toMatchObject({ reason: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});

const wireAtSchedule = { id: "o1", bag: "ops", action: "ops:task", inputs: {}, dueAt: "2026-10-10T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", status: "pending", reason: null, idempotencyKey: null, timeoutS: 600, retryAttempts: 3, failures: 0, recoveries: 0 };
it("forwards retry attempts and the at-schedule bag filter", async () => {
  const fetch = remote({ schedule: wireAtSchedule }, { schedules: [wireAtSchedule] });
  expect(await Barry.scheduleAt({ action: "ops:task", dueAt: wireAtSchedule.dueAt, attempts: 3 })).toMatchObject({ retryAttempts: 3 });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ retry: { attempts: 3 } });
  await Barry.atSchedules({ bag: "ops" });
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("bag")).toBe("ops");
});
it("returns the at-schedule after requesting cancellation", async () => {
  const after = { ...wireAtSchedule, status: "cancelled", reason: "cancelled" };
  const fetch = remote({ cancelled: true, status: "cancelled" }, { schedule: after });
  const handle = Barry.atSchedule("o1");
  expect(handle.id).toBe("o1");
  expect(fetch).not.toHaveBeenCalled();
  expect(await handle.cancel()).toMatchObject(after);
  expect(String(fetch.mock.calls[0][0])).toBe("http://example.test/api/v1/schedules/once/o1/cancel");
  expect(fetch.mock.calls[0][1]?.method).toBe("POST");
  expect(String(fetch.mock.calls[1][0])).toBe("http://example.test/api/v1/schedules/once/o1");
});

const service = { key: "fixture.api", bag: "fixture", name: "api", kind: "service", state: "running", registered: true, enabled: true, system: false, pid: null, port: null, address: null, health: "unknown", restarts: 0, startedAt: null, lastExitCode: null, workingDirectory: "/fixture", loopbackOnly: null, conflict: null, problem: null };
it("reaches services over their transport and refuses session control without HTTP", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async input => Response.json(String(input).endsWith("/services") ? { services: [service] } : { service }));
  Barry.connect({ baseUrl: "http://api.test", services: { baseUrl: "http://mcp.test", fetch } });
  expect(await Barry.services()).toEqual([service]); expect(await Barry.service("fixture.api").get()).toEqual(service);
  for (const op of ["start", "stop", "restart"] as const) await Barry.service("fixture.api")[op]();
  const count = fetch.mock.calls.length;
  for (const op of ["start", "stop", "restart"] as const)
    await expect(Barry.as({ kind: "session", identity: "bux", sessionId: "s1" }).service("fixture.api")[op]()).rejects.toMatchObject({ reason: "forbidden" });
  expect(fetch).toHaveBeenCalledTimes(count);
});
it.each([[403, "forbidden"], [404, "not_found"], [409, "conflict"]])("maps service HTTP %s to %s", async (status, reason) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ title: "refused", detail: "fixture" }, { status: Number(status) }));
  Barry.connect({ baseUrl: "http://api.test", services: { baseUrl: "http://mcp.test", fetch } });
  await expect(Barry.service("fixture.api").restart()).rejects.toMatchObject({ reason });
  if (status === 404) await expect(Barry.service("missing.api").get()).rejects.toMatchObject({ reason: "not_found" });
});
it("maps an unconfigured services transport to unavailable", async () => {
  Barry.connect({ baseUrl: "http://api.test" }); await expect(Barry.services()).rejects.toMatchObject({ reason: "unavailable" });
});
