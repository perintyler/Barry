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
    bounds: { ...actual.bounds, get: vi.fn(), stored: vi.fn(async () => []) },
    owner: { ...actual.owner, current: vi.fn() },
    identityRecords: { ...actual.identityRecords, resolve: vi.fn(), rowId: vi.fn() },
    traits: { ...actual.traits, list: vi.fn(), selectable: vi.fn() },
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
    getActiveSession: vi.fn(),
    removeSession: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    sendMessage: vi.fn(),
    publishDeliveryUpdate: vi.fn(),
    attachRenderer: vi.fn(),
    detachRenderer: vi.fn(),
  },
  buildMcpConfig: vi.fn(),
}));

vi.mock("../turn-execution.js", () => ({ residentSession: vi.fn() }));


// The tools the registered bags declare: the universe GET /:id/tools annotates.
vi.mock("@barry-rocks/sdk/internal/tools", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/tools")>(),

  collectToolMeta: vi.fn(async () => []),
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

import { sessionLifecycleRouter } from "./session-lifecycle.js";
import { endSession } from "@barry-rocks/sessions-bag/lifecycle";
import { bounds, identityRecords, owner, traits, type TraitInfo } from "@barry-rocks/identities-bag";
import { collectToolMeta } from "@barry-rocks/sdk/internal/tools";
import { Barry, type Grants } from "@barry-rocks/sdk";
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
import { getSessionRecord, updateSessionRecord } from "../db.js";
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

// What every session here is granted, as the identities subject answers it:
// nothing, so a start's MCP servers are the always-on ones.
const CREATED_ROW = { system_prompt: "Assist", summary: null, identity_id: 1, status: "pending", bound: null, created_at: "2026-10-03T00:00:00.000Z", started_at: null };
const NO_GRANTS: Grants = { traits: [], bound: null, namespaces: [], tools: [], skills: [], instructions: [] };

beforeEach(() => {
  vi.clearAllMocks();
  Barry.use(fakeIdentities({ grants: async () => NO_GRANTS }));
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
    traits: [],
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
    mockSdkGetActiveSession.mockReturnValue({} as never); // truthy = active
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
      traits: [],
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
      status: "pending", traits: [], bound: null,
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

  it("persists the explicitly selected review policy", async () => {
    vi.mocked(owner.current).mockResolvedValue({ id: 1, settings: {} } as never);
    vi.mocked(identityRecords.resolve).mockResolvedValue({ barry: { id: 1, name: "test" }, source: "db" } as never);
    vi.mocked(identityRecords.rowId).mockResolvedValue(1);
    vi.mocked(Sessions.createInert).mockResolvedValue({ ...CREATED_ROW, id: "sess_policy_1", metadata: {}, traits: [] } as never);
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemPrompt: "policy test", reviewPolicy: { mode: "automatic" } }),
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
    Barry.use(fakeIdentities({ grants: async () => { throw new Error("unknown selected bound unknown-bound"); } }));
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
      traits: [],
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
    traits: [],
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
  it("retries a failed admission with the same row and marks it accepted", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "retry", metadata: { working_directory: REAL_REPO_ROOT }, traits: [] } as never);
    mockSdkGetActiveSession.mockReturnValue({ id: "retry", status: "waiting" } as never);
    mockGetMessageByClientMessageId.mockResolvedValue({ id: "m-retry", sequence: 4, state: "failed", content: "hello" });
    mockClaimFailedPromptRetry.mockResolvedValue({ id: "m-retry", sequence: 4, state: "uncertain", content: "hello" });
    mockUpdatePromptDeliveryByClientMessageId.mockResolvedValue({ id: "m-retry", sequence: 4, state: "accepted", content: "hello" });

    const res = await fetch(baseUrl + "/sessions/retry/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", clientMessageId: "cid-retry" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).deliveryState).toBe("accepted");
    expect(mockClaimFailedPromptRetry).toHaveBeenCalledWith("retry", "cid-retry", "hello");
    expect(mockSdkSendMessage).toHaveBeenCalledWith("retry", "hello", { clientMessageId: "cid-retry", reuseClientMessageRow: true }, undefined);
    expect(mockUpdatePromptDeliveryByClientMessageId).toHaveBeenCalledWith("retry", "cid-retry", "accepted");
    expect(mockRecordPromptDelivery).not.toHaveBeenCalled();
  });

  it("does not resend an uncertain delivery", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "uncertain", metadata: {}, traits: [] } as never);
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
    mockGetSessionRecord.mockResolvedValue({ id: "external", status: "running", metadata: { pid: 99 }, traits: [] } as never);
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
      id: "busy", metadata: { working_directory: REAL_REPO_ROOT }, traits: [],
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
      traits: [],
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
      traits: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue({ id: "uncertain1", status: "streaming" } as never);
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
    expect(mockRecordPromptDelivery).toHaveBeenCalledWith("uncertain1", "hello", { clientMessageId: "cid-uncertain", delivery: "uncertain" });
  });

  it("queues the message instead of starting a session when the process is genuinely alive elsewhere", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s1",
      status: "running",
      metadata: { working_directory: "/tmp/repo", pid: 4242, pid_started_at: 1700000000 },
      traits: [],
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
      traits: [],
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
      traits: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockSdkStartSession.mockResolvedValue({ id: "draft", status: "running" } as never);

    const res = await fetch(baseUrl + "/sessions/draft/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "run the action" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).deliveryState).toBe("accepted");
    expect(mockSdkStartSession).toHaveBeenCalledOnce();
    expect(mockQueuePrompt).not.toHaveBeenCalled();
  });

  it("returns the existing admission result for a repeated clientMessageId", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s1",
      metadata: { working_directory: "/tmp/repo", pid: 4242, pid_started_at: 1700000000 },
      traits: [],
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
      traits: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "alive" });
    mockSdkStartSession.mockResolvedValue({ id: "draft", status: "running" } as never);

    const res = await fetch(baseUrl + "/sessions/draft/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "run the action" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("running");
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
      traits: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "dead", reason: "no-process" });
    mockSdkStartSession.mockResolvedValue({ id: "s2", status: "starting" } as never);

    const res = await fetch(baseUrl + "/sessions/s2/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(mockQueuePrompt).not.toHaveBeenCalled();
    expect(mockSdkStartSession).toHaveBeenCalled();
  });

  it("starts a fresh session when liveness is unprovable, never guessing alive", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s3",
      metadata: { working_directory: REAL_REPO_ROOT },
      traits: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue(undefined);
    mockClassifyProcessLiveness.mockReturnValue({ state: "unknown", reason: "no-pid" });
    mockSdkStartSession.mockResolvedValue({ id: "s3", status: "starting" } as never);

    const res = await fetch(baseUrl + "/sessions/s3/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(mockQueuePrompt).not.toHaveBeenCalled();
    expect(mockSdkStartSession).toHaveBeenCalled();
  });

  it("sends directly, bypassing the liveness check, when the session is already active in this process", async () => {
    mockGetSessionRecord.mockResolvedValue({
      id: "s4",
      metadata: { working_directory: "/tmp/repo" },
      traits: [],
    } as never);
    mockSdkGetActiveSession.mockReturnValue({ id: "s4", status: "streaming" } as never);

    const res = await fetch(baseUrl + "/sessions/s4/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(200);
    expect(mockSdkSendMessage).toHaveBeenCalledWith("s4", "hello", { clientMessageId: undefined, reuseClientMessageRow: false }, undefined);
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
    mockGetSessionRecord.mockResolvedValue({ id: "tui", metadata: {}, traits: [] } as never);
    vi.mocked(sessionRuntime.attachRenderer).mockResolvedValue({ attachmentId: "a-1", address: "/tmp/e.sock", harnessSessionId: "thread-1" });
    const res = await attach("tui", { launcherPid: 4242 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attachmentId: "a-1", address: "/tmp/e.sock", harnessSessionId: "thread-1" });
    expect(vi.mocked(residentSession)).toHaveBeenCalledWith("tui", undefined);
    expect(vi.mocked(sessionRuntime.attachRenderer)).toHaveBeenCalledWith("tui", 4242, undefined);
  });

  it("refuses a session driven by another process, a missing one, and a body without the launcher", async () => {
    mockGetSessionRecord.mockResolvedValue({ id: "tui", metadata: {}, traits: [] } as never);
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
  // A session of identity 4 holding `coding`, with one tool picked directly.
  const row = { id: "sess-tools", identity_id: 4, traits: ["coding"], bound: null, bound_id: null, metadata: { selected_tools: ["fetch"] } };
  const trait = (name: string, namespaces: string[]): TraitInfo => ({
    name, description: null, tools: [], namespaces, access: "readwrite", skills: [], instructions: [], bound: {}, boundNames: [], bag: null,
  });

  beforeEach(() => {
    mockGetSessionRecord.mockResolvedValue(row as never);
    vi.mocked(getSession).mockResolvedValue(row as never);
    vi.mocked(traits.list).mockResolvedValue([trait("coding", ["git"]), trait("web", ["web"])]);
    vi.mocked(traits.selectable).mockResolvedValue([trait("coding", ["git"]), trait("web", ["web"])]);
    vi.mocked(collectToolMeta).mockResolvedValue([
      { namespace: "git", toolName: "status", access: "read" },
      { namespace: "git", toolName: "commit", access: "write" },
      { namespace: "web", toolName: "fetch", access: "read" },
    ]);
  });

  it("marks what the session's grants reach, and what granted each", async () => {
    const grants = vi.fn(async (): Promise<Grants> => ({
      ...NO_GRANTS,
      traits: ["coding"],
      namespaces: ["git"],
      tools: [{ name: "status", namespace: "git", bag: "git", access: "read" }, { name: "fetch", namespace: "web", bag: "web", access: "read" }],
    }));
    Barry.use(fakeIdentities({ grants }));

    const body = await (await fetch(`${baseUrl}/sessions/sess-tools/tools/resolved`)).json();

    // Asked once, of the session's identity, with what its row selected.
    expect(grants).toHaveBeenCalledWith(4, expect.objectContaining({ traits: ["coding"], tools: ["fetch"] }), { kind: "owner" });
    expect(body.namespaces).toEqual([
      { name: "git", enabled: true, grantedBy: ["coding"], toolCount: 2 },
      { name: "web", enabled: false, grantedBy: [], toolCount: 1 },
    ]);
    expect(body.tools).toEqual([
      { toolName: "commit", namespace: "git", access: "write", enabled: false, grantedBy: null },
      { toolName: "fetch", namespace: "web", access: "read", enabled: true, grantedBy: "(direct tool)" },
      { toolName: "status", namespace: "git", access: "read", enabled: true, grantedBy: "coding" },
    ]);
    expect(body.selectedTools).toEqual(["fetch"]);
  });

  it("previews traits in place of the session's own, keeping the rest of its selection", async () => {
    const grants = vi.fn(async (): Promise<Grants> => NO_GRANTS);
    Barry.use(fakeIdentities({ grants }));

    const res = await fetch(`${baseUrl}/sessions/sess-tools/tools/preview?traits=web`);

    expect(res.status).toBe(200);
    expect(grants).toHaveBeenCalledWith(4, expect.objectContaining({ traits: ["web"], namespaces: [], tools: [], defaults: true }), { kind: "owner" });
    expect((await res.json()).traits.active).toEqual(["web"]);
  });
});
