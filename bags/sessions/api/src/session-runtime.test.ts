import { randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Module mocks -----------------------------------------------------------
// session-runtime.ts reaches a wide dependency surface before activeSessions.set()
// — DB writes, identity resolution, bag/skill loading, worktree setup. None of
// it is under test here (ResidentBudget/TurnSemaphore's own logic is covered
// standalone in execution-admission.test.ts); these mocks exist only to let
// startSession reach the map write quickly and deterministically.

let sessionCounter = 0;

const dbRows = new Map<string, Record<string, unknown>>();

vi.mock("./db.js", () => ({
  createNamedSession: vi.fn(async (input: Record<string, unknown>) => {
    const row = {
      id: `session-db-id-${++sessionCounter}`,
      state: "open", ended_at: null, workflow_credential_id: null,
      system_prompt: input.system_prompt,
      bags: input.bags ?? [],
      metadata: input.metadata ?? {},
      identity_id: input.identity_id ?? null,
      user_id: input.user_id ?? null,
      bound: input.bound ?? null,
      bounds: input.bounds ?? [],
    };
    dbRows.set(row.id, row);
    return row;
  }),
  updateSessionRecord: vi.fn(async (id: string, updates: Record<string, unknown>) => {
    const existing = dbRows.get(id);
    if (existing) Object.assign(existing, updates);
  }),
  updateSessionMetadata: vi.fn(async () => undefined),
  issueWorkflowCredential: vi.fn(async (id: string) => {
    const row = dbRows.get(id);
    if (!row || row.state !== "open" || row.ended_at !== null) return null;
    row.workflow_credential_id = randomUUID();
    return row.workflow_credential_id;
  }),
  getSessionRecord: vi.fn(async (id: string) => dbRows.get(id)),
  listSessionRecords: vi.fn(async () => []),
  lastMessageSequence: vi.fn(async () => -1),
  shouldPersist: vi.fn(() => false),
  appendMessage: vi.fn(async () => null),
  forgetSession: vi.fn(),
  buildSessionHistoryContext: vi.fn(async () => ""),
}));

vi.mock("@barry-rocks/sessions-bag/lifecycle", () => ({
  endSession: vi.fn(async () => undefined),
}));

vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  const identityRecords = {
    ...actual.identityRecords,
    row: vi.fn(async (id: number): Promise<{ id: number; name: string } | undefined> => ({ id, name: "fixture" })),
    config: vi.fn(() => ({ secrets: {}, vault: null, bags: [], bounds: [], adapters: {} })),
    resolve: vi.fn(async () => ({ barry: { id: "file-barry", name: "default" }, source: "default" })),
    rowId: vi.fn(async () => 1),
    directory: vi.fn(() => null),
  };
  const bounds = { ...actual.bounds, get: vi.fn(async () => undefined), list: vi.fn(async () => []) };
  const owner = {
    ...actual.owner,
    current: vi.fn(async () => ({ id: 1, settings: {} })),
    users: { ...actual.owner.users, get: vi.fn(async (id: number) => ({ id, settings: {} })) },
  };
  return { ...actual, identityRecords, bounds, owner };
});

vi.mock("@barry-rocks/sessions-bag/store/session-helpers", () => ({
  parseMetadata: vi.fn((m: unknown) => m ?? {}),
}));

// process-liveness lives in the sessions bag, so it is mocked there. Under any
// other specifier this entry would be a SILENT NO-OP and the runtime would
// call the real classifier against this machine's process table.
vi.mock("@barry-rocks/sessions-bag/process-liveness", () => ({
  classify: vi.fn(() => ({ state: "unknown" })),
  readProcessStartTime:vi.fn(()=>1700000000),
}));

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getActiveSessions: vi.fn(async () => [...dbRows.values()]),
  getSession: vi.fn(async (id: string) => dbRows.get(id)),
  createProviderSession: vi.fn(async () => undefined),
  endProviderSessionByProviderId: vi.fn(async () => undefined),
  getProviderSessionsBySession: vi.fn(async () => []),
  markCrashedSessions: vi.fn(async () => 0),
}));


vi.mock("./worktree.js", () => ({
  createWorktree: vi.fn(async (base: string) => base),
}));

vi.mock("./repo-paths.js", () => ({
  resolveRepoPath: vi.fn((p: string) => p),
  getGitBranch: vi.fn(async () => null),
}));

// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would exercise the
// real loader.
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBags: vi.fn(async () => []),
  expandCompositionFromSnapshot: vi.fn(async () => []),
  mergeBags: vi.fn(() => ({ hooks: [], instructions: [] })),
}));

vi.mock("@barry-rocks/sdk/internal/vault", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/vault")>(),
  filterBagsNeedingAuthForSession: vi.fn(() => []),
}));
vi.mock("@barry-rocks/events-bag", () => ({
  Events: {
    create: vi.fn(async () => undefined),
  },
}));

vi.mock("@barry-rocks/sdk/internal/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/actions")>(),
  resolveSkillDirs: vi.fn(async () => []),
  buildSkillsPlugin: vi.fn(async () => null),
  addActionCommandsToPlugin: vi.fn(async () => undefined),
  buildActionCommandsDir: vi.fn(async () => null),
  listAllActions: vi.fn(async () => []),
  selectSlashCommandActions: vi.fn(() => []),
}));

const defaultTestVars: Record<string, string> = {
  ANTHROPIC_API_KEY: "test-anthropic-key",
  OPENAI_API_KEY: "test-openai-key",
  CURSOR_API_KEY: "test-cursor-key",
};
const defaultTestSources: Record<string, "value"> = {
  ANTHROPIC_API_KEY: "value",
  OPENAI_API_KEY: "value",
  CURSOR_API_KEY: "value",
};

vi.mock("./identity-env.js", () => ({
  resolveEnvForBarry: vi.fn(async () => ({
    base: { PATH: "/bin", HOME: "/home/test" },
    environment: { vars: { ...defaultTestVars }, sources: { ...defaultTestSources } },
    vars: { PATH: "/bin", HOME: "/home/test", ...defaultTestVars },
  })),
}));

vi.mock("./telemetry.js", () => ({
  recordSessionUsage: vi.fn(),
  bufferToolInvocation: vi.fn(),
  flushToolInvocations: vi.fn(),
}));

// The real module underneath, with only the config builders stubbed. Anything
// session-runtime resolves a bag server with has to be the production code, or
// the bag-server test below would pass whether or not a direct entry is built.
vi.mock("./mcp-config.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("./mcp-config.js")),
  buildMcpConfig: vi.fn(async () => ({})),
}));

vi.mock("./session-prose.js", () => ({
  applyProsePrefix: vi.fn((_provider: string, _prose: unknown, prompt: string, sent: boolean) => ({
    prompt,
    sent,
  })),
}));



import { SessionRuntime, type SessionConfig } from "./session-runtime.js";
import { bounds, identityRecords, owner } from "@barry-rocks/identities-bag";
import { Barry, BarryError, type Bound } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { createNamedSession } from "./db.js";
import { AdmissionError } from "./execution-admission.js";
import { updateSessionRecord, updateSessionMetadata, getSessionRecord } from "./db.js";
import { getProviderSessionsBySession } from "@barry-rocks/sessions-bag/client";
import { endSession } from "@barry-rocks/sessions-bag/lifecycle";
import { setAgentRuntime } from "./agent-runtime.js";
import { Events } from "@barry-rocks/events-bag";
import { loadBags, expandCompositionFromSnapshot, mergeBags } from "@barry-rocks/sdk/internal/bags";

import type { Bag, BagMcpServer, BagSource } from "@barry-rocks/sdk/bags";
import type { CreateSessionFn } from "./agent-runtime-types.js";
import type { SessionConfig as HarnessSessionConfig } from "@barry-rocks/sdk/sessions";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { FakeSession } from "./test-helpers/fake-session.js";
import { installedAdapter } from "./test-helpers/installed-adapter.js";
import { describeShipped, wireShippedHarnesses } from "./test-helpers/shipped-harnesses.js";
import { approveWorkflowBounds, mergeBounds } from "@barry-rocks/sdk/bounds";
import { verifyWorkflowSessionCredential } from "@barry-rocks/sdk/internal/auth";
import { getServicePort } from "@barry-rocks/sdk/services";

beforeEach(() => {
  wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() });
  Barry.use(fakeIdentities({
    bound: async (ref, selection) => {
      const cfg = identityRecords.config(ref as never) as { bounds?: Array<{ name: string; optional?: boolean }> } | undefined;
      const defaultBounds = (cfg?.bounds ?? []).filter((b) => !b.optional).map((b) => b.name);
      const selected = selection ?? [];
      const resolved: Bound[] = [];
      for (const entry of [...defaultBounds, ...selected]) {
        if (typeof entry === "string") {
          const def = await bounds.get(entry, ref as never);
          if (def) resolved.push(def);
        } else if (entry && typeof entry === "object") {
          resolved.push(entry);
        }
      }
      return resolved.length > 0 ? mergeBounds(...resolved) : null;
    },
    tools: async () => [],
    owner: async () => ({ id: 1, name: "fixture", defaultIdentity: null }),
  }));
});
afterEach(() => Barry.reset());

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    prompt: "hello",
    mcpServers: { barry: { type: "http", url: "http://127.0.0.1/mcp" } },
    repoPath: "/repo",
    ...overrides,
  };
}

describe("runtime user attribution", () => {
  it("refuses foreign trusted-principal control before runtime or session effects", async () => {
    const createSession = vi.fn();
    const manager = new SessionRuntime({ createSession });
    const row = { id: "foreign-control", user_id: 2, identity_id: null, metadata: {} };
    dbRows.set(row.id, row);
    const principal = { kind: "installation" as const, actorId: 1, credentialId: "installation" as const };
    const operations = [
      () => manager.startSession(baseConfig({ sessionId: row.id }), principal),
      () => manager.sendMessage(row.id, "spoof", {}, principal),
      () => manager.stopSession(row.id, principal),
      () => manager.interruptTurn(row.id, principal),
      () => manager.removeSession(row.id, principal),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow("ownership mismatch");
    expect(createSession).not.toHaveBeenCalled();
    expect(dbRows.get(row.id)).toEqual(row);
  });
  it("refuses new execution without a bound owner before creating a session", async () => {
    const createSession = vi.fn();
    const manager = new SessionRuntime({ createSession });
    vi.mocked(owner.current).mockResolvedValueOnce(undefined);
    const calls = vi.mocked(createNamedSession).mock.calls.length;
    await expect(manager.startSession(baseConfig())).rejects.toThrow("No Barry user");
    expect(vi.mocked(createNamedSession).mock.calls).toHaveLength(calls);
    expect(createSession).not.toHaveBeenCalled();
  });
  it("records the bound owner for a new session and keeps the recorded user when resuming", async () => {
    const manager = new SessionRuntime({ createSession: vi.fn() });
    vi.mocked(owner.current).mockResolvedValueOnce({ id: 2, settings: {} } as never);
    const active = await manager.startSession(baseConfig({ prepareOnly: true }));
    expect(active.timings.prepare_total_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(active.timings.prepare_total_ms)).toBe(true);
    expect(active.timings.warm_hit).toBe(0);
    expect(createNamedSession).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: 2 }));
    const id = active.id;
    expect(dbRows.get(id)!.user_id).toBe(2);
    await manager.stopSession(id);
    vi.mocked(owner.users.get).mockResolvedValueOnce({ id: 2, settings: {} } as never);
    const calls = vi.mocked(owner.current).mock.calls.length;
    await manager.startSession(baseConfig({ sessionId: id, prepareOnly: true }));
    expect(owner.users.get).toHaveBeenLastCalledWith(2);
    expect(identityRecords.resolve).toHaveBeenLastCalledWith(expect.anything(), { kind: "owner", actorId: 2 });
    expect(vi.mocked(owner.current).mock.calls).toHaveLength(calls);
    await manager.stopSession(id);
  });
  it("refuses a missing recorded user without switching ownership or starting a harness", async () => {
    const createSession = vi.fn();
    const manager = new SessionRuntime({ createSession });
    dbRows.set("missing-owner", { id: "missing-owner", user_id: 99, metadata: {}, identity_id: null });
    vi.mocked(owner.users.get).mockResolvedValueOnce(undefined);
    const calls = vi.mocked(owner.current).mock.calls.length;
    await expect(manager.startSession(baseConfig({ sessionId: "missing-owner" }))).rejects.toThrow("No Barry user");
    expect(vi.mocked(owner.current).mock.calls).toHaveLength(calls);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("identity-selected bash bound reaches the hosted harness", () => {
  it("hands native shell denial to createSession from the bag bound without compatibility defaults", async () => {
    const { parseManifest } = await import("@barry-rocks/sdk/bags");
    const bash = parseManifest(new URL("../../../bash", import.meta.url).pathname)!;
    const installed = describeShipped("claude")!;
    const manifest = installed.bag!.manifest;
    const manifestBounds = { ...bash.bounds, ...manifest.bounds };
    const originalConfig = vi.mocked(identityRecords.config).getMockImplementation();
    const session = new FakeSession();
    const createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => session);
    try {
      vi.mocked(bounds.get).mockImplementation(async (nameOrRef) => {
        const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
        const def = manifestBounds[name];
        return def ? { name, ...def.bound } : undefined;
      });
      vi.mocked(identityRecords.config).mockReturnValue({ secrets: {}, vault: undefined, bags: [], bounds: [{ name: "bash:no-bash", optional: false }], adapters: {} } as never);
      const record = { ...installed, bag: { ...installed.bag!, manifest: { ...manifest } } };
      setAgentRuntime({ createSession, runStructured: vi.fn(), describeAdapter: () => record });
      const manager = new SessionRuntime({ createSession });
      await manager.startSession(baseConfig({ provider: "claude" }));
      await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
      expect(createSession.mock.calls[0][1].deniedTools).toEqual(expect.arrayContaining(["Bash", ...(record.tools ?? [])]));
    } finally {
      session.end();
      if (originalConfig) vi.mocked(identityRecords.config).mockImplementation(originalConfig);
      vi.mocked(bounds.get).mockResolvedValue(undefined);
      wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() });
    }
  });
});

describe("prepared hosted sessions", () => {
  it("protects an open WebSocket draft when the resident budget is full", async () => {
    const manager = new SessionRuntime({ limits: { maxResidentSessions: 1 }, createSession: vi.fn(async () => Object.assign(new FakeSession(), { warm: async () => {} })) });
    const draft = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    await manager.warmHarness(draft.id);
    const subscriber = { readyState: 1, send: vi.fn() };
    manager.subscribe(draft.id, subscriber);
    await expect(manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }))).rejects.toThrow();
    expect(manager.getActiveSession(draft.id)).toBe(draft);
    expect(dbRows.has(draft.id)).toBe(true);
    const ended = vi.mocked(endSession).mock.calls.length;
    manager.unsubscribe(draft.id, subscriber);
    const next = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    expect(manager.getActiveSession(draft.id)).toBeUndefined();
    expect(dbRows.has(draft.id)).toBe(true);
    expect(manager.getActiveSession(next.id)).toBe(next);
    expect(vi.mocked(endSession)).toHaveBeenCalledTimes(ended);
  });
  it("preserves a prepared row during API shutdown eviction", async () => {
    const manager = new SessionRuntime({ createSession: vi.fn(async () => Object.assign(new FakeSession(), { warm: async () => {} })) });
    const draft = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    await manager.warmHarness(draft.id);
    const ended = vi.mocked(endSession).mock.calls.length;
    manager.subscribe(draft.id, { readyState: 1, send: vi.fn() });
    await manager.dropResident(draft.id, { force: true });
    expect(manager.getActiveSession(draft.id)).toBeUndefined();
    expect(dbRows.has(draft.id)).toBe(true);
    expect(vi.mocked(endSession)).toHaveBeenCalledTimes(ended);
  });
  it("does not delete unstarted hosted drafts during restart reconciliation", async () => {
    const manager = new SessionRuntime();
    const { getActiveSessions } = await import("@barry-rocks/sessions-bag/client");
    vi.mocked(getActiveSessions).mockResolvedValueOnce([{ id: "restart-draft", status: "pending", started_at: null, metadata: { mode: "hosted" } }] as Awaited<ReturnType<typeof getActiveSessions>>);
    const ended = vi.mocked(endSession).mock.calls.length;
    await manager.reconcileStaleSessions();
    expect(vi.mocked(endSession)).toHaveBeenCalledTimes(ended);
  });
  it("warms exactly once and delivers the first message without harness startup timings", async () => {
    const session = Object.assign(new FakeSession(), { isWarm:()=>true,warm: vi.fn(async () => {}) });
    const create = vi.fn(async () => session);
    const manager = new SessionRuntime({ createSession: create });
    const active = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    await Promise.all([manager.warmHarness(active.id), manager.warmHarness(active.id)]);
    expect(create).toHaveBeenCalledOnce();
    expect(session.warm).toHaveBeenCalledOnce();
    expect(session.delivered).toEqual([]);
    expect(active.status).toBe("waiting");
    expect(dbRows.get(active.id)?.started_at).toBeUndefined();
    await manager.sendMessage(active.id, "hello");
    await vi.waitFor(() => expect(session.delivered).toHaveLength(1));
    session.push({ type: "partial", text: "hi" }); session.end();
    await vi.waitFor(() => expect(active.status).toBe("waiting"));
    expect(active.timings.warm_hit).toBe(1);
    expect(active.timings).not.toHaveProperty("harness_create_ms");
    expect(active.timings).not.toHaveProperty("harness_ready_ms");
    expect(dbRows.get(active.id)?.started_at).toBeInstanceOf(Date);
    expect(create).toHaveBeenCalledOnce();
    await manager.removeSession(active.id);
  });
  it("leaves a failed warm usable for a cold first delivery", async () => {
    const session = Object.assign(new FakeSession(), { warm: vi.fn(async () => { throw new Error("initialize failed"); }) });
    const manager = new SessionRuntime({ createSession: vi.fn(async () => session) });
    const active = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    await manager.warmHarness(active.id);
    expect(active.warm?.error).toBe("initialize failed");
    await manager.sendMessage(active.id, "hello");
    await vi.waitFor(() => expect(session.delivered).toHaveLength(1));
    session.end(); await active.lastTurn;
    expect(active.timings.warm_hit).toBe(0);
    await manager.removeSession(active.id);
  });
  it("evicts idle unused sessions, retains subscribers and messages, and starts the TTL on UI close", async () => {
    vi.stubEnv("BARRY_WARM_IDLE_MS", "1000");
    const manager = new SessionRuntime({ createSession: vi.fn(async () => Object.assign(new FakeSession(), { warm: async () => {} })) });
    const idle = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    const open = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    const used = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    for (const active of [idle, open, used]) {
      await manager.warmHarness(active.id);
      active.warm!.preparedAt = Date.now() - 2000; active.warm!.idleSince = Date.now() - 2000;
    }
    const subscriber = { readyState: 1, send: vi.fn() };
    manager.subscribe(open.id, subscriber);
    used.lastSequence = 1;
    await manager.sweepWarmSessions();
    expect(manager.getActiveSession(idle.id)).toBeUndefined();
    expect(manager.getActiveSession(open.id)).toBe(open);
    expect(manager.getActiveSession(used.id)).toBe(used);
    manager.unsubscribe(open.id, subscriber);
    await manager.sweepWarmSessions();
    expect(manager.getActiveSession(open.id)).toBe(open);
    open.warm!.idleSince = Date.now() - 2000;
    await manager.sweepWarmSessions();
    expect(manager.getActiveSession(open.id)).toBeUndefined();
    await manager.removeSession(used.id);
    vi.unstubAllEnvs();
  });
  it("drops an unused configuration without ending its row and refuses to drop a queued turn", async () => {
    const session = Object.assign(new FakeSession(), { warm: async () => {} });
    const manager = new SessionRuntime({ createSession: vi.fn(async () => session) });
    const active = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
    await manager.warmHarness(active.id);
    active.pendingTurns = 1;
    expect(await manager.dropResident(active.id)).toBeNull();
    active.pendingTurns = 0;
    const ended = vi.mocked(endSession).mock.calls.length;
    expect(await manager.dropResident(active.id)).toBe(active);
    expect(manager.getActiveSession(active.id)).toBeUndefined();
    expect(dbRows.has(active.id)).toBe(true);
    expect(vi.mocked(endSession)).toHaveBeenCalledTimes(ended);
    expect(session.closeCalls).toBeGreaterThan(0);
  });
});

describe("workflow-scoped harness credentials", () => {
  it("replaces the Barry instance bearer with a session and bound token", async () => {
    vi.stubEnv("BARRY_SECRET", "barry_test_instance_secret_with_enough_entropy");
    const approvedBound = await approveWorkflowBounds({ identity: "stable-reviewer", bags: [], bounds: [], tools: [], boundByName: async () => undefined });
    const session = new FakeSession();
    const createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => session);
    const adapter = describeShipped("claude")!;
    setAgentRuntime({ createSession, runStructured: vi.fn(), describeAdapter: () => adapter });
    const manager = new SessionRuntime({ createSession });
    try {
      const active = await manager.startSession(baseConfig({
        provider: "claude",
        identityId: 1,
        metadata: { workflow_bound: approvedBound, workflow_identity_id: 1 },
        mcpServers: { barry: { type: "http", url: `http://127.0.0.1:${getServicePort("mcpBarry")}/mcp`, headers: { Authorization: "Bearer barry_test_instance_secret_with_enough_entropy" } } },
      }));
      await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
      const server = createSession.mock.calls[0][1].mcpServers.barry;
      expect(server).toMatchObject({ headers: { Authorization: expect.stringMatching(/^Bearer bws3\./) } });
      if (!("headers" in server) || !server.headers?.Authorization) throw new Error("workflow bearer was not installed");
      expect(server.headers.Authorization).not.toContain("barry_test_instance_secret");
      expect(verifyWorkflowSessionCredential(server.headers.Authorization.slice("Bearer ".length), "barry_test_instance_secret_with_enough_entropy")).toMatchObject({
        sessionId: active.id,
        credentialId: dbRows.get(active.id)?.workflow_credential_id,
        identity: "stable-reviewer",
        boundFingerprint: approvedBound.fingerprint,
      });
      expect(createSession.mock.calls[0][1].deniedTools).toEqual(expect.arrayContaining(adapter.tools ?? []));
    } finally {
      session.end();
      vi.unstubAllEnvs();
      wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() });
    }
  });
});

describe("SessionRuntime admission (astra-review F7)", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("20 concurrent startSession calls never exceed the resident budget (cap 3)", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 3 } });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => manager.startSession(baseConfig())),
    );
    const admitted = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(17);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(AdmissionError);
    }
    // Drain the admitted sessions' fire-and-forget cold-start turns before
    // the test ends — `sessions` is a `describe`-scoped array shared by every
    // test in this block, and a still-in-flight createSession() call from
    // this test landing after the next test's beforeEach resets `sessions`
    // would push a stray entry into that OTHER test's array (cross-test
    // pollution masquerading as a session count mismatch there instead of
    // a leak here, where it actually belongs).
    await vi.waitFor(() => expect(sessions).toHaveLength(3));
    for (const s of sessions) s.end();
  });

  it("closes an already-created row before recording a setup failure", async () => {
    const manager = new SessionRuntime({ createSession });
    vi.mocked(updateSessionRecord).mockRejectedValueOnce(new Error("start write failed"));
    await expect(manager.startSession(baseConfig())).rejects.toThrow("start write failed");
    const row = await vi.mocked(createNamedSession).mock.results.at(-1)!.value;
    expect(endSession).toHaveBeenCalledWith({ session_id: row.id, reason: "start-failed" });
    expect(dbRows.get(row.id)).toMatchObject({ status: "failed" });
    const failedIndex = vi.mocked(updateSessionRecord).mock.calls.findIndex(([id, patch]) => id === row.id && patch.status === "failed");
    expect(vi.mocked(endSession).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(updateSessionRecord).mock.invocationCallOrder[failedIndex]);
  });

  it("a failed startup releases its reservation so the next start succeeds", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 1 } });
    // Force a failure well before activeSessions.set by making the identity
    // resolution reject.
    vi.mocked(identityRecords.resolve).mockRejectedValueOnce(new BarryError("not_found", "boom"));

    await expect(manager.startSession(baseConfig())).rejects.toThrow("boom");
    // The reservation from the failed attempt must have been released —
    // fails against defect-A code, which never released on early failure
    // either (though the OLD code's bug was different: it never reserved at
    // all, so this specifically proves release() undoes reserve()).
    const session = await manager.startSession(baseConfig());
    expect(session).toBeDefined();
    // Drain this session's fire-and-forget cold-start turn — same
    // cross-test-pollution hazard as the 20-concurrent test above: an
    // undrained createSession() resolving after the next test's beforeEach
    // resets `sessions` would push a stray entry into that test's array.
    await vi.waitFor(() => expect(sessions.length).toBeGreaterThanOrEqual(1));
    for (const s of sessions) s.end();
  });

  it.each(["claude", "codex", "cursor"] as const)("closes a resting session to admit a %s message when capacity is full", async (provider) => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 1 } });
    const session = await manager.startSession(baseConfig({ provider }));
    // startSession resolves once the ActiveSession is in the map; the cold
    // start turn itself runs fire-and-forget (`void this.runSession(...)`),
    // so createSession has not necessarily been called yet.
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].end(); // let the initial turn complete -> status becomes "waiting"
    await vi.waitFor(() => expect(session.status).toBe("waiting"));

    const next = await manager.startSession(baseConfig({ provider }));
    expect(session.status).toBe("complete");
    expect(manager.getActiveSession(session.id)).toBeUndefined();
    expect(manager.getActiveSession(next.id)).toBe(next);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(createSession.mock.calls[1][0]).toBe(provider);
    sessions[1].end();
  });
});

describe("SessionRuntime turn semaphore (astra-review F7)", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("resumed turns respect maxConcurrentTurns — a second turn does not start until the first ends", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    // @ts-expect-error reaching into the private semaphore — the only
    // reliable signal that a turn's lease was actually released. `status`
    // flips to "waiting" INSIDE runTurn's try block, several awaited DB
    // calls before the turn's own `finally` actually releases the lease —
    // waiting on status alone lets the next turn's acquire() queue behind a
    // lease the test believes is already free, which is what hung this test.
    const semaphore = manager.turnSemaphore as { running(): number };

    const a = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].end();
    await vi.waitFor(() => expect(semaphore.running()).toBe(0));

    const b = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1].end();
    await vi.waitFor(() => expect(semaphore.running()).toBe(0));

    // Both sessions now resting. Send a resume to each concurrently; with
    // maxConcurrentTurns=1 the second must not reach the provider until the
    // first turn's stream ends.
    const firstTurn = manager.sendMessage(a.id, "again");
    // Wait for the first turn to actually acquire the semaphore lease and
    // start streaming (status flips to "streaming" only after `acquire()`
    // resolves) — a count-based check here resolves before the turn has
    // reached the semaphore at all and defeats the rest of the test.
    await vi.waitFor(() => expect(a.status).toBe("streaming"));
    const secondTurn = manager.sendMessage(b.id, "again");

    await new Promise((r) => setTimeout(r, 20));
    expect(b.status).toBe("waiting"); // provider turn is still queued behind the semaphore

    sessions[0].end(); // release the first turn's lease
    await firstTurn;
    // The second turn's resume reuses sessions[1] (same instance as its cold
    // start — send()/start() reset `ended` per call), so its stream is
    // freshly open and needs its own end() or `secondTurn` never resolves.
    await vi.waitFor(() => expect(b.status).toBe("streaming"));
    sessions[1].end();
    await secondTurn;
    await vi.waitFor(() => expect(b.status).toBe("waiting"));
  });

  it("returns the correlated harness result only after the turn reaches done", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    const active = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].push({ type: "result", result: "initial" });
    sessions[0].end();
    await vi.waitFor(() => expect(active.status).toBe("waiting"));

    const result = manager.sendMessageAndWait(active.id, "review this", "workflow-turn-1");
    await vi.waitFor(() => expect(sessions[0].delivered).toHaveLength(2));
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    sessions[0].push({ type: "result", result: "reviewed" });
    sessions[0].end();
    await expect(result).resolves.toEqual({ state: "completed", result: "reviewed" });
  });

  it("can start a fresh session and wait for its first harness turn", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    const started = manager.startSessionAndWait(baseConfig());
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].push({ type: "result", result: "first answer" });
    sessions[0].end();
    await expect(started).resolves.toMatchObject({ outcome: { state: "completed", result: "first answer" } });
  });
});

describe("SessionRuntime cancellation (astra-review F8)", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("stop with a queued turn creates no new provider session and broadcasts nothing after stop", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    const a = await manager.startSession(baseConfig());
    // First turn (the cold start) is still in flight — wait for it to have
    // actually reached the provider (activeSession.session assigned) before
    // queuing a resume behind it, or sendMessage would take the OTHER
    // (cold-start) branch instead of the resume branch this test targets.
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    // Queue a resume behind the in-flight first turn — it chains onto
    // turnQueue and will not actually run until the first turn's own link
    // resolves, i.e. until sessions[0] ends.
    const queuedTurn = manager.sendMessage(a.id, "second message").catch(() => {});

    // Stop the session while that resume is still queued behind the
    // in-flight first turn.
    await manager.stopSession(a.id);
    // Let the first turn's stream actually end so the queued link can run.
    sessions[0].end();

    // Let the queued turn's link in turnQueue actually run.
    await queuedTurn;

    // Fails against defect-D code: the queued turn would find
    // activeSession.session === null (stopSession nulled it) and create a
    // SECOND FakeSession via createSession — resurrecting a stopped
    // session with a fresh provider process.
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("turn lease is held until the iterator actually terminates, not merely when stop is accepted", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    await manager.startSession(baseConfig());
    // Turn is in flight (cold start), lease held — wait for it to actually
    // be in flight against the provider before asserting anything about it.
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    // A second session must be blocked from acquiring the (single) execution
    // slot until the first turn's iterator has actually drained — proven by
    // starting a second session and confirming its turn does not begin
    // (never reaches the point of calling createSession's returned
    // session's stream) until the first is ended.
    const b = await manager.startSession(baseConfig());
    // b's cold-start turn is queued on the semaphore (maxConcurrentTurns=1,
    // slot held by a's still-open stream).
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions).toHaveLength(1); // b's createSession has not run yet

    sessions[0].end(); // a's turn iterator terminates -> lease released
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1]?.end();
  });

  it("a hard stop releases its slot even when the old harness reader stays silent", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    const a = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));

    // Resolves without waiting for the harness: a stop is a request.
    await manager.stopSession(a.id);
    // The harness is still draining — it reports more of the turn after the stop.
    sessions[0].push({ type: "text", text: "still draining", role: "assistant" });

    await manager.startSession(baseConfig());
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions, "the forced turn must release its lease").toHaveLength(2);

    sessions[0].end();
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1].end();
  });

  it("evicts an idle resident without completing its work or promoting its worktree", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 1 } });
    const idle = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));
    sessions[0].end(); await idle.lastTurn;
    dbRows.get(idle.id)!.metadata = { use_worktree: true, worktree_status: "active" };
    vi.mocked(Events.create).mockClear();
    vi.mocked(updateSessionMetadata).mockClear();
    const next = await manager.startSession(baseConfig());
    expect(endSession).toHaveBeenCalledWith({ session_id: idle.id, reason: "evicted" });
    expect(dbRows.get(idle.id)).toMatchObject({ status: "pending" });
    expect(updateSessionMetadata).not.toHaveBeenCalledWith(idle.id, { worktree_status: "ready_to_merge" });
    expect(Events.create).not.toHaveBeenCalledWith(expect.objectContaining({ type: "task_finished", session_id: idle.id }));
    expect(manager.getActiveSession(idle.id)).toBeUndefined();
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1].end(); await next.lastTurn;
  });

  it("interrupts a turn waiting for a lease without closing its session", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 1 } });
    const running = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));
    const queued = await manager.startSession(baseConfig());
    expect(await manager.interruptTurn(queued.id)).toBe(true);
    expect(queued.status).toBe("waiting");
    expect(dbRows.get(queued.id)).toMatchObject({ status: "pending" });
    sessions[0].end();
    await running.lastTurn;
    await expect(queued.lastTurn).resolves.toMatchObject({ state: "interrupted" });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(manager.getActiveSession(queued.id)).toBe(queued);
    const next = manager.sendMessage(queued.id, "after interrupt");
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    sessions[1].end();
    await next;
  });

  it("interrupting a turn ends it and keeps the session for the next message", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const a = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));
    await vi.waitFor(() => expect(a.status).toBe("streaming"));

    const interrupting=manager.interruptTurn(a.id);
    await vi.waitFor(()=>expect(sessions[0].interruptCalls).toBeGreaterThan(0));
    // How a harness reports the abort: drained after the interrupt, so the
    // turn rests rather than failing.
    sessions[0].push({ type: "error", error: "aborted" });
    sessions[0].end();
    expect(await interrupting).toBe(true);

    await vi.waitFor(() => expect(a.status).toBe("waiting"));
    expect(sessions[0].closeCalls).toBe(0);

    const next = manager.sendMessage(a.id, "and now this");
    await vi.waitFor(() => expect(sessions[0].delivered).toHaveLength(2));
    sessions[0].end();
    await next;
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("rules on what a hosted harness asks about: the session's denials refused, the rest run", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const bound: Bound = { tools: { deny: ["claude-code:Bash", "claude-code:Read"] } };
    await manager.startSession(baseConfig({ bounds: [bound] }));
    await manager.startSession(baseConfig({ provider: "codex", bounds: [bound] }));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    const [claude, codex] = createSession.mock.calls.map((call) => call[1] as HarnessSessionConfig);

    // Every adapter receives the mandatory native ceiling.
    expect(claude?.deniedTools).toContain("Bash");
    expect(codex?.deniedTools).toEqual(expect.arrayContaining(describeShipped("codex")!.tools ?? []));
    // A barry that does not allow native tools has them denied, Bash first;
    // Barry's own tools still run.
    await expect(claude?.decide?.({ id: "1", tool: "Bash", input: {} })).resolves.toMatchObject({ allow: false });
    await expect(claude?.decide?.({ id: "2", tool: "Read", input: {} })).resolves.toMatchObject({ allow: false });
    await expect(claude?.decide?.({ id: "5", tool: "mcp__barry__memory_save", input: {} })).resolves.toEqual({ allow: true });
    // Unknown native requests are also refused.
    await expect(codex?.decide?.({ id: "3", tool: "command_execution", input: {} })).resolves.toMatchObject({ allow: false });
    await expect(codex?.decide?.({ id: "4", tool: "mcp__barry__memory_save", input: {} })).resolves.toEqual({ allow: true });
    for (const session of sessions) session.end();
  });

  it("runs a session asked for by the harness's new id under the spelling its rows already carry", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    await manager.startSession(baseConfig({ provider: "claude-code" }));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // "claude" is claude-code's former id: rows and the provider field keep it.
    expect(createSession.mock.calls[0]?.[0]).toBe("claude");
    for (const session of sessions) session.end();
  });

  it("has nothing to interrupt when no turn is running", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const a = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));
    sessions[0].end();
    await vi.waitFor(() => expect(a.status).toBe("waiting"));

    expect(await manager.interruptTurn(a.id)).toBe(false);
  });

  it("broadcasts startup and first-token timings when a turn finishes", async () => {
    const manager = new SessionRuntime({ createSession });
    const active = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));
    const sent: Array<{ type: string; status?: string; metadata?: { timing?: Record<string, number> } }> = [];
    const subscriber = { readyState: 1, send: (data: unknown) => sent.push(JSON.parse(String(data))) };
    manager.subscribe(active.id, subscriber);
    sessions[0].push({ type: "partial", text: "hi" });
    sessions[0].end();
    await vi.waitFor(() => expect(sent.some(frame => frame.status === "waiting")).toBe(true));
    const timing = sent.find(frame => frame.status === "waiting")?.metadata?.timing;
    expect(timing).toMatchObject({ warm_hit: 0 });
    for (const key of ["env_ms", "open_ms", "deliver_ms", "first_event_ms", "first_token_ms", "turn_done_ms"]) {
      expect(Number.isFinite(timing?.[key])).toBe(true);
      expect(timing?.[key]).toBeGreaterThanOrEqual(0);
    }
    expect(timing!.first_token_ms).toBeLessThanOrEqual(timing!.turn_done_ms);
    manager.unsubscribe(active.id, subscriber);
    await manager.removeSession(active.id);
  });

  it("tells its subscribers when a turn fails, as it does when one finishes", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const a = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions[0]?.delivered).toHaveLength(1));
    const sent: Array<{ type: string; status?: string }> = [];
    manager.subscribe(a.id, { readyState: 1, send: (data: unknown) => sent.push(JSON.parse(String(data))) });

    sessions[0].push({ type: "error", error: "harness exploded" });
    sessions[0].end();

    await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ type: "status", status: "error" })));
  });

  it("no resurrection: late events after stop are neither broadcast nor able to revive status", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const a = await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    await manager.stopSession(a.id);
    expect(a.status).toBe("complete");

    // Push an event into the (still technically iterable, in a broken
    // implementation) fake stream after stop.
    sessions[0].push({ type: "text", text: "late", role: "assistant" });
    sessions[0].end();
    await new Promise((r) => setTimeout(r, 20));

    // Status must not have been resurrected to "streaming"/"waiting" by the
    // late event.
    expect(a.status).toBe("complete");
  });
});

// The API used to add every PACKED bag's MCP servers to the session as direct
// entries, skipping only a namespace the proxy already served -- and only
// GRANTED namespaces get a proxy entry. So a bag packed on the identity but not
// granted got a direct, unfiltered `npx mcp-remote` connection: a browser tab
// when no token was cached, and that bag's tools with no filter when one
// was. The engine proxies every declared server, filtered by the session's
// selection, so a bag's servers reach the agent through the proxy or not at all.
describe("bag MCP servers reach the agent only through the proxy", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
    // Packed bags make startSession ask the engine's /bag-status; answer it
    // here so the test never reaches a live engine on this machine.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ needsAuth: [], authExpired: [] }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function packedBag(name: string, source: BagSource, mcpServers: Record<string, BagMcpServer>): Bag {
    return {
      name, description: name, builtin: false, source, manifest: null,
      skillsDirs: [], actionsDirs: [], instructionsDirs: [], mcpServers, tools: [],
      dependencies: [], slashCommands: [], hooks: [], requires: [], services: [], apps: [], schedules: [],
    };
  }

  it("gives a packed but unselected bag no direct server, and keeps the selected bag's proxy entry", async () => {
    // `notion` is selected, so the route has already built its proxy entry.
    // `vantage-docs` is packed on the identity and not selected.
    const docsUrl = "https://docs.vantage.sh/mcp";
    vi.mocked(identityRecords.config).mockReturnValueOnce({
      bag_configs: {},
      secrets: {},
      vault: undefined, bags: [{ name: "notion", optional: false }, { name: "vantage-docs", optional: true }],
      bounds: [], adapters: {},
      status_notify: undefined,
    } as never);
    vi.mocked(expandCompositionFromSnapshot).mockResolvedValueOnce(["notion", "vantage-docs"]);
    vi.mocked(loadBags).mockResolvedValueOnce([
      packedBag("notion", { type: "local", path: "/bags/notion" }, { notion: { type: "http", url: "https://mcp.notion.com/mcp" } }),
      packedBag("vantage-docs", { type: "remote", url: docsUrl }, { "vantage-docs": { type: "http", url: docsUrl } }),
    ]);
    // The real merge, so the servers reach the runtime exactly as a session sees them.
    const merge = await vi.importActual<typeof import("@barry-rocks/sdk/internal/bags")>("@barry-rocks/sdk/internal/bags");
    vi.mocked(mergeBags).mockImplementationOnce(merge.mergeBags);

    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig({
      mcpServers: { notion: { type: "http", url: "http://localhost:3901/mcp/ns/notion" } },
    }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    const handedToAgent: HarnessSessionConfig = createSession.mock.calls[0][1];
    const servers = handedToAgent.mcpServers;
    expect(Object.keys(servers)).not.toContain("vantage-docs");
    const direct = Object.entries(servers)
      .filter(([, server]) => "args" in server && server.args?.includes("mcp-remote"))
      .map(([name]) => name);
    expect(direct).toEqual([]);
    expect(servers.notion).toMatchObject({ url: expect.stringContaining("/mcp/ns/notion") });
    sessions[0].end();
  });

  it("queries /bag-status?sessionId= and does not fallback to all packed bags for session without optional bags", async () => {
    let queriedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      queriedUrl = String(url);
      return new Response(JSON.stringify({ scoped: true, needsAuth: [], authExpired: [] }));
    }));

    vi.mocked(identityRecords.config).mockReturnValueOnce({
      bag_configs: {},
      secrets: {},
      vault: undefined, bags: [{ name: "notion", optional: true }],
      bounds: [], adapters: {},
      status_notify: undefined,
    } as never);
    vi.mocked(expandCompositionFromSnapshot).mockResolvedValueOnce(["notion"]);
    vi.mocked(loadBags).mockResolvedValueOnce([
      packedBag("notion", { type: "local", path: "/bags/notion" }, { notion: { type: "http", url: "https://mcp.notion.com/mcp" } }),
    ]);

    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig({ prompt: "hello" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    expect(queriedUrl).toContain("/bag-status?sessionId=");
    const handedToAgent: HarnessSessionConfig = createSession.mock.calls[0][1];
    expect(handedToAgent.systemPrompt).toBeUndefined();
    expect(Events.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "bag_auth" }),
    }));
    sessions[0].end();
  });

  it("adds guidance and notifies when scoped bag-status reports unauthorized selected bag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(JSON.stringify({ scoped: true, needsAuth: ["notion"], authExpired: [] }));
    }));

    vi.mocked(identityRecords.config).mockReturnValueOnce({
      bag_configs: {},
      secrets: {},
      vault: undefined, bags: [{ name: "notion", optional: false }],
      bounds: [], adapters: {},
      status_notify: undefined,
    } as never);
    vi.mocked(expandCompositionFromSnapshot).mockResolvedValueOnce(["notion"]);
    vi.mocked(loadBags).mockResolvedValueOnce([
      packedBag("notion", { type: "local", path: "/bags/notion" }, { notion: { type: "http", url: "https://mcp.notion.com/mcp" } }),
    ]);

    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig({ bags: ["notion"], prompt: "hello" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    const handedToAgent: HarnessSessionConfig = createSession.mock.calls[0][1];
    expect(handedToAgent.systemPrompt).toContain("## Bag Authorization");
    expect(handedToAgent.systemPrompt).toContain("notion");
    expect(Events.create).toHaveBeenCalledWith(expect.objectContaining({
      type: "system_alert",
      data: expect.objectContaining({ action: "bag_auth", bags: ["notion"] }),
    }));
    sessions[0].end();
  });
});

// First-class Ollama through the API path. The route must come from the
// explicit provider — a custom model id names none on its own — and must reach
// the agent AND the stored metadata, or a restart re-infers it and loses it.
describe("SessionRuntime model provider", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    vi.mocked(updateSessionRecord).mockClear();
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  function recordedMetadata(): Record<string, unknown> {
    const call = vi.mocked(updateSessionRecord).mock.calls.find(
      (c) => (c[1] as { metadata?: Record<string, unknown> })?.metadata?.provider,
    );
    return ((call?.[1] as { metadata?: Record<string, unknown> })?.metadata) ?? {};
  }

  const identityConfig = (adapters: import("@barry-rocks/sdk").IdentityAdapters) => ({ adapters, bag_configs: {}, secrets: {}, vault: undefined, bags: [], bounds: [], status_notify: undefined }) as never;

  it("starts and records the identity's default harness and its model", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce(identityConfig({ "claude-code": {}, codex: { default: true, model: "gpt-5" } }));
    const manager = new SessionRuntime({ createSession });
    const active = await manager.startSession(baseConfig({ provider: undefined }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(active.provider).toBe("codex");
    expect(createSession.mock.calls[0][0]).toBe("codex");
    expect(createSession.mock.calls[0][1].model).toBe("openai/gpt-5");
    expect(recordedMetadata().provider).toBe("codex");
    sessions[0].end();
  });

  it("uses the explicitly selected harness's own identity entry", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce(identityConfig({ "claude-code": { default: true, model: "opus" }, codex: { model: "gpt-5" } }));
    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig({ provider: "codex" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(createSession.mock.calls[0][1].model).toBe("openai/gpt-5");
    sessions[0].end();
  });

  it("refuses an ambiguous identity before starting a harness", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce(identityConfig({ "claude-code": {}, codex: {} }));
    const manager = new SessionRuntime({ createSession });
    await expect(manager.startSession(baseConfig({ provider: undefined }))).rejects.toThrow("--default");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("records the fallback under its existing claude spelling", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce(identityConfig({}));
    const manager = new SessionRuntime({ createSession });
    const active = await manager.startSession(baseConfig({ provider: undefined }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(active.provider).toBe("claude");
    expect(recordedMetadata().provider).toBe("claude");
    sessions[0].end();
  });

  it("hands an explicit provider and custom model to the agent and records it", async () => {
    const manager = new SessionRuntime({ createSession });
    const session = await manager.startSession(baseConfig({ model: "my-custom:7b", modelProvider: "ollama" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(createSession.mock.calls[0][1]).toMatchObject({ model: "ollama/my-custom:7b" });
    expect(session.modelProvider).toBe("ollama");
    expect(recordedMetadata()).toMatchObject({ model: "my-custom:7b", model_provider: "ollama" });
    sessions[0].end();
  });

  it("applies the identity's default model provider", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce({
      bag_configs: {},
      secrets: {},
      vault: undefined, bags: [], bounds: [],
      adapters: { "claude-code": { model: "ollama/my-custom:7b" } },
      status_notify: undefined,
    } as never);
    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig());
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(createSession.mock.calls[0][1]).toMatchObject({ model: "ollama/my-custom:7b" });
    sessions[0].end();
  });

  it("refuses a turn that would send the user's own login to an endpoint that needs a key", async () => {
    // glm-5.2 runs on claude through z.ai. With no Z_AI_API_KEY, Claude Code
    // falls back to the user's Anthropic login — and would send it to z.ai.
    const manager = new SessionRuntime({ createSession });
    const session = await manager.startSession(baseConfig({ model: "glm-5.2" }));
    await vi.waitFor(() => expect(session.status).toBe("error"));
    expect(session.modelProvider).toBe("zai");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses a provider the agent cannot reach before creating anything", async () => {
    const manager = new SessionRuntime({ createSession });
    await expect(manager.startSession(baseConfig({ provider: "cursor", modelProvider: "ollama" }))).rejects.toThrow(/cursor/);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("what an API session records about itself", () => {
  const unusedStructured = async (): Promise<never> => {
    throw new Error("not exercised");
  };

  // What the adapter DECLARES for its hosted mode: a live engine's
  // guarantees. The session a test starts reports per-turn ones instead, so a
  // record copied from the declaration rather than the session reads
  // differently — API sessions once recorded steer and per-call gating they
  // did not have for exactly that reason.
  const declared = installedAdapter("claude", {
    vendor: "anthropic",
    modes: {
      hosted: {
        guarantees: {
          capture: "total",
          delivery: "wake",
          steer: true,
          interrupt: true,
          gating: "per-call",
          keepsVendorUi: false,
          identity: "inherent",
        },
        verifiedOn: "2.1.282",
        evidence: { check: "test", proves: "test" },
        egressSandbox: true,
      },
      instrumented: null,
      guest: null,
    },
  });

  afterEach(() => {
    setAgentRuntime({ createSession: vi.fn(), runStructured: unusedStructured });
  });

  async function recordOf(session: FakeSession, describeAdapter?: (id: string) => InstalledAdapter | undefined) {
    const createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => session);
    setAgentRuntime({ createSession, runStructured: unusedStructured, ...(describeAdapter ? { describeAdapter } : {}) });
    vi.mocked(updateSessionMetadata).mockClear();

    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig({ provider: "claude" }));
    await vi.waitFor(() => expect(updateSessionMetadata).toHaveBeenCalled());
    session.end();

    return vi.mocked(updateSessionMetadata).mock.calls
      .map(([, fields]) => fields as Record<string, unknown>)
      .find((fields) => fields.mode !== undefined);
  }

  it("records the guarantees of the session that started, not the adapter's declaration", async () => {
    const session = new FakeSession();
    const recorded = await recordOf(session, (id) => (id === "claude" ? declared : undefined));

    expect(recorded).toMatchObject({ mode: "hosted", guarantees: session.guarantees, guarantees_unverified: true, harness_version_assessment: { status: "unknown" } });
    expect(recorded?.guarantees).toMatchObject({ steer: false, gating: "static" });
  });

  it("records the harness version it saw, and marks guarantees shown on another build unverified", async () => {
    const recorded = await recordOf(new FakeSession({ harnessVersion: "2.1.300" }), () => declared);

    expect(recorded).toMatchObject({ vendor_version: "2.1.300", guarantees_unverified: true });
  });

  it("does not mark guarantees unverified on the build they were shown on", async () => {
    const recorded = await recordOf(new FakeSession({ harnessVersion: "2.1.282" }), () => declared);

    expect(recorded).toMatchObject({ vendor_version: "2.1.282" });
    expect(recorded).toHaveProperty("guarantees_unverified", false);
  });

  it("records what the session reports even when the record declares no such mode", async () => {
    // The session knows what it is; the record only says which build its
    // guarantees were shown on, and there is nothing to compare against here.
    const session = new FakeSession({ harnessVersion: "2.1.300" });
    const claude = describeShipped("claude")!;
    const recorded = await recordOf(session, () => ({ ...claude, modes: { ...claude.modes, hosted: null } }));

    expect(recorded).toEqual({ mode: "hosted", guarantees: session.guarantees, vendor_version: "2.1.300" });
  });
});

describe("SessionRuntime taking over a conversation a TUI ran", () => {
  afterEach(() => {
    vi.mocked(getSessionRecord).mockImplementation(async id => dbRows.get(id) as never);
    vi.mocked(getProviderSessionsBySession).mockResolvedValue([]);
  });

  /** Start a stored session whose conversation is recorded, as a message to it does once its TUI has gone. */
  async function takeOver(storedMode: string) {
    vi.mocked(getSessionRecord).mockResolvedValue({ id: "sess-tui", bags: [], bounds: [], bound: null, metadata: { mode: storedMode }, identity_id: null } as never);
    vi.mocked(getProviderSessionsBySession).mockResolvedValue([{ provider: "claude", provider_session_id: "conv-tui" }] as never);
    vi.mocked(updateSessionMetadata).mockClear();
    const session = new FakeSession();
    const createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig, _options?: { adopt?: boolean }) => session);

    const manager = new SessionRuntime({ createSession });
    await manager.startSession(baseConfig({ sessionId: "sess-tui", provider: "claude" }));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(vi.mocked(updateSessionMetadata).mock.calls.some(([, fields]) => (fields as Record<string, unknown>).mode !== undefined)).toBe(true),
    );
    session.end();

    const call = createSession.mock.calls[0];
    if (!call) throw new Error("no session was created");
    const [, config, options] = call;
    const recorded = vi.mocked(updateSessionMetadata).mock.calls
      .map(([, fields]) => fields as Record<string, unknown>)
      .find((fields) => fields.mode !== undefined);
    return { config, options, recorded };
  }

  it("opens a guest session's conversation through the harness's adopt, and records where it came from", async () => {
    const { config, options, recorded } = await takeOver("guest");

    expect(config.resume).toEqual({ harnessSessionId: "conv-tui" });
    expect(options).toEqual({ adopt: true });
    expect(recorded).toMatchObject({ mode: "hosted", adopted_from: "guest" });
  });

  it("resumes a session that was already hosted without adopting it", async () => {
    const { config, options, recorded } = await takeOver("hosted");

    expect(config.resume).toEqual({ harnessSessionId: "conv-tui" });
    expect(options).toBeUndefined();
    expect(recorded).not.toHaveProperty("adopted_from");
  });
});

it("passes native read tools to the hosted harness and its decide function", async () => {
  const installed = describeShipped("claude")!;
  const record = { ...installed, modes: { ...installed.modes, hosted: { ...installed.modes.hosted!, native: { controllable: ["Read", "Glob", "Grep"] } } } };
  const session = new FakeSession();
  const createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => session);
  setAgentRuntime({ createSession, runStructured: vi.fn(), describeAdapter: () => record });
  const manager = new SessionRuntime({ createSession });
  try {
    await manager.startSession(baseConfig({ provider: "claude" }));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled());
    const config = createSession.mock.calls[0][1];
    expect(config.allowedNativeTools).toEqual(["Read", "Glob", "Grep"]);
    expect(config.deniedTools).toContain("Bash");
    expect(config.deniedTools).not.toContain("Read");
    expect(await config.decide!({ id: "read", tool: "Read", input: {} })).toEqual({ allow: true });
    expect(await config.decide!({ id: "shell", tool: "Bash", input: {} })).toMatchObject({ allow: false });
  } finally { session.end(); wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() }); }
});

it("refuses admission when a bound takes back an uncontrolled native tool", async () => {
  const installed = describeShipped("cursor")!;
  const record = { ...installed, modes: { ...installed.modes, hosted: { ...installed.modes.hosted!, native: {
    controllable: [], uncontrolled: { Grep: "cursor runs Grep without a permission request" },
  } } } };
  const createSession = vi.fn();
  setAgentRuntime({ createSession, runStructured: vi.fn(), describeAdapter: () => record });
  const manager = new SessionRuntime({ createSession });
  try {
    await expect(manager.startSession(baseConfig({ provider: "cursor", bounds: [{ files: { deny: [".env"] } }], prepareOnly: true }))).rejects.toThrow(/cannot take back Grep.*without a permission request/);
    expect(createSession).not.toHaveBeenCalled();
  } finally {
    wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() });
  }
});

describe("sandbox requirements at session admission", () => {
  const sandboxBound: Bound = { network: { enforce: "sandbox" as const, allow: ["github.com"] } };
  it("refuses an unsupported harness before opening it, including prepare-only admission", async () => {
    const createSession = vi.fn();
    const manager = new SessionRuntime({ createSession });
    await expect(manager.startSession(baseConfig({ provider: "codex", bounds: [sandboxBound], prepareOnly: true }))).rejects.toThrow("cannot enforce");
    expect(createSession).not.toHaveBeenCalled();
  });
  it("accepts a supported hosted provider without opening a prepare-only harness", async () => {
    const createSession = vi.fn();
    const manager = new SessionRuntime({ createSession });
    const active = await manager.startSession(baseConfig({ provider: "claude", bounds: [sandboxBound], prepareOnly: true }));
    expect(manager.getActiveSession(active.id)).toBe(active);
    expect(createSession).not.toHaveBeenCalled();
    await manager.removeSession(active.id);
  });
});

describe("hosted approval capability reporting", () => {
  it.each([["antigravity", false], ["claude", true]] as const)("reports the declared hosted mode for %s", async (provider, gating) => {
    const manager = new SessionRuntime({ createSession: vi.fn() });
    const active = await manager.startSession(baseConfig({ provider, prepareOnly: true }));
    const frames: Array<{ type: string; capabilities?: { gating: boolean } }> = [];
    const socket = { readyState: 1, send: (value: string) => { frames.push(JSON.parse(value)); } };
    try {
      manager.subscribe(active.id, socket);
      await vi.waitFor(() => expect(frames.find(frame => frame.type === "subscribed")?.capabilities?.gating).toBe(gating));
    } finally { manager.unsubscribe(active.id, socket); await manager.removeSession(active.id); }
  });
});

it("replays prior history into a prepared session without a resumable provider id", async () => {
  const { buildSessionHistoryContext } = await import("./db.js");
  vi.mocked(buildSessionHistoryContext).mockResolvedValueOnce("prior conversation");
  const session = Object.assign(new FakeSession(), { warm: async () => {} });
  const manager = new SessionRuntime({ createSession: vi.fn(async () => session) });
  const active = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
  active.lastSequence = 2;
  await manager.warmHarness(active.id);
  await manager.sendMessage(active.id, "continue");
  await vi.waitFor(() => expect(session.delivered).toHaveLength(1));
  expect(session.delivered[0]).toContain("prior conversation");
  session.end();
  await vi.waitFor(() => expect(active.status).toBe("waiting"));
  await manager.removeSession(active.id);
});
it("reports a warm hit when the first message waits for initialization", async () => {
  let finish!: () => void;
  const session = Object.assign(new FakeSession(), { isWarm:()=>true, warm: () => new Promise<void>(resolve => { finish = resolve; }) });
  const manager = new SessionRuntime({ createSession: vi.fn(async () => session) });
  const active = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
  const warming = manager.warmHarness(active.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await manager.sendMessage(active.id, "hello");
  finish(); await warming;
  await vi.waitFor(() => expect(session.delivered).toHaveLength(1));
  expect(active.timings.warm_hit).toBe(1);
  session.end(); await vi.waitFor(() => expect(active.status).toBe("waiting"));
  await manager.removeSession(active.id);
});
it("keeps an accepted first message queued through a tools change during warm", async () => {
  let finishWarm!: () => void;
  let releaseSlot!: (lease: { release(): void }) => void;
  const old = Object.assign(new FakeSession(), { warm: () => new Promise<void>(resolve => { finishWarm = resolve; }) });
  const fresh = new FakeSession();
  const create = vi.fn().mockResolvedValueOnce(old).mockResolvedValue(fresh);
  const manager = new SessionRuntime({ createSession: create });
  const active = await manager.startSession(baseConfig({ prepareOnly: true, prompt: "" }));
  vi.spyOn(manager, "acquireTurnSlot").mockImplementationOnce(() => new Promise(resolve => { releaseSlot = resolve; }));
  const warming = manager.warmHarness(active.id);
  await vi.waitFor(() => expect(finishWarm).toBeTypeOf("function"));
  await manager.sendMessage(active.id, "deliver this");
  await vi.waitFor(() => expect(releaseSlot).toBeTypeOf("function"));
  const generation = active.generation;
  manager.invalidateSessionTools(active.id);
  expect(active.generation).toBe(generation);
  finishWarm(); await warming;
  releaseSlot({ release() {} });
  await vi.waitFor(() => expect(fresh.delivered).toHaveLength(1));
  expect(fresh.delivered[0]).toContain("deliver this");
  expect(old.delivered).toEqual([]);
  fresh.end(); await vi.waitFor(() => expect(active.status).toBe("waiting"));
  await manager.removeSession(active.id);
});

it("broadcasts and replays thinking before text without recording it", async () => {
  const manager=new SessionRuntime();
  const active=await manager.startSession(baseConfig({prepareOnly:true,prompt:""}));
  const first={readyState:1,send:vi.fn()};manager.subscribe(active.id,first);
  const {appendMessage}=await import("./db.js");const before=vi.mocked(appendMessage).mock.calls.length;
  await manager.handleRunnerEvent(active,{type:"thinking",content:"summary"});
  await vi.waitFor(()=>expect(first.send.mock.calls.map(([s])=>JSON.parse(s))).toContainEqual(expect.objectContaining({type:"thinking",content:"summary"})));
  expect(vi.mocked(appendMessage).mock.calls.length).toBe(before);
  const second={readyState:1,send:vi.fn()};manager.subscribe(active.id,second);
  expect(second.send.mock.calls.map(([s])=>JSON.parse(s).type)).toEqual(["subscribed","thinking"]);
  await manager.handleRunnerEvent(active,{type:"partial",content:"answer"});
  expect(active.thinkingBuffer).toBe("");
  await manager.removeSession(active.id);
});

it("closes a failed warm handle and delivers the first turn on a fresh harness",async()=>{
 const failed=Object.assign(new FakeSession(),{warm:async()=>{throw Error("initialization timed out");}});
 const closed=vi.spyOn(failed,"close");const fresh=new FakeSession();
 const manager=new SessionRuntime({createSession:vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(fresh)});
 const active=await manager.startSession(baseConfig({prepareOnly:true,prompt:""}));
 await manager.warmHarness(active.id);expect(closed).toHaveBeenCalled();expect(active.session).toBeNull();
 await manager.sendMessage(active.id,"first turn");await vi.waitFor(()=>expect(fresh.delivered).toContain("first turn"));
 fresh.end();await vi.waitFor(()=>expect(active.status).toBe("waiting"));await manager.removeSession(active.id);
});
it("keeps the conversation on grant changes and reports an idle released process as cold",async()=>{
 const session=Object.assign(new FakeSession(),{warm:async()=>{},isWarm:()=>false});const closed=vi.spyOn(session,"close");
 const manager=new SessionRuntime({createSession:vi.fn(async()=>session)});
 const active=await manager.startSession(baseConfig({prepareOnly:true,prompt:""}));await manager.warmHarness(active.id);
 manager.invalidateSessionTools(active.id,{reason:"grants"});expect(active.session).toBe(session);expect(closed).not.toHaveBeenCalled();
 await manager.sendMessage(active.id,"resume");await vi.waitFor(()=>expect(session.delivered).toContain("resume"));expect(active.timings.warm_hit).toBe(0);
 session.end();await vi.waitFor(()=>expect(active.status).toBe("waiting"));await manager.removeSession(active.id);
});

it("re-prepares a released process even when an old prepare stamp remains",async()=>{
 let linked=false;const warm=vi.fn(async()=>{linked=true;});const session=Object.assign(new FakeSession(),{warm,isWarm:()=>linked});
 const manager=new SessionRuntime({createSession:vi.fn(async()=>session)});const active=await manager.startSession(baseConfig({prepareOnly:true,prompt:""}));
 await manager.warmHarness(active.id);expect(warm).toHaveBeenCalledTimes(1);linked=false;
 await manager.warmHarness(active.id);expect(warm).toHaveBeenCalledTimes(2);expect(active.warm?.preparedAt).toBeTypeOf("number");await manager.removeSession(active.id);
});

it.each(["acknowledges", "hangs"])("forces an interrupt when the adapter %s but never ends its reader",async(kind)=>{
 vi.stubEnv("BARRY_INTERRUPT_DEADLINE_MS","50");
 const first=new FakeSession();first.interrupt=kind==="hangs"?()=>new Promise(()=>{}):async()=>{};
 const second=new FakeSession();const create=vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
 const manager=new SessionRuntime({createSession:create,limits:{maxConcurrentTurns:1,maxResidentSessions:5}});
 try {
  const active=await manager.startSession(baseConfig());
  await vi.waitFor(()=>expect(first.delivered).toHaveLength(1));
  const frames:Array<{ metadata?: { code?: string }; content?: string }>=[];manager.subscribe(active.id,{readyState:1,send:data=>frames.push(JSON.parse(String(data)))});
  const start=performance.now();expect(await manager.interruptTurn(active.id)).toBe(true);
  expect(performance.now()-start).toBeLessThan(1000);
  expect(active.session).toBeNull();expect(first.closeCalls).toBe(1);
  expect(frames.filter(frame=>frame.metadata?.code==="turn_forced")).toHaveLength(1);
  const next=manager.sendMessage(active.id,"after force");
  await vi.waitFor(()=>expect(second.delivered).toHaveLength(1));
  first.push({type:"text",role:"assistant",text:"late"});first.end();
  expect(frames.some(frame=>frame.content==="late")).toBe(false);
  second.end();await next;await active.lastTurn;await manager.removeSession(active.id);
 }finally{vi.unstubAllEnvs();first.end();second.end();}
});

it("releases a stopped resident while recording drains and refuses reopen without ending its queued transcript",async()=>{
 const {PersistQueue}=await import("./runtime/persist-queue.js");
 const manager=new SessionRuntime();const active=await manager.startSession(baseConfig({prepareOnly:true,prompt:""}));
 let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
 active.persistence=new PersistQueue(()=>{});active.persistence.enqueue({type:"text",sessionId:active.id,sequence:0,content:"accepted"},8,()=>blocked);
 const ended=vi.mocked(endSession).mock.calls.length;
 const frames:Array<{ metadata?: { code?: string }; content?: string }>=[];manager.subscribe(active.id,{readyState:1,send:data=>frames.push(JSON.parse(String(data)))});
 try{
  await manager.stopSession(active.id);
  expect(manager.getActiveSession(active.id)).toBeUndefined();
  expect(manager.pendingPersistence(active.id)).toHaveLength(1);
  expect(await manager.flushPersistence(active.id,5)).toBe(false);
  await expect(manager.startSession(baseConfig({sessionId:active.id,prepareOnly:true}))).rejects.toThrow("Recording delayed");
  expect(vi.mocked(endSession).mock.calls).toHaveLength(ended);
 }finally{release();}
 await vi.waitFor(()=>expect(manager.drainingSessions.has(active.id)).toBe(false));
 expect(vi.mocked(endSession).mock.calls).toHaveLength(ended+1);
 expect(frames.some(frame=>frame.metadata?.code==="persistence_recovered")).toBe(true);
});
it("force during a silent warm detaches its promise so the next message opens fresh",async()=>{
 vi.stubEnv("BARRY_INTERRUPT_DEADLINE_MS","50");
 const first=Object.assign(new FakeSession(),{warm:()=>new Promise<void>(()=>{})});const second=new FakeSession();
 const create=vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);const manager=new SessionRuntime({createSession:create});
 const active=await manager.startSession(baseConfig({prepareOnly:true,prompt:""}));void manager.warmHarness(active.id);
 await vi.waitFor(()=>expect(active.session).toBe(first));await manager.sendMessage(active.id,"queued during warm");
 await vi.waitFor(()=>expect(active.abortController).not.toBeNull());
 try{
  await manager.interruptTurn(active.id);expect(active.warming).toBeNull();
  const next=manager.sendMessage(active.id,"fresh after warm stop");await vi.waitFor(()=>expect(second.delivered).toHaveLength(1));second.end();await next;await active.lastTurn;await manager.removeSession(active.id);
 }finally{vi.unstubAllEnvs();second.end();}
});
