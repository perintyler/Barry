import { PersistQueue } from "./runtime/persist-queue.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Session-start coordination and cold-start persistence (code review F4, F5,
 * and the session-runtime half of F6).
 *
 * A separate file from session-runtime.test.ts on purpose: that suite mocks
 * `shouldPersist` to false and `getSessionRecord` to undefined, so it can
 * neither observe a persisted user turn nor exercise the "start an EXISTING
 * session" path both defects live on. Here persistence is ON and
 * `getSessionRecord` returns a row, with `appendMessage` recording every
 * call so the assertions look at what would actually reach the database.
 */


// ---- Module mocks -----------------------------------------------------------
// session-runtime.ts reaches a wide dependency surface before activeSessions.set()
// — DB writes, identity resolution, bag/skill loading, worktree setup. None of
// it is under test here (ResidentBudget/TurnSemaphore's own logic is covered
// standalone in execution-admission.test.ts); these mocks exist only to let
// startSession reach the map write quickly and deterministically.

let sessionCounter = 0;

/** Every persisted event, in the order appendMessage was CALLED. */
const persistCalls: Array<{ sessionId: string; message: Record<string, unknown> }> = [];
/** Every persisted event, in the order appendMessage actually COMPLETED. */
const persistCompletions: string[] = [];
/** Per-type artificial latency, used to make an out-of-order write observable. */
const persistDelayByType = new Map<string, number>();

/** The fake store: each session's highest sequence, and every row, in insert order. */
const sequences = new Map<string, number>();
const rows: Array<{ sessionId: string; type: string; content?: unknown; sequence: number }> = [];

// Unlike session-runtime.test.ts, an existing session RESOLVES here — starting
// one by id is the whole subject of these tests.
const stored = vi.hoisted(() => (id: string) => ({
  id,
  system_prompt: "stored prompt",
  bags: [],
  bounds: [],
  bound: null,
  metadata: { working_directory: "/repo" },
  identity_id: null,
}));

vi.mock("./db.js", () => ({
  createNamedSession: vi.fn(async (input: Record<string, unknown>) => ({
    id: `session-db-id-${++sessionCounter}`,
    system_prompt: input.system_prompt,
    bags: input.bags ?? [],
    bounds: input.bounds ?? [],
    bound: input.bound ?? null,
    metadata: input.metadata ?? {},
    identity_id: input.identity_id ?? null,
  })),
  updateSessionRecord: vi.fn(async () => undefined),
  updateSessionMetadata: vi.fn(async () => undefined),
  getSessionRecord: vi.fn(async (id: string) => stored(id)),
  listSessionRecords: vi.fn(async () => []),
  lastMessageSequence: vi.fn(async (id: string) => sequences.get(id) ?? -1),
  // Persistence ON — the manager suite disables it, which is exactly why the
  // missing cold-start user turn was never noticed there.
  shouldPersist: vi.fn((type: string) =>
    ["text", "tool_start", "tool_result", "error", "init", "result", "summary"].includes(type),
  ),
  // Numbers a row as its insert runs (after the latency), one past the
  // session's highest, as the store does: an append that was overtaken is
  // numbered after the one that overtook it.
  appendMessage: vi.fn(async (sessionId: string, message: Record<string, unknown>) => {
    persistCalls.push({ sessionId, message: { ...message } });
    const delay = persistDelayByType.get(String(message.type)) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    persistCompletions.push(String(message.type));
    // Folded into its call's row: nothing of its own is stored.
    if (message.type === "tool_result") return null;
    const sequence = Math.max(typeof message.sequence === "number" ? message.sequence : 0,(sequences.get(sessionId) ?? -1) + 1);
    sequences.set(sessionId, sequence);
    rows.push({ sessionId, type: String(message.type), content: message.content, sequence });
    return sequence;
  }),
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
    row: vi.fn(async (id: number) => ({ id, name: "fixture", metadata: {} })),
    config: vi.fn(() => ({ env: {}, vault: null, bags: [], bounds: [] })),
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
  parseSessionMetadata: vi.fn((m: unknown) => m ?? {}),
}));

// process-liveness lives in the sessions bag, so it is mocked there. Under any
// other specifier this entry would be a SILENT NO-OP and the runtime would
// call the real classifier against this machine's process table.
vi.mock("@barry-rocks/sessions-bag/process-liveness", () => ({
  classify: vi.fn(() => ({ state: "unknown" })),
  readProcessStartTime: vi.fn((pid: number) => (pid === GONE_PID ? null : 1_000)),
}));
/** A launcher pid with no process behind it. */
const GONE_PID = 999_999;

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: vi.fn(async (id: string) => stored(id)),
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

vi.mock("./mcp-config.js", () => ({
  buildMcpConfig: vi.fn(async () => ({})),
}));

vi.mock("./session-prose.js", () => ({
  applyProsePrefix: vi.fn((_provider: string, _prose: unknown, prompt: string, sent: boolean) => ({
    prompt,
    sent,
  })),
}));

vi.mock("@barry-rocks/sdk/bounds", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/bounds")>(),
  ...(await vi.importActual<Record<string, unknown>>("@barry-rocks/sdk/bounds")),
  mergeBounds: vi.fn(() => ({})),
  boundHasContent: vi.fn(() => false),
}));


import { SessionRuntime, type SessionConfig } from "./session-runtime.js";
import type { CreateSessionFn } from "./agent-runtime-types.js";
import type { SessionConfig as HarnessSessionConfig } from "@barry-rocks/sdk/sessions";
import { FakeSession } from "./test-helpers/fake-session.js";
import { wireShippedHarnesses } from "./test-helpers/shipped-harnesses.js";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";

beforeEach(() => {
  wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() });
  Barry.use(fakeIdentities({
    bound: async () => null,
    tools: async () => [],
  }));
});
afterEach(async () => { await PersistQueue.drainAll(2000); Barry.reset(); });

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { prompt: "hello", repoPath: "/repo", ...overrides };
}

function userTurns(sessionId: string): string[] {
  return persistCalls
    .filter((c) => c.sessionId === sessionId && c.message.type === "text" && c.message.role === "user")
    .map((c) => String(c.message.content));
}

describe("concurrent starts for one session (code review F4)", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    persistCalls.length = 0;
    persistCompletions.length = 0;
    persistDelayByType.clear();
    sequences.clear();
    rows.length = 0;
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("two starts for the SAME id produce one active session and deliver BOTH messages", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 5 } });
    const sessionId = "shared-session-id";

    // The reproduction: both calls enter startSession before either finishes.
    const [a, b] = await Promise.all([
      manager.startSession(baseConfig({ sessionId, prompt: "request A" })),
      manager.startSession(baseConfig({ sessionId, prompt: "request B" })),
    ]);

    // One session object, not two competing ones under the same id.
    expect(a).toBe(b);
    expect(manager.getActiveSession(sessionId)).toBe(a);
    expect(manager.getActiveSessionCount()).toBe(1);

    // Against the defect: the second start replaced the first in the map, the
    // first's turn failed isStale's map-identity check, and request A was
    // never sent anywhere — one provider session was created and only request
    // B ever reached it.
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    await vi.waitFor(() => expect(sessions[0].delivered.join("\n")).toContain("request A"));

    // B's turn is correctly SERIALIZED behind A's on the session's turnQueue,
    // so it only reaches the provider once A's stream ends. End it, then
    // require B to actually arrive — a "both eventually delivered" assertion
    // that never ended A would have been satisfiable by A alone.
    sessions[0].end();
    await vi.waitFor(() => expect(sessions[0].delivered.join("\n")).toContain("request B"));

    // Exactly one provider session for the two starts — not two.
    expect(sessions).toHaveLength(1);

    // And both user turns are on the transcript, in arrival order.
    expect(userTurns(sessionId)).toEqual(["request A", "request B"]);

    for (const s of sessions) s.end();
  });

  it("capacity is fully released after a coordinated double start, so the budget does not leak", async () => {
    // Cap of 1: the ONLY way a second start can be admitted after stopping is
    // if the first start left no orphaned reservation behind.
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 1, maxConcurrentTurns: 5 } });
    const sessionId = "budget-session-id";

    await Promise.all([
      manager.startSession(baseConfig({ sessionId, prompt: "first" })),
      manager.startSession(baseConfig({ sessionId, prompt: "second" })),
    ]);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    for (const s of sessions) s.end();

    await manager.stopSession(sessionId);

    // Against the defect: two commits, one releaseById — the second
    // reservation stayed committed forever and this start threw
    // AdmissionError("resident_budget") with zero sessions active.
    expect(manager.getActiveSessionCount()).toBe(0);
    const reused = await manager.startSession(baseConfig({ sessionId: "another-session", prompt: "after stop" }));
    expect(reused).toBeDefined();
    await vi.waitFor(() => expect(sessions.length).toBeGreaterThanOrEqual(2));
    for (const s of sessions) s.end();
  });

  it("starts for DIFFERENT ids are still independent (control: coordination is per session)", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 5 } });
    const [a, b] = await Promise.all([
      manager.startSession(baseConfig({ sessionId: "id-one", prompt: "one" })),
      manager.startSession(baseConfig({ sessionId: "id-two", prompt: "two" })),
    ]);
    expect(a).not.toBe(b);
    expect(manager.getActiveSessionCount()).toBe(2);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    for (const s of sessions) s.end();
  });
});

describe("cold-start user messages are persisted (code review F5)", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    persistCalls.length = 0;
    persistCompletions.length = 0;
    persistDelayByType.clear();
    sequences.clear();
    rows.length = 0;
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("starting an existing (stopped/draft/absent) session records its user turn", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const sessionId = "cold-start-session";

    await manager.startSession(baseConfig({ sessionId, prompt: "fix the login bug" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    // Against the defect: the prompt went straight into the provider call and
    // produced no user-message event at all — missing from transcript history,
    // from search, and from the next cold start's DB-built context.
    expect(userTurns(sessionId)).toEqual(["fix the login bug"]);
    for (const s of sessions) s.end();
  });

  it("a newly created session records its initial user turn too", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const created = await manager.startSession(baseConfig({ prompt: "brand new request" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(userTurns(created.id)).toEqual(["brand new request"]);
    for (const s of sessions) s.end();
  });

  it("the cold turn is recorded once, and a warm follow-up adds exactly one more", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5, maxConcurrentTurns: 5 } });
    const sessionId = "cold-then-warm";

    await manager.startSession(baseConfig({ sessionId, prompt: "cold turn" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].end();

    await vi.waitFor(() => expect(manager.getActiveSession(sessionId)?.status).toBe("waiting"));
    const warm = manager.sendMessage(sessionId, "warm turn");
    await vi.waitFor(() => expect(manager.getActiveSession(sessionId)?.status).toBe("streaming"));
    sessions[0].end();
    await warm;

    // No duplicate cold row, and the warm path unchanged.
    expect(userTurns(sessionId)).toEqual(["cold turn", "warm turn"]);
  });
});

describe("per-session persistence ordering (code review F6, session-runtime half)", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    persistCalls.length = 0;
    persistCompletions.length = 0;
    persistDelayByType.clear();
    sequences.clear();
    rows.length = 0;
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("a slow tool_start still COMPLETES before its tool_result begins", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const sessionId = "ordering-session";
    await manager.startSession(baseConfig({ sessionId, prompt: "go" }));
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    // A tool_start resolves a model and inserts a row; a tool_result only
    // reads and updates. Modeling that asymmetry is what turns "fired
    // concurrently" into an observably wrong write order.
    persistDelayByType.set("tool_start", 40);

    sessions[0].push({ type: "tool_use", id: "tu-1", tool: "Bash", input: { command: "ls" } });
    sessions[0].push({ type: "tool_result", id: "tu-1", result: "ok" });
    sessions[0].end();

    await vi.waitFor(() => {
      expect(persistCompletions).toContain("tool_start");
      expect(persistCompletions).toContain("tool_result");
    });

    // Against the defect: the un-chained calls overlapped and tool_result
    // completed FIRST, reaching its correlation lookup with no row to match.
    expect(persistCompletions.indexOf("tool_start")).toBeLessThan(
      persistCompletions.indexOf("tool_result"),
    );
  });
});

/** A subscriber that keeps everything it is sent. */
function listener(): { readyState: number; send: (data: string) => void; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)), sent };
}

describe("persist, then advertise", () => {
  let sessions: FakeSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    persistCalls.length = 0;
    persistCompletions.length = 0;
    persistDelayByType.clear();
    sequences.clear();
    rows.length = 0;
    createSession = vi.fn(async (_harness: string, _config: HarnessSessionConfig) => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    });
  });

  it("publishes resident-allocated sequences before recording and persists them unchanged", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const sessionId = "advertised-session";
    // History, as a restarted session has.
    sequences.set(sessionId, 41);
    await manager.startSession(baseConfig({ sessionId, prompt: "go" }));
    const ws = listener();
    manager.subscribe(sessionId, ws);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    // Another process appends to the session meanwhile (a hook, the CLI):
    // the runtime cannot know, and must not guess, what comes next.
    await vi.waitFor(() => expect(sequences.get(sessionId)).toBe(42));
    // Resident owns allocation; other writers must route through it.

    sessions[0].push({ type: "text", text: "looking" });
    sessions[0].push({ type: "tool_use", id: "tu-1", tool: "Bash", input: { command: "ls" } });
    sessions[0].push({ type: "tool_result", id: "tu-1", result: "ok" });
    sessions[0].push({ type: "result", result: "done" });
    sessions[0].end();
    await vi.waitFor(() => expect(ws.sent.map((m) => m.type)).toContain("result"));

    // The handshake waited for the user turn broadcast before it, and reports it.
    expect(ws.sent[0]).toMatchObject({ type: "subscribed", sequence: 42 });
    const advertised = ws.sent.filter((m) => m.type !== "subscribed" && m.sequence !== undefined).map((m) => [m.type, m.sequence]);
    expect(await manager.flushPersistence(sessionId)).toBe(true);
    const stored = rows.filter((r) => r.sessionId === sessionId && r.sequence > 42).map((r) => [r.type, r.sequence]);
    expect(await manager.flushPersistence(sessionId)).toBe(true);
    expect(advertised).toEqual([["text", 43], ["tool_start", 44], ["result", 45]]);
    expect(advertised).toEqual(stored);
    // A result is folded into its call's row, so it is sent with no sequence
    // of its own, as every message the store does not keep is.
    expect(ws.sent.find((m) => m.type === "tool_result")).not.toHaveProperty("sequence");
  });

  it("recovers published sequences when another process appends meanwhile",async()=>{
    const manager=new SessionRuntime({createSession});const id="foreign-writer";
    sequences.set(id,41);await manager.startSession(baseConfig({sessionId:id,prompt:"go"}));
    const ws=listener();manager.subscribe(id,ws);
    await vi.waitFor(()=>expect(sessions[0]?.delivered).toHaveLength(1));
    await manager.flushPersistence(id);sequences.set(id,100);
    sessions[0].push({type:"text",role:"assistant",text:"first"});
    sessions[0].push({type:"text",role:"assistant",text:"second"});sessions[0].end();
    await vi.waitFor(()=>expect(ws.sent.filter(frame=>frame.type==="delivery_update")).toHaveLength(2));
    expect(await manager.flushPersistence(id)).toBe(true);
    expect(rows.filter(row=>row.sessionId===id).slice(-2).map(row=>row.sequence)).toEqual([101,102]);
    const mappings=ws.sent.filter(frame=>frame.type==="delivery_update");
    expect(mappings[0]).toMatchObject({metadata:{code:"sequence_reassigned",oldSequence:43,newSequence:101,dedupeKey:expect.any(String)}});
    expect(manager.pendingPersistence(id)).toEqual([]);expect(()=>manager.assertPersistenceAdmission(id)).not.toThrow();
    await manager.removeSession(id);
  });

  it("two appends for one session at once are stored, and sent, in the order they happened", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 5 } });
    const sessionId = "concurrent-session";
    await manager.startSession(baseConfig({ sessionId, prompt: "go" }));
    const ws = listener();
    manager.subscribe(sessionId, ws);
    await vi.waitFor(() => expect(sessions).toHaveLength(1));

    // The first append is slow; the second, broadcast right behind it, is not.
    // Overlapping, the second would be inserted, and numbered, first.
    persistDelayByType.set("tool_start", 40);
    sessions[0].push({ type: "tool_use", id: "tu-1", tool: "Bash", input: { command: "ls" } });
    sessions[0].push({ type: "text", text: "meanwhile" });
    sessions[0].end();
    await vi.waitFor(() => expect(ws.sent.map((m) => m.type)).toContain("text"));
    await vi.waitFor(() => expect(ws.sent).toContainEqual(expect.objectContaining({ type: "status", status: "waiting" })));

    expect(await manager.flushPersistence(sessionId)).toBe(true);
    expect(persistCompletions.slice(-2)).toEqual(["tool_start", "text"]);
    const stored = rows.filter((r) => r.sessionId === sessionId).map((r) => [r.type, r.sequence]);
    expect(stored).toEqual([["text", 0], ["tool_start", 1], ["text", 2]]);
    // On the wire in the store's order, and nothing broadcast after them
    // (the turn's status) overtakes them while they wait for the store.
    const wire = ws.sent.map((m) => [m.type, m.sequence ?? m.status]);
    expect(wire.slice(wire.findIndex(([type]) => type === "tool_start"))).toEqual([["tool_start", 1], ["text", 2], ["status", "waiting"]]);
  });
});

/** A hosted session a TUI can attach to; `typed` drives the turns started from it. */
class AttachableSession extends FakeSession {
  attachments = 0;
  readonly typed = new FakeSession();

  async attach() {
    this.attachments++;
    return { address: "/tmp/engine.sock", harnessSessionId: this.harnessSessionId! };
  }

  detach() {
    if (this.attachments > 0) this.attachments--;
  }

  externalTurns() {
    return this.typed.events();
  }

  override async close() {
    void this.typed.close();
    return super.close();
  }
}

describe("TUIs attached to a hosted session", () => {
  let sessions: AttachableSession[];
  let createSession: CreateSessionFn & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessions = [];
    persistCalls.length = 0;
    persistCompletions.length = 0;
    persistDelayByType.clear();
    sequences.clear();
    rows.length = 0;
    createSession = vi.fn(async () => {
      const s = new AttachableSession();
      sessions.push(s);
      return s;
    });
  });

  async function prepared(manager: SessionRuntime, sessionId: string) {
    return manager.startSession(baseConfig({ sessionId, prompt: "", prepareOnly: true }));
  }

  it("an attach and the first turn racing each other open one harness, which the turn then uses", async () => {
    const manager = new SessionRuntime({ createSession });
    await prepared(manager, "attach-race");
    const [attachment] = await Promise.all([
      manager.attachRenderer("attach-race", process.pid),
      manager.sendMessage("attach-race", "from barry"),
    ]);
    await vi.waitFor(() => expect(sessions[0]?.delivered.join("\n")).toContain("from barry"));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(attachment).toMatchObject({ address: "/tmp/engine.sock", harnessSessionId: sessions[0].harnessSessionId });
    sessions[0].end();
  });

  it("a turn typed in the TUI is recorded with what the person typed and what the agent answered", async () => {
    const manager = new SessionRuntime({ createSession });
    await prepared(manager, "attach-typed");
    await manager.attachRenderer("attach-typed", process.pid);
    const typed = sessions[0].typed;
    typed.push({ type: "text", text: "typed in the terminal", role: "user" });
    typed.push({ type: "text", text: "the answer" });
    typed.push({ type: "result", result: "the answer" });
    typed.end();
    await vi.waitFor(() => expect(persistCalls.some((c) => c.message.type === "result")).toBe(true));
    const texts = persistCalls.filter((c) => c.message.type === "text").map((c) => ({ role: c.message.role, content: c.message.content, source: (c.message.metadata as { source?: string } | undefined)?.source }));
    expect(texts).toEqual([
      { role: "user", content: "typed in the terminal", source: "terminal" },
      { role: "assistant", content: "the answer", source: undefined },
    ]);
  });

  it("an attached session is never evicted for room, and is once its last attachment leaves", async () => {
    const manager = new SessionRuntime({ createSession, limits: { maxResidentSessions: 1 } });
    await prepared(manager, "attach-held");
    manager.getActiveSession("attach-held")!.status = "waiting";
    const first = await manager.attachRenderer("attach-held", process.pid);
    const second = await manager.attachRenderer("attach-held", process.pid);
    expect(sessions[0].attachments).toBe(2);

    await expect(prepared(manager, "attach-newcomer")).rejects.toThrow();
    expect(await manager.detachRenderer("attach-held", first.attachmentId)).toBe(true);
    await expect(prepared(manager, "attach-newcomer")).rejects.toThrow();

    expect(await manager.detachRenderer("attach-held", second.attachmentId)).toBe(true);
    expect(sessions[0].attachments).toBe(0);
    await prepared(manager, "attach-newcomer");
    expect(manager.getActiveSession("attach-held")).toBeUndefined();
  });

  it("detaching twice detaches once", async () => {
    const manager = new SessionRuntime({ createSession });
    await prepared(manager, "attach-twice");
    const { attachmentId } = await manager.attachRenderer("attach-twice", process.pid);
    expect(await manager.detachRenderer("attach-twice", attachmentId)).toBe(true);
    expect(await manager.detachRenderer("attach-twice", attachmentId)).toBe(false);
    expect(sessions[0].attachments).toBe(0);
  });

  it("a launcher that died without detaching frees its attachment", async () => {
    let running = true;
    const manager = new SessionRuntime({ createSession, launcherRunning: () => running, launcherCheckMs: 5 });
    await prepared(manager, "attach-orphan");
    await manager.attachRenderer("attach-orphan", process.pid);
    running = false;
    await vi.waitFor(() => expect(sessions[0].attachments).toBe(0));
    expect(manager.getActiveSession("attach-orphan")!.renderers.size).toBe(0);
  });

  it("is refused, holding nothing, when the launcher is gone or the harness has no TUI to attach", async () => {
    const manager = new SessionRuntime({ createSession });
    await prepared(manager, "attach-gone");
    await expect(manager.attachRenderer("attach-gone", GONE_PID)).rejects.toThrow(/not running/);
    expect(createSession).not.toHaveBeenCalled();

    const plain = new SessionRuntime({ createSession: vi.fn(async () => new FakeSession()) });
    await prepared(plain, "attach-plain");
    await expect(plain.attachRenderer("attach-plain", process.pid)).rejects.toThrow(/no TUI that can attach/);
    expect(plain.getActiveSession("attach-plain")!.renderers.size).toBe(0);
  });

  it("keeps the engine through a tools change while attached, and reopens once the TUI leaves", async () => {
    const manager = new SessionRuntime({ createSession });
    await prepared(manager, "attach-tools");
    const { attachmentId } = await manager.attachRenderer("attach-tools", process.pid);
    manager.invalidateSessionTools("attach-tools");
    expect(sessions[0].closeCalls).toBe(0);
    await manager.detachRenderer("attach-tools", attachmentId);
    expect(sessions[0].closeCalls).toBe(1);
  });
});

it("seeds the allocator before a concurrent POST can see the resident",async()=>{
 const {lastMessageSequence}=await import("./db.js");let finish!:(value:number)=>void;
 vi.mocked(lastMessageSequence).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const manager=new SessionRuntime({createSession:async()=>new FakeSession()});const id="seed-before-resident";
 const starting=manager.startSession(baseConfig({sessionId:id,prompt:"",prepareOnly:true}));
 await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));expect(manager.getActiveSession(id)).toBeUndefined();
 finish(41);const active=await starting;expect(active.lastSequence).toBe(41);
 manager.broadcastToSession(id,{type:"text",sessionId:id,content:"first live",role:"assistant"});
 expect(active.lastSequence).toBe(42);expect(await manager.flushPersistence(id)).toBe(true);await manager.removeSession(id);
});

it("keeps a pre-recorded cold user row's sequence on its live echo",async()=>{
 const harness=new FakeSession();const manager=new SessionRuntime({createSession:async()=>harness});
 const broadcast=vi.spyOn(manager,"broadcastToSession");const id="reused-user-sequence";sequences.set(id,41);
 const active=await manager.startSession(baseConfig({sessionId:id,prompt:"new prompt",reuseClientMessageRow:true,userMessageSequence:41,initialHistoryContext:"prior history"}));
 expect(broadcast).toHaveBeenCalledWith(id,expect.objectContaining({type:"text",role:"user",sequence:41,reuseClientMessageRow:true}));
 await vi.waitFor(()=>expect(harness.delivered).toHaveLength(1));expect(harness.delivered[0]).toContain("prior history");
 harness.end();await vi.waitFor(()=>expect(active.status).toBe("waiting"));await manager.removeSession(id);
});
