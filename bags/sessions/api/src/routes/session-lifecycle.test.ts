import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { BarryClient } from "@barry-rocks/sdk/internal/client";
import type { Server } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { AdmissionError } from "../execution-admission.js";
vi.mock("@barry-rocks/sessions-bag/lifecycle", () => ({ endSession: vi.fn() }));

/**
 * A real, existing git repo — the monorepo root — found by SEARCHING for the
 * workspace marker rather than counting directories.
 *
 * Used by the message-route tests that exercise validateRepoPath for real
 * instead of mocking it, so it has to be a directory that genuinely exists. A
 * fixed climb was correct at servers/api/src/routes and one level short after
 * the move to bags/sessions/api/src/routes: it resolved to `bags/`, which is
 * not a git repo, so six tests failed with 400 instead of the status under
 * test — a validation rejection that looked nothing like a path bug.
 */
const REAL_REPO_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no pnpm-workspace.yaml above this test");
    dir = parent;
  }
})();

// Mock DB layer
vi.mock("../db.js", () => ({
  getSessionRecord: vi.fn(),
  updateSessionRecord: vi.fn(),
  updateSessionMetadata: vi.fn(),
  listSessionRecords: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn(),
  buildSessionHistoryContext: vi.fn(),
}));

// ONE factory for the client, not two. There used to be a second
// `vi.mock(client, importOriginal)` further down for the five prompt-delivery
// spies. With both targeting the same specifier the later one WINS COMPLETELY, and
// its importOriginal() spread pulls in the real client -- so the first
// factory's spies were replaced by real implementations and assertions on them
// failed. Merged here; a module may be mocked once.
vi.mock("@barry-rocks/sessions-bag/client", () => ({
  // Prompt delivery. Left unmocked, the route reaches the real client, the
  // spies never see a call, and every assertion on them passes against an
  // implementation that does nothing.
  queuePrompt: vi.fn(),
  getMessageByClientMessageId: vi.fn(),
  recordPromptDelivery: vi.fn(),
  updatePromptDeliveryByClientMessageId: vi.fn(),
  claimFailedPromptRetry: vi.fn(),
  // What the route reports as `delivery`. Answering with no listeners is the
  // honest default for a session driven by some other process: it reads the
  // message on its next Barry tool call.
  getListeners: vi.fn().mockResolvedValue({}),
  Sessions: {
    createInert: vi.fn(),
    updateMetadataNormalized: vi.fn(),
    getName: vi.fn().mockReturnValue("test session"),
  },
  Processes: {
    recordStart: vi.fn(),
    markEnded: vi.fn(),
    getLive: vi.fn().mockResolvedValue(null),
  },
  // The client's transport dispatch imports these at module load, so the mock
  // must define them even though this suite never persists messages.
  Messages: { deleteOlderThan: vi.fn() },
  // Write functions
  createSession: vi.fn(),
  createNamedSession: vi.fn(),
  createInertSession: vi.fn(),
  updateSession: vi.fn(),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  updateSessionMetadata: vi.fn(),
  updateSessionMetadataNormalized: vi.fn(),
  createProviderSession: vi.fn(),
  endProviderSessionByProviderId: vi.fn(),
  markCrashedSessions: vi.fn(),
  archiveAllClosedSessions: vi.fn(),
  appendMessage: vi.fn(),
  // Read functions dispatched by @barry-rocks/sessions-bag/client
  getSession: vi.fn(),
  listSessions: vi.fn(),
  getActiveSessions: vi.fn(),
  getSessionStats: vi.fn(),
  searchSessions: vi.fn(),
  getRecentByDirectory: vi.fn(),
  getMostRecentSession: vi.fn(),
  getUniqueDirectories: vi.fn(),
  listSessionRecords: vi.fn(),
  findSessionByLinearIssue: vi.fn(),
  findSessionByGitHubPR: vi.fn(),
  getProviderSessionsBySession: vi.fn(),
  getSessionMessages: vi.fn(),
  getSessionMessageCount: vi.fn(),
  getMessageDetail: vi.fn(),
  getSessionContext: vi.fn(),
  searchMessages: vi.fn(),
  buildSessionHistoryContext: vi.fn(),
  shouldPersist: vi.fn().mockReturnValue(true),
  // Spread by @barry-rocks/sessions-bag/client's namespace dispatch at module load.
  ProviderSessions: { end: vi.fn() },
}));

// The names here are the module's OWN: the db barrel exported `parseMetadata`
// as `parseSessionMetadata`, so mocking the barrel's spelling against the real
// module defines nothing. `getName` is required too -- the client's namespace
// dispatch reads it at module load.
vi.mock("@barry-rocks/sessions-bag/store/session-helpers", () => ({
  // Pure functions (no DB, always direct)
  formatSessionHistory: vi.fn().mockReturnValue([]),
  parseMetadata: vi.fn((raw: unknown) => raw ?? {}),
  getName: vi.fn().mockReturnValue("test session"),
  cleanSessionName: vi.fn((n: unknown) => n),
  formatSessionName: vi.fn((n: unknown) => n),
  rowToSession: vi.fn((r: unknown) => r),
}));

// The identities bag, at its root. The create path resolves the acting
// identity and turns it into a real `identities` row id; unmocked those reach
// the real identities store, so the create success path could not be exercised
// here. Spread over the original so the rest of the root stays real.
vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return {
    ...actual,
    bounds: { ...actual.bounds, get: vi.fn(), list: vi.fn(async () => []) },
    owner: { ...actual.owner, current: vi.fn() },
    identityRecords: { ...actual.identityRecords, resolve: vi.fn(), rowId: vi.fn() },
    resolve: { ...actual.resolve, selectable: vi.fn(async () => ({ bags: [], bounds: [] })) },
  };
});

// Liveness for POST /:id/message's active-elsewhere branch. It lives in the
// sessions bag; on any other specifier this entry would be a silent no-op and
// the route would run the REAL classifier against this machine's process table.
vi.mock("@barry-rocks/sessions-bag/process-liveness", () => ({
  classify: vi.fn(),
}));

vi.mock("../session-runtime.js", () => ({
  sessionRuntime: {
    broadcastToSession: vi.fn(),
    sendInTurn:vi.fn(),
    assertPersistenceAdmission: vi.fn(),
    flushPersistence: vi.fn(async()=>true),
    pendingPersistence: vi.fn(()=>[]),
    getActiveSession: vi.fn(),
    removeSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    interruptTurn:vi.fn(),
    sendMessage: vi.fn(),
    publishDeliveryUpdate: vi.fn(),
    warmHarness: vi.fn().mockResolvedValue(undefined),
    dropResident: vi.fn(),
    attachRenderer: vi.fn(),
    detachRenderer: vi.fn(),
  },
  buildMcpConfig: vi.fn(),
}));

vi.mock("../turn-execution.js", () => ({ residentSession: vi.fn() }));


// The tools the registered bags declare: the universe GET /:id/tools annotates.
vi.mock("@barry-rocks/sdk/internal/tools", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/tools")>(),

  collectToolDefinitions: vi.fn(async () => []),
}));

vi.mock("../worktree.js", () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  getWorktreePath: vi.fn(),
}));

vi.mock("@barry-rocks/sdk/logging", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/logging")>(),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { sessionLifecycleRouter, parseIdentityIdParam } from "./session-lifecycle.js";
import { endSession } from "@barry-rocks/sessions-bag/lifecycle";
import { identityRecords, owner } from "@barry-rocks/identities-bag";
import { collectToolDefinitions } from "@barry-rocks/sdk/internal/tools";
import { Barry, type Tool } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { createInertSession as dbCreateInertSession } from "@barry-rocks/sessions-bag/client";
import { classify as classifyProcessLiveness } from "@barry-rocks/sessions-bag/process-liveness";
import {
  Sessions,
  getSession,
  queuePrompt,
  getMessageByClientMessageId,
  recordPromptDelivery,
  updatePromptDeliveryByClientMessageId,
  claimFailedPromptRetry,
  getListeners,
} from "@barry-rocks/sessions-bag/client";
import { buildSessionHistoryContext, getSessionMessages, getSessionRecord, updateSessionRecord } from "../db.js";
import { sessionRuntime } from "../session-runtime.js";
import { residentSession } from "../turn-execution.js";
import { ExecutionConflict } from "@barry-rocks/sessions-bag/store/turn-continuations";

const mockGetSessionRecord = vi.mocked(getSessionRecord);
const mockUpdateSessionRecord = vi.mocked(updateSessionRecord);
const mockSdkGetActiveSession = vi.mocked(sessionRuntime.getActiveSession);
const mockSdkRemoveSession = vi.mocked(sessionRuntime.removeSession);
const mockClassifyProcessLiveness = vi.mocked(classifyProcessLiveness);
const mockQueuePrompt = vi.mocked(queuePrompt);
const mockGetMessageByClientMessageId = vi.mocked(getMessageByClientMessageId);
const mockRecordPromptDelivery = vi.mocked(recordPromptDelivery);
const mockUpdatePromptDeliveryByClientMessageId = vi.mocked(updatePromptDeliveryByClientMessageId);
const mockClaimFailedPromptRetry = vi.mocked(claimFailedPromptRetry);
const mockGetListeners = vi.mocked(getListeners);
const mockSdkStartSession = vi.mocked(sessionRuntime.startSession);
const mockSdkSendMessage = vi.mocked(sessionRuntime.sendMessage);
const mockSdkPublishDeliveryUpdate = vi.mocked(sessionRuntime.publishDeliveryUpdate);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/sessions", sessionLifecycleRouter);
  app.use("/api/v1/sessions", sessionLifecycleRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

afterEach(() => Barry.reset());

const CREATED_ROW = { system_prompt: "Assist", summary: null, identity_id: 1, status: "pending", bags: [], bounds: [], bound: null, created_at: "2026-10-03T00:00:00.000Z", started_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  Barry.use(fakeIdentities({ bound: async () => null, tools: async () => [] }));
  mockSdkGetActiveSession.mockReset();
  mockSdkStartSession.mockReset();
  mockSdkSendMessage.mockReset();
  mockGetMessageByClientMessageId.mockResolvedValue(null);
  mockUpdatePromptDeliveryByClientMessageId.mockResolvedValue(null);
  mockClaimFailedPromptRetry.mockResolvedValue(null);
  mockRecordPromptDelivery.mockResolvedValue({
    id: "m-failure",
    sequence: 10,
    state: "uncertain",
    duplicate: false,
  });
});

describe("DELETE /sessions/:id", () => {
  const fakeSession = {
    id: "session-abc",
    prompt: "test",
    status: "running",
    bags: [],
    bounds: [],
    bound: null,
    metadata: { working_directory: "/tmp/test", name: "test" },
    identity_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
  };

  it("returns 404 when session does not exist", async () => {
    mockGetSessionRecord.mockResolvedValue(undefined);
    const res = await fetch(`${baseUrl}/sessions/nonexistent`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("marks session as cancelled", async () => {
    mockGetSessionRecord.mockResolvedValue(fakeSession as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockUpdateSessionRecord.mockResolvedValue(undefined);

    const res = await fetch(`${baseUrl}/sessions/session-abc`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(endSession).toHaveBeenCalledWith({ session_id: "session-abc", reason: "removed" });
    expect(vi.mocked(endSession).mock.invocationCallOrder[0]).toBeLessThan(mockUpdateSessionRecord.mock.invocationCallOrder[0]);

    expect(mockUpdateSessionRecord).toHaveBeenCalledWith("session-abc", expect.objectContaining({
      status: "cancelled",
    }));
  });

  it("calls sessionRuntime.removeSession when session is active", async () => {
    mockGetSessionRecord.mockResolvedValue(fakeSession as never);
    mockSdkGetActiveSession.mockReturnValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 },} as never); // truthy = active
    mockSdkRemoveSession.mockResolvedValue(undefined);
    mockUpdateSessionRecord.mockResolvedValue(undefined);

    const res = await fetch(`${baseUrl}/sessions/session-abc`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(mockSdkRemoveSession).toHaveBeenCalledWith("session-abc", undefined);
    expect(mockUpdateSessionRecord).toHaveBeenCalled();
  });

  it("skips sessionRuntime.removeSession when session is not active", async () => {
    mockGetSessionRecord.mockResolvedValue(fakeSession as never);
    mockSdkGetActiveSession.mockReturnValue(undefined); // not active
    mockUpdateSessionRecord.mockResolvedValue(undefined);

    await fetch(`${baseUrl}/sessions/session-abc`, { method: "DELETE" });

    expect(mockSdkRemoveSession).not.toHaveBeenCalled();
  });
});

describe("discard-worktree closure", () => {
  it("closes the persisted session before setting its cancelled status", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "session-abc", metadata: { worktree_path: "/tmp/review-worktree", base_repo_path: "/tmp/review-base" } } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    const res = await fetch(`${baseUrl}/sessions/session-abc/discard-worktree`, { method: "POST" });
    expect(res.status, JSON.stringify(await res.json())).toBe(200);
    expect(endSession).toHaveBeenCalledWith({ session_id: "session-abc", reason: "discarded" });
    expect(mockUpdateSessionRecord).toHaveBeenCalledWith("session-abc", expect.objectContaining({ status: "cancelled" }));
    expect(vi.mocked(endSession).mock.invocationCallOrder[0]).toBeLessThan(mockUpdateSessionRecord.mock.invocationCallOrder[0]);
  });
});

describe("POST /sessions", () => {
  /**
   * RFC 9110 §10.2.2: a 201 names the created resource in `Location`.
   *
   * Asserted against the BODY's id rather than a literal, because the failure
   * that matters is not a missing header — it is a header pointing somewhere
   * else. A `Location` that 404s is worse than none: a client follows it, gets
   * nothing, and concludes the create silently failed.
   *
   * Relative by design (§10.2.2 resolves a relative reference against the target
   * URI). This service answers on several hostnames — a proxy, a local name,
   * 127.0.0.1 — so an absolute URL built from one request would hand
   * callers whichever hop they happened to reach.
   */
  it("returns 201 with a Location header naming the created session", async () => {
    // The create path resolves an identity before writing, so the success case
    // needs these three stubbed — without them it 400s on "No Barry user is
    // configured", which is a real guard and not the thing under test here.
    vi.mocked(owner.current).mockResolvedValue({ id: 1, settings: {} } as never);
    vi.mocked(identityRecords.resolve).mockResolvedValue({ barry: { id: 1, name: "test" }, source: "db" } as never);
    vi.mocked(identityRecords.rowId).mockResolvedValue(1);
    vi.mocked(Sessions.createInert).mockResolvedValue({ ...CREATED_ROW,
      id: "sess_created_1",
      metadata: {},
      bags: [],
    } as never);

    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "location header test" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    // Ends with the id the body reports — the header must name THAT session, not
    // merely exist. The prefix comes from `req.baseUrl`, so it follows wherever
    // the router is mounted: `/api/v1/sessions` in the real service, `/sessions`
    // in this harness. Asserting the prod prefix here would test the fixture.
    expect(res.headers.get("location")).toBe(`/sessions/${body.id}`);
    expect(res.headers.get("location")).toContain(body.id);
    expect(vi.mocked(Sessions.createInert)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ review_policy: { mode: "review_required" } }) }),
    );
  });

  it.each(["idle", "started", "start_failed"] as const)("exposes the actual %s creation response through the public SDK", async outcome => {
    vi.mocked(owner.current).mockResolvedValue({ id: 1, settings: {} } as never);
    vi.mocked(identityRecords.resolve).mockResolvedValue({ barry: { id: 1, name: "test" }, source: "db" } as never);
    vi.mocked(identityRecords.rowId).mockResolvedValue(1);
    const row = {
      id: "created-via-client", system_prompt: "Assist", summary: null, identity_id: 1,
      status: "pending", bags: [], bounds: [], bound: null,
      metadata: { working_directory: REAL_REPO_ROOT },
      created_at: "2026-10-03T00:00:00.000Z", started_at: null,
    };
    vi.mocked(Sessions.createInert).mockResolvedValue(row as never);
    mockGetSessionRecord.mockResolvedValue(row as never);
    mockSdkStartSession.mockResolvedValue(undefined as never);
    if (outcome === "start_failed") mockSdkStartSession.mockRejectedValue(new Error("Selected provider unavailable"));
    const client = new BarryClient({ baseUrl });
    const result = await client.sessions.create({ systemPrompt: "Assist", ...(outcome === "idle" ? {} : { prompt: "Begin" }) });
    expect(result.id).toBe(row.id);
    if (outcome === "idle") {
      expect("started" in result).toBe(false);
      expect(mockSdkStartSession).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject(outcome === "started" ? { started: true } : { started: false, startError: "Selected provider unavailable" });
      expect(mockSdkStartSession).toHaveBeenCalledTimes(1);
    }
  });

  it("persists the explicitly selected review rules", async () => {
    vi.mocked(owner.current).mockResolvedValue({ id: 1, settings: {} } as never);
    vi.mocked(identityRecords.resolve).mockResolvedValue({ barry: { id: 1, name: "test" }, source: "db" } as never);
    vi.mocked(identityRecords.rowId).mockResolvedValue(1);
    vi.mocked(Sessions.createInert).mockResolvedValue({ ...CREATED_ROW, id: "sess_rules_1", metadata: {}, bags: [] } as never);
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "rules test", reviewRules: { mode: "automatic" } }),
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(Sessions.createInert)).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ review_policy: { mode: "automatic" } }) }),
    );
  });

  it("rejects request without prompt", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("systemPrompt");
  });

  it("rejects invalid repoPath", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "test", repoPath: "/nonexistent/path" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("does not exist");
  });

  it("rejects an unknown bound instead of storing it", async () => {
    // Bound resolution treats a missing bound as "no restrictions", so a bad
    // name must fail loudly — otherwise the session looks scoped and is not.
    Barry.use(fakeIdentities({ bound: async () => { throw new Error("unknown selected bound unknown-bound"); } }));
    vi.mocked(owner.current).mockResolvedValue({ id: 1, settings: {} } as never);
    vi.mocked(identityRecords.resolve).mockResolvedValue({ barry: { id: 1, name: "test" }, source: "db" } as never);
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "test", bounds: ["unknown-bound"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.title).toBe("Unknown bound");
    expect(vi.mocked(dbCreateInertSession)).not.toHaveBeenCalled();
  });

  // Asserted the opposite (400, "Not a git repository") until the `.git`
  // requirement came out of validateRepoPath. A session runs in a WORKING
  // DIRECTORY; only the parameter's name says "repo". `barry start` never
  // enforced this, so the HTTP path refused directories the CLI accepts —
  // /tmp among them, where 13 live sessions ran to completion.
  //
  // Asserts the STORED directory, not just the status code: a 201 that dropped
  // working_directory would start the agent somewhere else entirely, which is
  // the failure a user would actually hit.
  it("accepts a working directory that is not a git repo", async () => {
    vi.mocked(owner.current).mockResolvedValue({ id: 1, settings: {} } as never);
    vi.mocked(identityRecords.resolve).mockResolvedValue({ barry: { id: 1, name: "test" }, source: "db" } as never);
    vi.mocked(identityRecords.rowId).mockResolvedValue(1);
    vi.mocked(Sessions.createInert).mockResolvedValue({ ...CREATED_ROW,
      id: "sess_tmp_1",
      metadata: {},
      bags: [],
    } as never);

    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "test", repoPath: "/tmp" }),
    });

    expect(res.status).toBe(201);
    expect(vi.mocked(Sessions.createInert)).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ working_directory: "/tmp" }),
      }),
    );
  });
});

describe("PATCH /sessions/:id", () => {
  const fakeSession = {
    id: "session-abc",
    prompt: "test",
    status: "draft",
    bags: [],
    bounds: [],
    bound: null,
    metadata: { working_directory: "/tmp/test", name: "test" },
    identity_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
  };

  it("returns 404 when session does not exist", async () => {
    mockGetSessionRecord.mockResolvedValue(undefined);
    const res = await fetch(`${baseUrl}/sessions/nonexistent`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "updated" }),
    });
    expect(res.status).toBe(404);
  });

  it.each([{ prompt: "Start a turn" }, { useWorktree: true }])("rejects unapplied update fields %j without changing the session", async input => {
    mockGetSessionRecord.mockResolvedValue(fakeSession as never);
    const res = await fetch(`${baseUrl}/sessions/session-abc`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    expect(res.status).toBe(400);
    expect(updateSessionRecord).not.toHaveBeenCalled();
    expect(Sessions.updateMetadataNormalized).not.toHaveBeenCalled();
  });

  it("rejects invalid repoPath on patch", async () => {
    mockGetSessionRecord.mockResolvedValue(fakeSession as never);
    const res = await fetch(`${baseUrl}/sessions/session-abc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: "/nonexistent/bad/path" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("does not exist");
  });
});

describe("POST /sessions/:id/messages/persist — tool results", () => {
  it("rejects a tool_result with no result", async () => {
    const res = await fetch(`${baseUrl}/sessions/s1/messages/persist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tool_result", toolUseId: "toolu_x" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("result is required");
  });

  it("404s a write for a session that was never created", async () => {
    // Regression: a tracker hook whose session-start never landed POSTed 18
    // times for a session with no row. Every attempt reached the insert and
    // failed the messages -> sessions foreign key — unpersistable either way, but the
    // error named a constraint instead of the actual problem, and nothing
    // told the hook to stop retrying.
    mockGetSessionRecord.mockResolvedValueOnce(null as never);
    const res = await fetch(`${baseUrl}/sessions/never-started/messages/persist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message", role: "user", content: "orphan" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toContain("was it ever started");
  });

  it("still requires name for a tool_call", async () => {
    const res = await fetch(`${baseUrl}/sessions/s1/messages/persist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "tool_call", input: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name is required");
  });
});

describe("POST /sessions/:id/message", () => {
  it("reports a warm admission without harness startup stages before turn execution", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "warm", metadata: {}, bags: [] } as never);
    mockSdkGetActiveSession.mockReturnValue({ id: "warm", status: "waiting", timings: { harness_create_ms: 10, harness_ready_ms: 100 }, session:{isWarm:()=>true}, warm: { preparedAt: Date.now() } } as never);
    mockSdkSendMessage.mockResolvedValue(undefined);
    const response = await fetch(`${baseUrl}/sessions/warm/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
    expect(response.status).toBe(202);
    expect(response.headers.get("X-Barry-Timing")).toMatch(/ingress=.*admit=.*warm=1/);
  });
  it("retries a failed admission with the same row and marks it accepted", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "retry", metadata: { working_directory: REAL_REPO_ROOT }, bags: [] } as never);
    mockSdkGetActiveSession.mockReturnValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "retry", status: "waiting" } as never);
    mockGetMessageByClientMessageId.mockResolvedValue({ id: "m-retry", sequence: 4, state: "failed", content: "hello" });
    mockClaimFailedPromptRetry.mockResolvedValue({ id: "m-retry", sequence: 4, state: "uncertain", content: "hello" });
    mockUpdatePromptDeliveryByClientMessageId.mockResolvedValue({ id: "m-retry", sequence: 4, state: "accepted", content: "hello" });

    const res = await fetch(baseUrl + "/sessions/retry/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId: "cid-retry" }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).deliveryState).toBe("accepted");
    expect(mockClaimFailedPromptRetry).toHaveBeenCalledWith("retry", "cid-retry", "hello");
    expect(mockSdkSendMessage).toHaveBeenCalledWith("retry", "hello", { ingressAt: expect.any(Number), clientMessageId: "cid-retry", reuseClientMessageRow: true, userMessageSequence:4 }, undefined);
    expect(mockUpdatePromptDeliveryByClientMessageId).toHaveBeenCalledWith("retry", "cid-retry", "accepted");
    expect(mockRecordPromptDelivery).not.toHaveBeenCalled();
  });

  it("does not resend an uncertain delivery", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "uncertain", metadata: {}, bags: [] } as never);
    mockGetMessageByClientMessageId.mockResolvedValue({ id: "m-uncertain", sequence: 2, state: "uncertain", content: "hello" });
    const res = await fetch(baseUrl + "/sessions/uncertain/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId: "cid-uncertain" }),
    });
    expect((await res.json()).deliveryState).toBe("uncertain");
    expect(mockSdkSendMessage).not.toHaveBeenCalled();
    expect(mockSdkStartSession).not.toHaveBeenCalled();
  });

  it("moves a failed retry to the external prompt queue", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "external", status: "running", metadata: { pid: 99 }, bags: [] } as never);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockGetMessageByClientMessageId.mockResolvedValue({ id: "m-external", sequence: 2, state: "failed", content: "hello" });
    mockClaimFailedPromptRetry.mockResolvedValue({ id: "m-external", sequence: 2, state: "uncertain", content: "hello" });
    mockUpdatePromptDeliveryByClientMessageId.mockResolvedValue({ id: "m-external", sequence: 2, state: "queued", content: "hello" });
    const res = await fetch(baseUrl + "/sessions/external/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId: "cid-external" }),
    });
    expect((await res.json()).deliveryState).toBe("queued");
    expect(mockUpdatePromptDeliveryByClientMessageId).toHaveBeenCalledWith(
      "external", "cid-external", "queued", { status: "pending", source: "web_prompt" },
    );
    expect(mockQueuePrompt).not.toHaveBeenCalled();
  });

  it("reports capacity pressure as retryable when every resident session is busy", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "busy", metadata: { working_directory: REAL_REPO_ROOT }, bags: [],
    } as never);
    mockClassifyProcessLiveness.mockReturnValue({ state: "unknown", reason: "no-pid" });
    mockSdkStartSession.mockRejectedValueOnce(new AdmissionError("resident session budget exhausted", "resident_budget"));

    const res = await fetch(baseUrl + "/sessions/busy/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect((await res.json()).error).toContain("budget exhausted");
  });

  it("acknowledges deterministic admission failure with delivery-failed when clientMessageId is provided", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "fail1",
      metadata: { working_directory: REAL_REPO_ROOT },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "unknown", reason: "no-pid" });
    mockSdkStartSession.mockRejectedValueOnce(new AdmissionError("resident session budget exhausted", "resident_budget"));
    mockRecordPromptDelivery.mockResolvedValueOnce({
      id: "m-failed",
      sequence: 7,
      state: "failed",
      duplicate: false,
    });

    const res = await fetch(baseUrl + "/sessions/fail1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId: "cid-failed" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = await res.json();
    expect(body.status).toBe("delivery-failed");
    expect(body.deliveryState).toBe("failed");
    expect(body.messageId).toBe("m-failure");
    expect(mockRecordPromptDelivery).toHaveBeenCalledWith(
      "fail1",
      "hello",
      expect.objectContaining({ clientMessageId: "cid-failed", delivery: "uncertain" }),
    );
    expect(mockSdkPublishDeliveryUpdate).toHaveBeenCalledWith(
      "fail1",
      expect.objectContaining({
        messageId: "m-failure",
        clientMessageId: "cid-failed",
        deliveryState: "failed",
      }),
    );
  });

  it("acknowledges uncertain delivery and updates existing idempotency row state", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "uncertain1",
      metadata: { working_directory: "/tmp/repo" },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "uncertain1", status: "streaming" } as never);
    mockSdkSendMessage.mockRejectedValueOnce(new Error("upstream timeout"));
    mockGetMessageByClientMessageId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "m-existing", sequence: 3, state: "queued" });
    mockUpdatePromptDeliveryByClientMessageId.mockResolvedValueOnce({
      id: "m-existing",
      sequence: 3,
      state: "uncertain",
    });

    const res = await fetch(baseUrl + "/sessions/uncertain1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId: "cid-uncertain" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("delivery-uncertain");
    expect(body.deliveryState).toBe("uncertain");
    expect(body.messageId).toBe("m-existing");
    expect(mockUpdatePromptDeliveryByClientMessageId).toHaveBeenCalledWith(
      "uncertain1",
      "cid-uncertain",
      "uncertain",
      expect.objectContaining({ error: "upstream timeout" }),
    );
    expect(mockSdkPublishDeliveryUpdate).toHaveBeenCalledWith(
      "uncertain1",
      expect.objectContaining({
        messageId: "m-existing",
        clientMessageId: "cid-uncertain",
        deliveryState: "uncertain",
        deliveryError: "upstream timeout",
      }),
    );
    expect(mockRecordPromptDelivery).not.toHaveBeenCalled();
  });

  it("queues the message instead of starting a session when the process is genuinely alive elsewhere", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s1",
      status: "running",
      metadata: { working_directory: "/tmp/repo", pid: 4242, pid_started_at: 1700000000 },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockQueuePrompt.mockResolvedValue({ id: "m1", sequence: 1, state: "queued", duplicate: false });

    const res = await fetch(baseUrl + "/sessions/s1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello from the phone" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active-elsewhere");
    expect(body.deliveryState).toBe("queued");
    expect(body.messageId).toBe("m1");
    expect(mockQueuePrompt).toHaveBeenCalledWith("s1", "hello from the phone", { clientMessageId: undefined });
    expect(mockSdkStartSession).not.toHaveBeenCalled();
    // No registered surface, so the honest answer is the tool-call floor.
    expect(body.delivery).toBe("tool-call");
  });

  it("reports `wake` when the session elsewhere has a live listener", async () => {
    // Same queue, different promise: this route used to tell every caller
    // "queued for its next tool call" regardless of what could reach the
    // session (.1 invariant 4).
    mockGetSessionRecord.mockResolvedValue({
      id: "s1",
      status: "running",
      metadata: { working_directory: "/tmp/repo", pid: 4242, pid_started_at: 1700000000 },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockQueuePrompt.mockResolvedValue({ id: "m1", sequence: 1, state: "queued", duplicate: false });
    mockGetListeners.mockResolvedValue({ s1: { guarantee: "wake", listeners: [] } });

    const res = await fetch(baseUrl + "/sessions/s1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "wake up" }),
    });

    expect((await res.json()).delivery).toBe("wake");
  });

  it("starts the first prompt of a pending action draft even when the API pid is alive", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "draft",
      status: "pending",
      metadata: { working_directory: REAL_REPO_ROOT, pid: process.pid, pid_started_at: 1700000000 },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockSdkStartSession.mockResolvedValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "draft", status: "running" } as never);

    const res = await fetch(baseUrl + "/sessions/draft/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "run the action" }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).deliveryState).toBe("accepted");
    expect(mockSdkStartSession).toHaveBeenCalledOnce();
    expect(mockQueuePrompt).not.toHaveBeenCalled();
  });

  it("returns the existing admission result for a repeated clientMessageId", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s1",
      metadata: { working_directory: "/tmp/repo", pid: 4242, pid_started_at: 1700000000 },
      bags: [],
    } as never);
    mockGetMessageByClientMessageId.mockResolvedValue({ id: "m-existing", sequence: 4, state: "accepted" });

    const res = await fetch(baseUrl + "/sessions/s1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello again", clientMessageId: "cmsg-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("idempotent-retry");
    expect(body.deliveryState).toBe("accepted");
    expect(body.messageId).toBe("m-existing");
    expect(mockQueuePrompt).not.toHaveBeenCalled();
    expect(mockSdkStartSession).not.toHaveBeenCalled();
    expect(mockSdkSendMessage).not.toHaveBeenCalled();
  });

  it("starts the first prompt of a pending action draft even when the API pid is alive", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "draft",
      status: "pending",
      metadata: { working_directory: REAL_REPO_ROOT, pid: process.pid, pid_started_at: 1700000000 },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockSdkStartSession.mockResolvedValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "draft", status: "running" } as never);

    const res = await fetch(baseUrl + "/sessions/draft/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "run the action" }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("running");
    expect(res.headers.get("X-Barry-Timing")).toMatch(/ingress=.*admit=.*warm=0/);
    expect(mockSdkStartSession).toHaveBeenCalledOnce();
    expect(mockQueuePrompt).not.toHaveBeenCalled();
  });

  it("starts a fresh session when the recorded process is dead", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s2",
      // A real, existing repo path: this exercises validateRepoPath for real
      // rather than mocking it, since the point of these two tests is that
      // the dead/unknown branches still reach startSession unchanged.
      metadata: { working_directory: REAL_REPO_ROOT, pid: 4242, pid_started_at: 1700000000 },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "dead", reason: "no-process" });
    mockSdkStartSession.mockResolvedValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "s2", status: "starting" } as never);

    const res = await fetch(baseUrl + "/sessions/s2/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(202);
    expect(mockQueuePrompt).not.toHaveBeenCalled();
    expect(mockSdkStartSession).toHaveBeenCalled();
  });

  it("starts a fresh session when liveness is unprovable, never guessing alive", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s3",
      metadata: { working_directory: REAL_REPO_ROOT },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "unknown", reason: "no-pid" });
    mockSdkStartSession.mockResolvedValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "s3", status: "starting" } as never);

    const res = await fetch(baseUrl + "/sessions/s3/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(202);
    expect(mockQueuePrompt).not.toHaveBeenCalled();
    expect(mockSdkStartSession).toHaveBeenCalled();
  });

  it("sends directly, bypassing the liveness check, when the session is already active in this process", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s4",
      metadata: { working_directory: "/tmp/repo" },
      bags: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue({ timings: { prepare_total_ms: 12.5, warm_hit: 0 }, id: "s4", status: "streaming" } as never);

    const res = await fetch(baseUrl + "/sessions/s4/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(202);
    expect(mockSdkSendMessage).toHaveBeenCalledWith("s4", "hello", { ingressAt: expect.any(Number), clientMessageId: undefined, reuseClientMessageRow: false }, undefined);
    expect(mockClassifyProcessLiveness).not.toHaveBeenCalled();
    expect(mockQueuePrompt).not.toHaveBeenCalled();
  });

  it("returns 410 Gone when BARRY_DISABLE_APP_PROTOCOL_V1 is enabled", async () => {
    const originalEnv = process.env.BARRY_DISABLE_APP_PROTOCOL_V1;
    try {
      process.env.BARRY_DISABLE_APP_PROTOCOL_V1 = "true";
      const res = await fetch(baseUrl + "/sessions/s4/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toContain("App Protocol v1 message endpoint is disabled");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BARRY_DISABLE_APP_PROTOCOL_V1;
      } else {
        process.env.BARRY_DISABLE_APP_PROTOCOL_V1 = originalEnv;
      }
    }
  });
});

describe("POST /sessions/:id/attach and /detach", () => {
  const attach = (id: string, body: unknown) => fetch(`${baseUrl}/sessions/${id}/attach`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("holds the session in this process, then hands back what the TUI needs", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "tui", metadata: {}, bags: [] } as never);
    vi.mocked(sessionRuntime.attachRenderer).mockResolvedValue({ attachmentId: "a-1", address: "/tmp/e.sock", harnessSessionId: "thread-1" });
    const res = await attach("tui", { launcherPid: 4242 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attachmentId: "a-1", address: "/tmp/e.sock", harnessSessionId: "thread-1" });
    expect(vi.mocked(residentSession)).toHaveBeenCalledWith("tui", undefined);
    expect(vi.mocked(sessionRuntime.attachRenderer)).toHaveBeenCalledWith("tui", 4242, undefined);
  });

  it("refuses a session driven by another process, a missing one, and a body without the launcher", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "tui", metadata: {}, bags: [] } as never);
    vi.mocked(residentSession).mockRejectedValueOnce(new ExecutionConflict("Another session process is live"));
    expect((await attach("tui", { launcherPid: 4242 })).status).toBe(409);
    expect((await attach("tui", {})).status).toBe(400);
    mockGetSessionRecord.mockResolvedValue(undefined);
    expect((await attach("gone", { launcherPid: 4242 })).status).toBe(404);
    expect(vi.mocked(sessionRuntime.attachRenderer)).not.toHaveBeenCalled();
  });

  it("detaches, and says so when the attachment was already gone", async () => {
    vi.mocked(sessionRuntime.detachRenderer).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const detach = () => fetch(`${baseUrl}/sessions/tui/detach`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attachmentId: "a-1" }),
    });
    expect(await (await detach()).json()).toMatchObject({ message: "Detached" });
    expect(await (await detach()).json()).toMatchObject({ message: "Already detached" });
  });
});

describe("GET /sessions/:id/tools", () => {
  const row = { id: "sess-tools", identity_id: 4, bags: ["git"], bounds: [], bound: null, metadata: { selected_tools: ["fetch"] } };

  beforeEach(() => {
    mockGetSessionRecord.mockResolvedValue(row as never);
    vi.mocked(getSession).mockResolvedValue(row as never);
    vi.mocked(collectToolDefinitions).mockResolvedValue([
      { namespace: "git", toolName: "status", access: "read" },
      { namespace: "git", toolName: "commit", access: "write" },
      { namespace: "web", toolName: "fetch", access: "read" },
    ]);
  });

  it("marks what the session's bags and bound reach, and what enabled each", async () => {
    const tools = vi.fn(async (): Promise<Tool[]> => [
      { name: "status", namespace: "git", bag: "git", access: "read" },
    ]);
    Barry.use(fakeIdentities({ bound: async () => null, tools }));

    const body = await (await fetch(`${baseUrl}/sessions/sess-tools/tools/resolved`)).json();

    expect(tools).toHaveBeenCalledWith(4, expect.objectContaining({ bags: ["git"] }), { kind: "owner" });
    expect(body.namespaces).toEqual([
      { name: "git", enabled: true, grantedBy: ["git"], toolCount: 2 },
      { name: "web", enabled: false, grantedBy: [], toolCount: 1 },
    ]);
    expect(body.tools).toEqual([
      { toolName: "commit", namespace: "git", access: "write", enabled: false, grantedBy: null },
      { toolName: "fetch", namespace: "web", access: "read", enabled: true, grantedBy: "(direct tool)" },
      { toolName: "status", namespace: "git", access: "read", enabled: true, grantedBy: "git" },
    ]);
    expect(body.selectedTools).toEqual(["fetch"]);
  });

  it("previews bags in place of the session's own", async () => {
    const tools = vi.fn(async (): Promise<Tool[]> => []);
    Barry.use(fakeIdentities({ bound: async () => null, tools }));

    const res = await fetch(`${baseUrl}/sessions/sess-tools/tools/preview?bags=web`);

    expect(res.status).toBe(200);
    expect(tools).toHaveBeenCalledWith(4, expect.objectContaining({ bags: ["web"] }), { kind: "owner" });
    expect((await res.json()).bags.active).toEqual(["web"]);
  });
});


describe("POST /sessions/:id/prepare", () => {
  it("returns 202 and timing metadata while warming the exact session", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "prepared", metadata: { working_directory: REAL_REPO_ROOT }, bags: [] } as never);
    const active = { id: "prepared", timings: { prepare_total_ms: 12, warm_hit: 0 }, session:{isWarm:()=>true}, warm: { preparedAt: Date.now() }, status: "waiting" };
    mockSdkGetActiveSession.mockReturnValue(active as never);
    vi.mocked(residentSession).mockResolvedValue(active as never);
    const response = await fetch(`${baseUrl}/sessions/prepared/prepare`, { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("X-Barry-Timing")).toContain("warm=1");
    expect(sessionRuntime.warmHarness).toHaveBeenCalledWith("prepared");
  });
  it("reports a live external driver as a conflict without warming", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "external" } as never);
    vi.mocked(residentSession).mockRejectedValueOnce(new ExecutionConflict("Another process is live"));
    const response = await fetch(`${baseUrl}/sessions/external/prepare`, { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(409);
    expect(sessionRuntime.warmHarness).not.toHaveBeenCalled();
  });
  it("refuses a missing row without preparing anything", async () => {
    mockGetSessionRecord.mockResolvedValue(undefined);
    const response = await fetch(`${baseUrl}/sessions/missing/prepare`, { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(404);
    expect(sessionRuntime.warmHarness).not.toHaveBeenCalled();
  });
});

it("responds before warm completes and reports ingress warm=0", async () => {
  mockGetSessionRecord.mockResolvedValue({ id: "race-warm", metadata: { working_directory: REAL_REPO_ROOT }, bags: [] } as never);
  const active = { id: "race-warm", timings: { warm_hit: 0, harness_create_ms: 3 }, warm: null as { preparedAt: number } | null, status: "waiting", warming: Promise.resolve() };
  let finish!: () => void;
  active.warming = new Promise<void>(resolve => { finish = resolve; }).then(() => { active.warm = { preparedAt: Date.now() }; });
  mockSdkSendMessage.mockImplementationOnce(async () => { setTimeout(finish, 30); });
  mockSdkGetActiveSession.mockReturnValue(active as never);
  const response = await fetch(`${baseUrl}/sessions/race-warm/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
  expect(response.status).toBe(202);
  expect(active.warm).toBeNull();
  expect(response.headers.get("X-Barry-Timing")).toContain("warm=0");
  expect(response.headers.get("X-Barry-Timing")).not.toContain("harness_create");
});

it("serves committed plus queued transcript rows when recording misses the read deadline",async()=>{
 mockGetSessionRecord.mockResolvedValue({id:"lag",metadata:{}} as never);
 vi.mocked(sessionRuntime.flushPersistence).mockResolvedValueOnce(false);
 vi.mocked(sessionRuntime.pendingPersistence).mockReturnValueOnce([{type:"text",sessionId:"lag",sequence:2,role:"assistant",content:"queued"}]);
 vi.mocked(getSessionMessages).mockResolvedValueOnce({messages:[{type:"text",sessionId:"lag",createdAt:new Date().toISOString(),sequence:1,role:"user",content:"stored"}],hasMore:false});
 const response=await fetch(`${baseUrl}/sessions/lag/messages`);expect(response.status).toBe(200);
 expect(response.headers.get("X-Barry-Durability")).toBe("pending");
 const body=await response.json();expect(body.durable).toBe(false);expect(body.messages.map((m:{sequence:number})=>m.sequence)).toEqual([1,2]);
});
it("refuses a new turn with retryable 503 before any side effects when recording is full",async()=>{
 const {PersistenceBacklogError}=await import("../runtime/persist-queue.js");
 vi.mocked(sessionRuntime.assertPersistenceAdmission).mockImplementationOnce(()=>{throw new PersistenceBacklogError("recording delayed");});
 const response=await fetch(`${baseUrl}/sessions/lag/message`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:"later"})});
 expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:"persistence_lagging",retryable:true});expect(mockSdkSendMessage).not.toHaveBeenCalled();
});

it("snapshots cold history before pre-recording the prompt and forwards its sequence",async()=>{
 mockGetSessionRecord.mockResolvedValue({id:"cold-echo",status:"pending",metadata:{working_directory:REAL_REPO_ROOT},bags:[]} as never);
 vi.mocked(buildSessionHistoryContext).mockResolvedValueOnce("prior history");
 mockSdkStartSession.mockResolvedValueOnce({id:"cold-echo",status:"starting",timings:{}} as never);
 mockUpdatePromptDeliveryByClientMessageId.mockResolvedValueOnce({id:"m-failure",sequence:10,state:"accepted"});
 const response=await fetch(`${baseUrl}/sessions/cold-echo/message`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:"new prompt",clientMessageId:"echo"})});
 expect(response.status).toBe(202);
 expect(mockSdkStartSession).toHaveBeenCalledWith(expect.objectContaining({userMessageSequence:10,initialHistoryContext:"prior history",reuseClientMessageRow:true}),undefined);
 expect(vi.mocked(buildSessionHistoryContext).mock.invocationCallOrder[0]).toBeLessThan(mockRecordPromptDelivery.mock.invocationCallOrder[0]);
});
it("does not call an old prepare stamp a warm process at ingress",async()=>{
 mockGetSessionRecord.mockResolvedValue({id:"released",metadata:{},bags:[]} as never);
 mockSdkGetActiveSession.mockReturnValue({id:"released",status:"waiting",timings:{},warm:{preparedAt:Date.now()},session:{isWarm:()=>false}} as never);
 mockSdkSendMessage.mockResolvedValue(undefined);
 const response=await fetch(`${baseUrl}/sessions/released/message`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:"hello"})});
 expect(response.status).toBe(202);expect(response.headers.get("X-Barry-Timing")).toContain("warm=0");
});

it.each(["interrupted","forced","none"] as const)("reports the %s interrupt outcome",async(status)=>{
 mockGetSessionRecord.mockResolvedValue({id:"outcome",metadata:{},bags:[]} as never);
 mockSdkGetActiveSession.mockReturnValue((status==="forced"?{turnControl:{force:{signal:{aborted:true}}}}:undefined) as never);
 vi.mocked(sessionRuntime.interruptTurn).mockResolvedValue(status!=="none");
 const response=await fetch(`${baseUrl}/sessions/outcome/interrupt`,{method:"POST"});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status,message:expect.any(String)});
});
it("returns a recording warning after removing a resident with pending rows",async()=>{
 mockGetSessionRecord.mockResolvedValue({id:"lagging-remove",metadata:{},bags:[]} as never);
 mockSdkGetActiveSession.mockReturnValue({id:"lagging-remove"} as never);
 vi.mocked(sessionRuntime.pendingPersistence).mockReturnValueOnce([{type:"text",content:"queued"}]);
 const response=await fetch(`${baseUrl}/sessions/lagging-remove`,{method:"DELETE"});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({recordingPending:true});
});

it("refuses backlog admission without adding its error to the recording queue",async()=>{
 const {PersistenceBacklogError}=await import("../runtime/persist-queue.js");
 mockGetSessionRecord.mockResolvedValue({id:"backlog",metadata:{},bags:[]} as never);
 const active={id:"backlog",status:"waiting",timings:{}};mockSdkGetActiveSession.mockReturnValue(active as never);
 vi.mocked(sessionRuntime.assertPersistenceAdmission).mockImplementationOnce(()=>{throw new PersistenceBacklogError("Recording delayed");});
 const response=await fetch(`${baseUrl}/sessions/backlog/message`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:"hello"})});
 expect(response.status).toBe(503);expect(sessionRuntime.sendInTurn).toHaveBeenCalledWith(active,expect.objectContaining({type:"error",metadata:{code:"persistence_lagging",retryable:true}}));expect(sessionRuntime.broadcastToSession).not.toHaveBeenCalled();
});

describe("parseIdentityIdParam", () => {
  it("treats an absent param as no barry", () => {
    expect(parseIdentityIdParam(undefined)).toEqual({ ok: true, identityId: null });
  });

  it("treats an empty or blank param as no barry", () => {
    expect(parseIdentityIdParam("")).toEqual({ ok: true, identityId: null });
    expect(parseIdentityIdParam("   ")).toEqual({ ok: true, identityId: null });
  });

  it("accepts an integer", () => {
    expect(parseIdentityIdParam("3")).toEqual({ ok: true, identityId: 3 });
  });

  it("rejects a present but unparseable value", () => {
    expect(parseIdentityIdParam("abc")).toEqual({ ok: false });
    expect(parseIdentityIdParam("3.5")).toEqual({ ok: false });
  });

  it("rejects a repeated param, which arrives as an array", () => {
    expect(parseIdentityIdParam(["3", "4"])).toEqual({ ok: false });
  });
});

