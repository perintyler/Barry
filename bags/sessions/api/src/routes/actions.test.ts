import { describe, expect, it, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounds, identityRecords, traits } from "@barry-rocks/identities-bag";
import { Barry, BarryError } from "@barry-rocks/sdk";
import { fakeIdentities, fakeSessions } from "@barry-rocks/sdk/testing";
import { grantsOver } from "../test-helpers/identity-policy.js";

// Everything the executor touches outside its own logic is mocked at module
// level: catalog lookup, the one-shot agent, the DB rows, and the MCP config.
// The tests exercise the ROUTE's contract (status codes, wrapping, run
// lifecycle), not the collaborators' internals.

vi.mock("@barry-rocks/sdk/logging", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/logging")>(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));


// `action_runs` lives in the actions bag's own SQLite store, so the run
// recorder is mocked at ITS module. Mocking any other path would still
// "succeed" and silently stop intercepting -- the route would hit a real
// SQLite file instead.


// The identities bag, at its root. The trigger resolves an identity before
// creating its session, as the installation's owner (see the identity
// regression test below for why), and stores the row id `rowId` gives it.
// The catalog reads the resolved identity's packed bags to scope itself.
// Explicit caller selections must exist in the trait catalog: the store
// boundary stays synthetic while the real shared policy composition runs
// over it, installed as the identities subject below (see
// test-helpers/identity-policy).
vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  const identityRecords = {
    ...actual.identityRecords,
    resolve: vi.fn(async () => ({ barry: { name: "default" }, source: "default" })),
    rowId: vi.fn(async () => 7),
    config: vi.fn(() => ({ bags: [], traits: [], bounds: [], adapters: {} })),
    row: vi.fn(async (id: number) => ({ id, name: "default", metadata: {} })),
  };
  const bounds = {
    ...actual.bounds,
    stored: vi.fn(async () => [{ id: 3, token: "fixture", name: "readonly", bound: {}, description: null }]),
    get: vi.fn(async (ref: { id: number } | { name: string }) => ("id" in ref ? { id: ref.id, name: "bound", bound: {} } : { id: 1, name: ref.name, bound: {} })),
  };
  const traits = {
    ...actual.traits,
    list: vi.fn(async () => ["coding", "readonly", "barry-trait"].map(name => ({ name, namespaces: [], access: "read" as const, boundNames: [] }))),
  };
  return { ...actual, identityRecords, bounds, traits };
});

// The executor's credentials come from here; the real one reads vault and
// keychain. Mocked so the tests can say exactly which keys the barry holds.
vi.mock("../identity-env.js", () => ({
  IdentityEnvironmentError: class IdentityEnvironmentError extends Error {
    constructor(_identityId: number, reason: string) { super(reason); }
  },
  resolveEnvForBarry: vi.fn(async () => ({ base: { PATH: "/bin", HOME: "/home/test" }, environment: { vars: { ANTHROPIC_API_KEY: "fixture-key", OPENAI_API_KEY: "fixture-openai-key" }, sources: { ANTHROPIC_API_KEY: "keychain" as const, OPENAI_API_KEY: "keychain" as const } }, vars: { PATH: "/bin", HOME: "/home/test" } })),
}));

// The route records which process owns the in-process session it creates.
// Fixed here so the assertion below is about what gets written, not about this
// machine's process table. It lives in the sessions bag; a mock on any other
// specifier would be inert and the test would assert against a real `ps`
// reading.
vi.mock("@barry-rocks/sessions-bag/process-liveness", () => ({
  readProcessStartTime: vi.fn(() => 1_700_000_000),
}));

vi.mock("@barry-rocks/sessions-bag/client", () => {
  const get = vi.fn();
  return {
    Sessions: { create: vi.fn(), end: vi.fn(), createInert: vi.fn(), get },
    Processes: { recordStart: vi.fn(), markEnded: vi.fn(), getLive: vi.fn() },
    getSession: get,
  };
});

// Ad-hoc actions live in the actions bag's own SQLite store. Mocked at its
// module so these route tests never open this machine's real actions.db.


// The native-tool rule is the real one: asserting the executor hands a
// subagent exactly what a session's agent gets is the point. Only the sandbox
// resolver is replaced, because it reads the sessions store and bounds tables.
vi.mock("../session-agent-guards.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-agent-guards.js")>()),
  resolveEgressSandbox: vi.fn(async () => undefined),
  nativeToolPolicy: vi.fn(async () => ({ allowed: [], denied: ["Bash"], refused: {}, uncontrolled: {}, conflicts: {} })),
}));

// One mock per subpath the subject imports. A single vi.mock of the
// "@barry-rocks/sdk/bags" root is a SILENT no-op now that the subject reaches
// modules directly — it would never match and the suite would exercise the
// real loader.
vi.mock("@barry-rocks/sdk/internal/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/actions")>(),
  runActionValidation: vi.fn(),
  runActionPreflight: vi.fn(async () => ({ ok: true })),
  validateActionInputs: vi.fn(),
  findAction: vi.fn(),
  listAllActions: vi.fn(),
}));

vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  expandCompositionFromSnapshot: vi.fn(async (names: readonly string[]) => [...names]),
  loadBagRegistrySnapshot: vi.fn(async () => ({
    bags: [{ name: "web" }, { name: "git" }],
  })),
}));


vi.mock("@barry-rocks/sdk/internal/instructions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/instructions")>(),
  findInstruction: vi.fn(),
}));

// The real instruction builder: it is pure, and it is what tells the spawned
// agent to call begin_action — the mechanism that creates the run row. A stub
// would let the trigger silently start seeding a prompt that records nothing.


vi.mock("../repo-paths.js", () => ({
  validateRepoPath: vi.fn((path: string) =>
    path.startsWith("/") ? { ok: true, path } : { ok: false, error: "not absolute" },
  ),
}));

// Only the two functions with side effects are stubbed. describeActionInvocation
// is pure and is what shapes the recorded input side of a run — stubbing it
// would let that shape drift with nothing noticing.
vi.mock("@barry-rocks/actions-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/actions-bag")>();
  // The real helpers use these same objects inside the bag.
  Object.assign(actual.ActionRuns, {
    create: vi.fn(), get: vi.fn(), list: vi.fn(), complete: vi.fn(),
    finishExecuted: vi.fn(), fail: vi.fn(), cancel: vi.fn(),
  });
  Object.assign(actual.AdhocActions, {
    get: vi.fn(async () => null), list: vi.fn(async () => []), save: vi.fn(),
  });
  return { ...actual, composeActionPrompt: vi.fn(), abandonOrphanedActionRuns: vi.fn(async () => 0) };
});

vi.mock("../mcp-config.js", () => ({
  buildMcpConfig: vi.fn(() => ({
    barry: { type: "http", url: "http://localhost:4901/mcp" },
  })),
}));

vi.mock("../job-runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../job-runs.js")>()),
  acceptJobRun: vi.fn(),
  awaitJobRun: vi.fn(),
  serializeJobRun: vi.fn(),
}));

vi.mock("@barry-rocks/sdk/stores", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/stores")>(),
  sessionIdentity: vi.fn(),
}));
import { sessionIdentity } from "@barry-rocks/sdk/stores";

import { actionsRouter, executeDetached } from "./actions.js";
import { acceptJobRun, awaitJobRun, serializeJobRun } from "../job-runs.js";
import type { CreateSessionFn, RunStructuredFn } from "../agent-runtime-types.js";
import { wireShippedHarnesses, describeShipped } from "../test-helpers/shipped-harnesses.js";
import { IdentityEnvironmentError, resolveEnvForBarry } from "../identity-env.js";
import { abandonOrphanedActionRuns, ActionRuns } from "@barry-rocks/actions-bag";
import { Sessions, Processes } from "@barry-rocks/sessions-bag/client";
import { expandCompositionFromSnapshot } from "@barry-rocks/sdk/internal/bags";
import { runActionValidation, findAction, listAllActions, validateActionInputs } from "@barry-rocks/sdk/internal/actions";

import type { ActionMeta, AdhocActionMeta } from "@barry-rocks/sdk/internal/actions";
import type { ActionRunRecord } from "@barry-rocks/actions-bag";
import { AdhocActions } from "@barry-rocks/actions-bag";
import { nativeToolPolicy, resolveEgressSandbox } from "../session-agent-guards.js";
import { detachedRunSlots, RUN_SLOT_LIMITS } from "../run-slots.js";
import { composeActionPrompt } from "@barry-rocks/actions-bag";


// What the mocked loader hands back. Asserted as the FIRST argument of every
// catalog call below: the route loads the registry and passes it, and a route
// that passed `[]` instead would return an empty catalog that reads exactly
// like "no actions installed".
const REGISTERED_BAGS = [{ name: "web" }, { name: "git" }];

const mockFindAction = vi.mocked(findAction);
// Installed through the injection seam, not vi.mock: the route reads whatever
// the composition root set, so a fake needs no module interception. It also
// means this test exercises the real wiring — a route that forgot to read the
// seam would fail here rather than silently getting the mocked module.
const mockRunStructured = vi.fn<RunStructuredFn>();
const refuse = (what: string): never => {
  throw new Error(`actions routes must not ${what}`);
};
const createSession: CreateSessionFn = () => refuse("start sessions");
// The shipped records and vendor catalog, as the API's boot installs them:
// a bare model id is named under the harness's vendor, and a routed one's key
// is checked against its vendor's credential.
wireShippedHarnesses({ createSession, runStructured: mockRunStructured });
const mockValidateInputs = vi.mocked(validateActionInputs);
const mockCompose = vi.mocked(composeActionPrompt);
const mockValidation = vi.mocked(runActionValidation);
const mockRunsCreate = vi.mocked(ActionRuns.create);
const mockRunsComplete = vi.mocked(ActionRuns.complete);
const mockRunsCancel = vi.mocked(ActionRuns.cancel);
const mockSessionsCreate = vi.mocked(Sessions.create);
const mockSessionsEnd = vi.mocked(Sessions.end);

function actionMeta(overrides: Partial<ActionMeta> = {}): ActionMeta {
  return {
    source: "bag",
    name: "extract-title",
    bag: "web",
    qualifiedName: "web:extract-title",
    dir: "/tmp/actions/extract-title",
    description: "Extract a page title",
    prompt: "Extract the title of ${INPUT.url}",
    requires: { tools: [], secrets: [], bins: [] },
    instructions: [],
    steps: [],
    slashCommand: false,
    scripts: [],
    validate: undefined,
    inputSchema: undefined,
    outputSchema: { type: "string" },
    context: "none",
    legacySkill: false,
    bagAccess: "enabled",
    shadowed: false,
    ...overrides,
    // Overrides here only touch shared fields; asserting the union keeps
    // callers from spelling out which body each fixture has.
  } as ActionMeta;
}

type CallerSession = NonNullable<Awaited<ReturnType<typeof Sessions.get>>>;

// A session that starts a run: a barry, two traits, a named bound and an
// inline one. Every one of these must reach the subagent's row.
function callerSession(overrides: Partial<CallerSession> = {}): CallerSession {
  return {
    id: "caller1",
    active: true,
    state: "open",
    user_id: 1,
    agent_token: null,
    identity_id: 7,
    workflow_credential_id: null,
    status: "running",
    system_prompt: null,
    summary: null,
    traits: ["coding", "readonly"],
    bound: { network: { enforce: "sandbox", allow: ["github.com"] } },
    bounds: ["readonly"],
    bound_id: null,
    metadata: { source: "cli", working_directory: "/work/repo" },
    created_at: "2026-09-29T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    ended_at: null,
    last_message_at: null,
    ...overrides,
  };
}

function runRecord(overrides: Partial<ActionRunRecord> = {}): ActionRunRecord {
  return {
    id: "run_1",
    action: "web:extract-title",
    bag: "web",
    session_id: "sess",
    status: "started",
    summary: null,
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    validated_at: null,
    validation_failures: null,
    output: null,
    output_type: null,
    trigger: null,
    schedule_id: null,
    process: null,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/actions", actionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

afterEach(() => Barry.reset());

// The tools the registered bags declare, which a run's grants are decided
// over: the bash bag's shell, which a raw process needs.
const DECLARED_TOOLS = [{ namespace: "bash", toolName: "Bash", access: "write" as const }];

beforeEach(() => {
  vi.clearAllMocks();
  Barry.use(fakeIdentities({ grants: grantsOver({ identityRecords, traits, bounds }, DECLARED_TOOLS) }));
  mockValidateInputs.mockReturnValue([]);
  mockCompose.mockResolvedValue({ prompt: "COMPOSED PROMPT", warnings: [] });
  mockValidation.mockResolvedValue({ passed: true, failures: [], skipped: true });
  mockRunsCreate.mockResolvedValue(runRecord());
  mockRunsComplete.mockResolvedValue(runRecord({ status: "complete" }));
  mockSessionsCreate.mockResolvedValue(undefined);
  mockSessionsEnd.mockResolvedValue(undefined);
});

function post(name: string, body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/actions/${name}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("a job: action", () => {
  const jobAction = () => ({ ...actionMeta(), prompt: undefined, run: undefined, job: "greet" });

  it("runs as a job run for the calling session, answering with the closed run", async () => {
    vi.mocked(Sessions.get).mockResolvedValue(callerSession());
    mockFindAction.mockResolvedValue(jobAction());
    const oneOff = { id: "sch_7", timeoutS: 120 };
    vi.mocked(acceptJobRun).mockResolvedValue({ oneOff, created: true } as never);
    vi.mocked(awaitJobRun).mockResolvedValue(oneOff as never);
    vi.mocked(serializeJobRun).mockResolvedValue({ id: "sch_7", status: "succeeded", reason: null, runId: "arn_7", output: "{}", outputType: "json" } as never);

    const res = await post("extract-title", { caller_session_id: "caller1", inputs: { url: "u" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: "arn_7", job_run_id: "sch_7", status: "complete", summary: null, output: "{}", output_type: "json" });
    expect(acceptJobRun).toHaveBeenCalledWith({ ref: "web:greet", inputs: { url: "u" }, callerSessionId: "caller1" });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("passes on why a job run was refused", async () => {
    mockFindAction.mockResolvedValue(jobAction());
    vi.mocked(acceptJobRun).mockResolvedValue({ refused: { status: 409, title: "Secrets need bag authority", detail: "declares secrets" } });
    const res = await post("extract-title");
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe("Secrets need bag authority: declares secrets");
  });
});

describe("POST /actions/:name/run", () => {
  it("refuses a device principal before any detached execution side effect", async () => {
    const response = await executeDetached(actionMeta(), {}, [], { kind: "device", credentialId: "fixture-device", actorId: 1, identityIds: [7], scopes: ["actions:dispatch"] });
    expect(response).toMatchObject({ status: 403, body: { error: "device_dispatch_unavailable" } });
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockRunStructured).not.toHaveBeenCalled();
  });
  it("404s an unknown action", async () => {
    mockFindAction.mockResolvedValue(null);

    const res = await post("nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_action" });
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("409s a context: session action", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ context: "session" }));

    const res = await post("extract-title");

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("context_session");
    expect(body.message).toContain("context: session");
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("runs an action with no output_schema for its report, recorded as the summary", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ outputSchema: undefined }));
    mockRunStructured.mockResolvedValue({ data: "Weekly digest: 3 PRs", raw: "" });

    const res = await post("extract-title");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output).toBeNull();
    // The report is the deliverable, but it is not a declared output: it goes
    // to the summary so "output iff declared" still holds.
    expect(mockRunsComplete).toHaveBeenCalledWith("run_1", "Weekly digest: 3 PRs", null, null);
  });

  it("runs a script action without an agent or session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "route-script-"));
    writeFileSync(join(dir, "go.sh"), "echo ran");
    const scriptRun = runRecord({ status: "complete", summary: "Exited 0", output: "ran", output_type: "text", process: { exit_code: 0, duration_ms: 5, log_path: null } });
    mockRunsCreate.mockResolvedValue(runRecord());
    vi.mocked(ActionRuns.finishExecuted).mockResolvedValue(scriptRun);
    const script = actionMeta({ dir, outputSchema: undefined });
    mockFindAction.mockResolvedValue({ ...script, prompt: undefined, job: undefined, run: { command: "bash", args: ["go.sh"] } });

    const res = await post("extract-title", { schedule_id: "ops/nightly" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run_id: "run_1", status: "complete", output: "ran", exit_code: 0 });
    expect(mockRunsCreate).toHaveBeenCalledWith(expect.objectContaining({ trigger: "schedule", schedule_id: "ops/nightly" }));
    expect(mockRunStructured).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [{ caller_session_id: "missing" }, 404, "unknown_caller_session"],
    [{ caller_session_id: "caller1", identity_id: 99 }, 400, "identity_not_allowed"],
    [{ caller_session_id: "caller1", identity: "other" }, 400, "identity_not_allowed"],
    [{ caller_session_id: "caller1", traits: ["admin"] }, 422, "traits_not_held"],
    [{ traits: ["admin"] }, 400, "no_caller_session"],
    [{ cwd: "/tmp" }, 400, "adhoc_only"],
  ])("rejects unauthorized script requests before recording or executing a run: %j", async (request, status, error) => {
    vi.mocked(Sessions.get).mockImplementation(async id => id === "caller1" ? callerSession() : undefined);
    mockFindAction.mockResolvedValue({
      ...actionMeta(), prompt: undefined, job: undefined,
      run: { command: "bash", args: ["-c", "exit 0"] },
    });

    const res = await post("extract-title", request);

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error });
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(ActionRuns.finishExecuted).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockRunStructured).not.toHaveBeenCalled();
  });

  it.each(["read", "readwrite"] as const)("requires a write-capable Bash grant for an unbounded caller (%s)", async access => {
    vi.mocked(Sessions.get).mockResolvedValue(callerSession({ traits: ["selected"], identity_id: null, bound_id: null, bound: null }));
    const selected = [{ name: "selected", description: null, namespaces: ["bash"], access, boundNames: [], tools: [], skills: [], instructions: [], bound: {}, bag: null }];
    vi.mocked(traits.list).mockResolvedValueOnce(selected).mockResolvedValueOnce(selected);
    const dir = mkdtempSync(join(tmpdir(), "route-script-policy-"));
    try {
      writeFileSync(join(dir, "go.sh"), "echo permitted");
      mockFindAction.mockResolvedValue({ ...actionMeta({ dir }), prompt: undefined, job: undefined, run: { command: "bash", args: ["go.sh"] } });
      vi.mocked(ActionRuns.finishExecuted).mockResolvedValue(runRecord({ status: "complete", output: "permitted" }));
      const res = await post("extract-title", { caller_session_id: "caller1" });
      if (access === "read") {
        expect(res.status).toBe(409);
        expect(mockRunsCreate).not.toHaveBeenCalled();
      } else {
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: "complete", output: "permitted" });
        expect(ActionRuns.finishExecuted).toHaveBeenCalledOnce();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a caller's bounded script before creating a run", async () => {
    vi.mocked(Sessions.get).mockResolvedValue(callerSession());
    mockFindAction.mockResolvedValue({ ...actionMeta(), prompt: undefined, job: undefined, run: { command: "bash", args: ["-c", "exit 0"] } });
    const res = await post("extract-title", { caller_session_id: "caller1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "unenforceable_grant" });
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(ActionRuns.finishExecuted).not.toHaveBeenCalled();
  });

  it("resolves an explicitly selected script identity before checking its policy", async () => {
    mockFindAction.mockResolvedValue({ ...actionMeta(), prompt: undefined, job: undefined, run: { command: "bash", args: ["-c", "exit 0"] } });
    const res = await post("extract-title", { identity: "restricted" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "unenforceable_grant" });
    expect(identityRecords.resolve).toHaveBeenCalledWith({ name: "restricted" }, { kind: "owner" });
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("runs a script under an explicitly selected identity with a Bash grant", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce({
      bag_configs: {}, secrets: {}, vault: undefined, traits: [{ name: "writer", optional: false }], bags: [],
      bounds: [], bound: undefined, adapters: {},
      status_notify: undefined,
      bag_grant: "session",
    });
    vi.mocked(traits.list).mockResolvedValueOnce([{ name: "writer", description: null, namespaces: ["bash"], access: "readwrite", boundNames: [], tools: [], skills: [], instructions: [], bound: {}, bag: null }]);
    const dir = mkdtempSync(join(tmpdir(), "route-script-identity-"));
    try {
      writeFileSync(join(dir, "go.sh"), "echo selected");
      mockFindAction.mockResolvedValue({ ...actionMeta({ dir }), prompt: undefined, job: undefined, run: { command: "bash", args: ["go.sh"] } });
      vi.mocked(ActionRuns.finishExecuted).mockResolvedValue(runRecord({ status: "complete", output: "selected" }));
      const res = await post("extract-title", { identity_id: 7 });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "complete", output: "selected" });
      expect(identityRecords.resolve).toHaveBeenCalledWith({ id: 7 }, { kind: "owner" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unresolved selected script identity without launching a process", async () => {
    mockFindAction.mockResolvedValue({ ...actionMeta(), prompt: undefined, job: undefined, run: { command: "bash", args: ["-c", "exit 0"] } });
    vi.mocked(identityRecords.resolve).mockRejectedValueOnce(new BarryError("not_found", "unavailable identity"));
    const res = await post("extract-title", { identity: "missing" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_identity" });
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("422s invalid inputs with the validator's details", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockValidateInputs.mockReturnValue(['Action "extract-title" declares no input named "urk".']);

    const res = await post("extract-title", { inputs: { urk: "x" } });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "invalid_inputs",
      details: ['Action "extract-title" declares no input named "urk".'],
    });
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("runs to 200, handing a string-root schema through for the final message itself", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockResolvedValue({
      data: "The Page Title",
      raw: "The Page Title",
    });

    const res = await post("extract-title", { inputs: { url: "https://x" } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run_id: "run_1",
      status: "complete",
      summary: null,
      output: "The Page Title",
      output_type: "text",
    });

    // A string root is not wrapped: the run takes the final message as the
    // answer, with no fence to write and no retry that redoes the work.
    expect(mockRunStructured).toHaveBeenCalledTimes(1);
    const call = mockRunStructured.mock.calls[0][0];
    expect(call.schema).toEqual({ type: "string" });
    // The composed prompt plus the detached-run trailer — the soft half of
    // the recursion defense (the hard half is run_action's boundary refusal).
    expect(call.prompt).toContain("COMPOSED PROMPT");
    expect(call.prompt).toContain("Do NOT call `run_action`");
    expect(call.config.cwd).toBe("/tmp/actions/extract-title");
    // The MCP url must carry the synthetic session's id so trait filtering
    // grants the bag's tools.
    const barry = call.config.mcpServers?.barry;
    expect(barry && "url" in barry ? barry.url : "").toContain("sessionId=");

    // Session row: created with the owning bag's auto-trait, ended after.
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        traits: ["actions", "web"],
        metadata: expect.objectContaining({
          source: "action-executor",
        }),
      }),
    );
    expect(Processes.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: process.pid,
        pidStartedAt: 1_700_000_000,
        source: "api",
        appName: "api",
      }),
    );
    expect(mockSessionsEnd).toHaveBeenCalledTimes(1);

    // The run closes with the UNWRAPPED string stored as text.
    expect(mockRunsComplete).toHaveBeenCalledWith(
      "run_1",
      "Executed detached",
      null,
      { type: "text", value: "The Page Title" },
    );
  });

  it("keeps object-root schemas unwrapped and stores JSON output", async () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };
    mockFindAction.mockResolvedValue(actionMeta({ outputSchema: schema }));
    mockRunStructured.mockResolvedValue({ data: { title: "T" }, raw: "" });

    const res = await post("extract-title");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output).toBe('{"title":"T"}');
    expect(body.output_type).toBe("json");
    expect(mockRunStructured.mock.calls[0][0].schema).toEqual(schema);
  });

  it("wraps any other root for native enforcement, and unwraps the value", async () => {
    const schema = { type: "array", items: { type: "string" } };
    mockFindAction.mockResolvedValue(actionMeta({ outputSchema: schema }));
    mockRunStructured.mockResolvedValue({ data: { value: ["a", "b"] }, raw: "" });

    const res = await post("extract-title");

    expect(res.status).toBe(200);
    expect((await res.json()).output).toBe('["a","b"]');
    expect(mockRunStructured.mock.calls[0][0].schema).toEqual({
      type: "object",
      properties: { value: schema },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("closes the run as failed when post-conditions fail, output still present", async () => {
    mockFindAction.mockResolvedValue(
      actionMeta({ validate: { files_exist: ["out.md"] } }),
    );
    mockRunStructured.mockResolvedValue({ data: "done", raw: "" });
    mockValidation.mockResolvedValue({
      passed: false,
      failures: ["expected file not found: out.md"],
      skipped: false,
    });
    mockRunsComplete.mockResolvedValue(runRecord({ status: "failed" }));

    const res = await post("extract-title");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run_id: "run_1",
      status: "failed",
      summary: null,
      output: "done",
      output_type: "text",
      validation_failures: ["expected file not found: out.md"],
    });
    expect(mockRunsComplete).toHaveBeenCalledWith(
      "run_1",
      "Executed detached",
      { failures: ["expected file not found: out.md"] },
      { type: "text", value: "done" },
    );
  });

  /**
   * A failed run closes with its cause. It used to stay `started` until the
   * session sweep closed it as "the session ended without calling
   * complete_action", so `barry action show` named the wrong cause and the
   * real one (a model the harness could not find) was only in the API log.
   */
  it("502s when the agent run fails, closing the run failed with the agent's error", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockRejectedValue(new Error("There's an issue with the selected model (ollama/qwen3:8b)"));

    const res = await post("extract-title");

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("run_failed");
    expect(body.run_id).toBe("run_1");
    expect(body.message).toContain("issue with the selected model");

    expect(mockRunsComplete).not.toHaveBeenCalled();
    expect(vi.mocked(ActionRuns.fail)).toHaveBeenCalledWith(
      "run_1",
      "The run failed: There's an issue with the selected model (ollama/qwen3:8b)",
    );
    // The synthetic session is still cleaned up.
    expect(mockSessionsEnd).toHaveBeenCalledTimes(1);
  });

  it("504s a run that outlives its timeout, closing it failed as timed out", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockImplementation(() => new Promise(() => {}));

    const res = await post("extract-title", { timeout_s: 1 });

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "timeout", run_id: "run_1" });
    expect(vi.mocked(ActionRuns.fail)).toHaveBeenCalledWith("run_1", "Timed out after 1s; the agent was stopped.");
  });

  /**
   * A run that outlasts its caller's `wait_s` settles with nobody awaiting it.
   * Its row used to stay `started` until the sweep closed it as abandoned, so
   * `check_action_run` never saw the output it promises.
   */
  it("records the output of a run that outlasted wait_s, once it settles", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    let finish: (v: { data: unknown; raw: string }) => void = () => {};
    mockRunStructured.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const res = await post("extract-title", { wait_s: 1 });
    expect((await res.json()).status).toBe("started");
    expect(mockRunsComplete).not.toHaveBeenCalled();

    finish({ data: "Late but real", raw: "" });
    await vi.waitFor(() =>
      expect(mockRunsComplete).toHaveBeenCalledWith("run_1", "Executed detached", null, { type: "text", value: "Late but real" }),
    );
    expect(vi.mocked(ActionRuns.fail)).not.toHaveBeenCalled();
  });

  it("records the error of a run that outlasted wait_s and then failed", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    let fail: (err: Error) => void = () => {};
    mockRunStructured.mockImplementation(() => new Promise((_, reject) => (fail = reject)));

    const res = await post("extract-title", { wait_s: 1 });
    expect((await res.json()).status).toBe("started");

    fail(new Error("makeSession is not a function"));
    await vi.waitFor(() =>
      expect(vi.mocked(ActionRuns.fail)).toHaveBeenCalledWith("run_1", "The run failed: makeSession is not a function"),
    );
    expect(mockRunsComplete).not.toHaveBeenCalled();
  });
});

describe("run limits", () => {
  // Sessions with no barry, so these tests depend on nothing but the counts.
  beforeEach(() => {
    vi.mocked(Sessions.get).mockImplementation(async (id) => callerSession({ id, identity_id: null }));
  });

  it("refuses a session's fifth concurrent run before creating anything, while another session still gets in", async () => {
    // The per-session limit is what keeps one session's fan-out from taking
    // the whole lane, which a single shared count of 4 used to allow.
    mockFindAction.mockResolvedValue(
      actionMeta({ context: "none", outputSchema: { type: "string" } }),
    );
    const deferreds: Array<(v: { data: unknown; raw: string }) => void> = [];
    mockRunStructured.mockImplementation(
      () => new Promise<{ data: unknown; raw: string }>((resolve) => deferreds.push(resolve)),
    );

    const inFlight = [1, 2, 3, 4].map(() => post("audit", { inputs: {}, caller_session_id: "s1" }));
    // Until all four handlers hold a slot and are parked in runStructured. A
    // fixed sleep here raced them on a loaded host: the fifth was admitted
    // instead of refused, and then parked forever.
    await vi.waitFor(() => expect(deferreds).toHaveLength(4), { timeout: 10_000 });

    const createsBefore = mockRunsCreate.mock.calls.length;
    const fifth = await post("audit", { inputs: {}, caller_session_id: "s1" });
    expect(fifth.status).toBe(429);
    const fifthBody = (await fifth.json()) as { error: string; message: string };
    expect(fifthBody.error).toBe("executor_busy");
    expect(fifthBody.message).toMatch(/This session already has 4/);
    // Refused before side effects: no new run row, no new session.
    expect(mockRunsCreate.mock.calls.length).toBe(createsBefore);

    inFlight.push(post("audit", { inputs: {}, caller_session_id: "s2" }));
    await vi.waitFor(() => expect(deferreds, "another session's run must still be admitted").toHaveLength(5), {
      timeout: 10_000,
    });
    expect(mockRunsCreate.mock.calls.length, "another session's run must still be admitted").toBe(createsBefore + 1);

    // Settle the parked runs and confirm the slots free up.
    for (const resolve of deferreds) resolve({ data: "done", raw: "done" });
    await Promise.all(inFlight);
    // The parked implementation would park the next run too — swap in a
    // resolving one; this request exists only to prove the slots freed.
    mockRunStructured.mockResolvedValue({ data: "done", raw: "done" });
    const sixth = await post("audit", { inputs: {}, caller_session_id: "s1" });
    expect(sixth.status).not.toBe(429);
  }, 15000);

  it("gives schedules their own allowance, so sessions filling theirs cannot delay one", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockResolvedValue({ data: "done", raw: "done" });
    // Fill the non-schedule lane directly: sixteen parked agents would prove
    // nothing more about the lane than sixteen held slots do.
    const held = Array.from({ length: RUN_SLOT_LIMITS.unscheduled }, () =>
      detachedRunSlots.acquire({ scheduled: false, callerSessionId: null }),
    );
    try {
      expect((await post("extract-title", {})).status).toBe(429);
      expect((await post("extract-title", { schedule_id: "sched1" })).status).toBe(200);
    } finally {
      for (const h of held) if ("slot" in h) h.slot.release();
    }
  });

  // The EARLY-RETURN path, which the wait_s split introduces. The test above
  // only exercises block-till-done: every run there holds its slot until the
  // race settles, so the release happens on the same call stack that took it.
  //
  // With `wait_s`, the route answers `{status:"started"}` and the run keeps
  // going in the background — the slot is now released by the continuation,
  // NOT by the request. If that accounting is dropped or moved out of the
  // continuation's `finally`, every timed-out wait leaks a slot and the
  // executor wedges at its limit with nothing actually running.
  //
  // Four early returns, then settle them, then prove a fifth is admitted.
  it("frees the concurrency slot when wait_s returns before the run finishes", async () => {
    mockFindAction.mockResolvedValue(
      actionMeta({ context: "none", outputSchema: { type: "string" } }),
    );
    const deferreds: Array<(v: { data: unknown; raw: string }) => void> = [];
    mockRunStructured.mockImplementation(
      () => new Promise<{ data: unknown; raw: string }>((resolve) => deferreds.push(resolve)),
    );

    // Each returns early: the run is still parked, so the slot must be held by
    // the continuation rather than released by the response.
    const started = await Promise.all(
      [1, 2, 3, 4].map(() => post("audit", { inputs: {}, wait_s: 1, caller_session_id: "s1" })),
    );
    for (const res of started) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string; run_id?: string };
      expect(body.status, "wait_s expiring must answer started, not a result").toBe("started");
      expect(body.run_id).toBeTruthy();
    }

    // All four slots are taken by runs nobody is awaiting any more.
    const fifth = await post("audit", { inputs: {}, wait_s: 1, caller_session_id: "s1" });
    expect(fifth.status, "four parked runs should still hold their slots").toBe(429);

    // Settle them; the continuations must now give the slots back. Each one
    // releases its slot and then ends its session, so four more ends means
    // four continuations have run; whether the slots came back is the
    // assertion below.
    const endsBefore = mockSessionsEnd.mock.calls.length;
    for (const resolve of deferreds) resolve({ data: "done", raw: "done" });
    await vi.waitFor(() => expect(mockSessionsEnd.mock.calls.length).toBe(endsBefore + 4), { timeout: 10_000 });

    mockRunStructured.mockResolvedValue({ data: "done", raw: "done" });
    const afterSettle = await post("audit", { inputs: {}, caller_session_id: "s1" });
    expect(
      afterSettle.status,
      "slots leaked: the continuation did not release its slot",
    ).not.toBe(429);
  }, 15000);
});

describe("agent override", () => {
  it("runs on the action's declared agent and model unless the request overrides", async () => {
    mockFindAction.mockResolvedValue(
      actionMeta({
        context: "none",
        outputSchema: { type: "string" },
        agent: { agent: "claude", model: "claude-opus-4-6" },
      }),
    );
    mockRunStructured.mockResolvedValue({ data: "ok", raw: "ok" });

    await post("extract-title", { inputs: {} });
    expect(mockRunStructured.mock.calls[0][0].harness).toBe("claude");
    expect(mockRunStructured.mock.calls[0][0].config.model).toBe("anthropic/claude-opus-4-6");

    // A provider switch implies its own model space — the claude model id
    // must not leak into, say, a codex run.
    await post("extract-title", { inputs: {}, provider: "codex" });
    expect(mockRunStructured.mock.calls[1][0].harness).toBe("codex");
    expect(mockRunStructured.mock.calls[1][0].config.model).toBeUndefined();

    // ...but a request that switches agents can now name a model for the new
    // one, which `provider` alone could not express.
    await post("extract-title", { inputs: {}, provider: "codex", model: "gpt-5" });
    expect(mockRunStructured.mock.calls[2][0].config.model).toBe("openai/gpt-5");
  });

  it("records which tier supplied the agent and the model", async () => {
    mockFindAction.mockResolvedValue(
      actionMeta({
        context: "none",
        outputSchema: { type: "string" },
        agent: { agent: "claude", model: "claude-opus-4-6" },
      }),
    );
    mockRunStructured.mockResolvedValue({ data: "ok", raw: "ok" });

    await post("extract-title", { inputs: {} });
    const applied = mockRunsCreate.mock.calls.at(-1)![0].metadata;
    expect(applied).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-6",
      agent_from: "manifest",
      model_from: "manifest",
    });

    // The case the row could not previously express: the manifest asked for a
    // model and did NOT get it. Recording only the provider made this
    // indistinguishable from the run above.
    await post("extract-title", { inputs: {}, provider: "codex" });
    const overridden = mockRunsCreate.mock.calls.at(-1)![0].metadata;
    expect(overridden).toMatchObject({ provider: "codex", agent_from: "request", model_from: "default" });
    expect(overridden?.model).toBeUndefined();
  });

  // check_action_run reports this bound so a poller can pace itself. Derived
  // client-side it would be wrong whenever the action declared its own
  // timeout, so the row has to carry the one that actually applies.
  it("records the timeout the run will actually be abandoned at", async () => {
    mockFindAction.mockResolvedValue(
      actionMeta({ context: "none", outputSchema: { type: "string" }, timeout: 120 }),
    );
    mockRunStructured.mockResolvedValue({ data: "ok", raw: "ok" });

    // The action's own declaration, when the caller named no bound.
    await post("extract-title", { inputs: {} });
    expect(mockRunsCreate.mock.calls.at(-1)![0].metadata).toMatchObject({ timeout_s: 120 });

    // The caller's bound wins when given — including when it is LONGER than
    // the action's, which is the case a client-side guess gets wrong.
    await post("extract-title", { inputs: {}, timeout_s: 400 });
    expect(mockRunsCreate.mock.calls.at(-1)![0].metadata).toMatchObject({ timeout_s: 400 });
  });
});

// The input side of a run. Before this, `metadata` held only the output
// contract, so a completed run could show its deliverable and never what was
// asked for — the same write-only problem `output` itself once had.
describe("recording the input side", () => {
  it("records the composed prompt and the inputs on the run row", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockResolvedValue({
      data: "T",
      raw: '{"value":"T"}',
    });

    await post("extract-title", { inputs: { url: "https://x" } });

    expect(mockRunsCreate).toHaveBeenCalledTimes(1);
    const { metadata } = mockRunsCreate.mock.calls[0][0];
    expect(metadata).toMatchObject({
      inputs: { url: "https://x" },
      prompt: "COMPOSED PROMPT",
    });
  });

  // Composition must happen BEFORE the row is written, or the prompt could
  // only be recorded by a second update — and a crash between the two would
  // leave an open run with no record of what it was asked to do.
  it("composes before creating the run, not after", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockResolvedValue({ data: "T", raw: '{"value":"T"}' });

    await post("extract-title", { inputs: { url: "https://x" } });

    expect(mockCompose.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunsCreate.mock.invocationCallOrder[0],
    );
  });

  it("omits inputs entirely when the action was called with none", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockRunStructured.mockResolvedValue({ data: "T", raw: '{"value":"T"}' });

    await post("extract-title", {});

    const { metadata } = mockRunsCreate.mock.calls[0][0];
    expect(metadata).not.toHaveProperty("inputs");
    expect(metadata).toHaveProperty("prompt");
  });
});

// GET /runs/:id is the ONLY surface that returns metadata, and had no
// coverage at all before — the endpoint could have dropped the field again
// with every executor test still green.
describe("GET /actions/runs", () => {
  it("filters by trigger, so job runs and subagents list together", async () => {
    vi.mocked(ActionRuns.list).mockResolvedValue([]);
    const res = await fetch(`${baseUrl}/actions/runs?trigger=job`);
    expect(res.status).toBe(200);
    expect(ActionRuns.list).toHaveBeenCalledWith({ trigger: "job" });
    expect(vi.mocked(abandonOrphanedActionRuns).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ActionRuns.list).mock.invocationCallOrder[0]);
    expect((await fetch(`${baseUrl}/actions/runs?trigger=robot`)).status).toBe(422);
  });

  it("lists a run with its trigger, schedule and process as declared", async () => {
    vi.mocked(ActionRuns.list).mockResolvedValue([
      runRecord({ status: "complete", output: "{}", output_type: "json", trigger: "schedule", schedule_id: "web/nightly", process: { exit_code: 0, duration_ms: 1200, log_path: "/runs/run_1.log" } }),
      runRecord({ id: "run_2" }),
    ]);
    const res = await fetch(`${baseUrl}/actions/runs`);
    expect(res.status).toBe(200);
    const { runs } = await res.json() as { runs: Array<Record<string, unknown>> };
    expect(runs[0]).toMatchObject({ run_id: "run_1", has_output: true, trigger: "schedule", schedule_id: "web/nightly", exit_code: 0, duration_ms: 1200 });
    expect(runs[1]).toMatchObject({ run_id: "run_2", has_output: false, trigger: null, schedule_id: null, exit_code: null, duration_ms: null });
  });
});

describe("GET /actions/runs/:id", () => {
  const mockRunsGet = vi.mocked(ActionRuns.get);

  it("returns metadata, so the recorded input side is retrievable", async () => {
    mockRunsGet.mockResolvedValue(
      runRecord({
        status: "complete",
        output: "# Report",
        output_type: "text",
        metadata: { inputs: { url: "https://x" }, prompt: "COMPOSED PROMPT" },
      }),
    );

    const res = await fetch(`${baseUrl}/actions/runs/run_1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.metadata).toEqual({
      inputs: { url: "https://x" },
      prompt: "COMPOSED PROMPT",
    });
    expect(body.output).toBe("# Report");
    expect(abandonOrphanedActionRuns).toHaveBeenCalledWith("run_1");
    expect(vi.mocked(abandonOrphanedActionRuns).mock.invocationCallOrder[0]).toBeLessThan(mockRunsGet.mock.invocationCallOrder[0]);
  });

  // An empty object and a missing key read identically in a UI pane. The
  // field must always be present so "recorded nothing" is distinguishable
  // from "this endpoint does not report it".
  it("always includes metadata, even when the run recorded none", async () => {
    mockRunsGet.mockResolvedValue(runRecord({ metadata: {} }));

    const body = await (await fetch(`${baseUrl}/actions/runs/run_1`)).json();

    expect(body).toHaveProperty("metadata");
    expect(body.metadata).toEqual({});
  });

  it("404s an unknown run rather than returning an empty shell", async () => {
    mockRunsGet.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/actions/runs/nope`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_run" });
  });
});

// cancel_action used to close a detached run's row while its agent ran on,
// burning tokens under a row that said cancelled: the API owns the agent's
// AbortController and nothing reached it. The agent's AbortSignal is what
// these tests watch, because stopping the agent is the whole point.
describe("POST /actions/runs/:id/cancel", () => {
  function cancel(id: string, body: Record<string, unknown> = { reason: "wrong action" }) {
    return fetch(`${baseUrl}/actions/runs/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("stops the running agent, closes the row cancelled, and answers the waiting caller 409", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ context: "none", outputSchema: { type: "string" } }));
    mockRunsCreate.mockResolvedValue(runRecord({ id: "run_live" }));
    mockRunsCancel.mockResolvedValue(runRecord({ id: "run_live", status: "cancelled", summary: "wrong action" }));
    // An agent that runs until it is aborted, like a real one mid-task.
    let agentSignal: AbortSignal | undefined;
    mockRunStructured.mockImplementation(({ signal }) => new Promise((_, reject) => {
      agentSignal = signal;
      agentSignal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));

    const running = post("audit", { inputs: {} });
    await vi.waitFor(() => expect(agentSignal).toBeDefined());
    const res = await cancel("run_live");

    expect(agentSignal?.aborted, "the run's agent after cancel").toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: "run_live", status: "cancelled", agent_stopped: true });
    expect(mockRunsCancel).toHaveBeenCalledWith("run_live", "wrong action");

    const answered = await running;
    expect(answered.status).toBe(409);
    expect(await answered.json()).toEqual({ error: "cancelled", run_id: "run_live", message: "wrong action" });
    expect(mockRunsComplete).not.toHaveBeenCalled();
  }, 15000);

  // The registry entry must go the moment a run settles. A leftover one would
  // let a late cancel stamp a finished run `cancelled` over its real result.
  it("cannot cancel a run that already finished", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ context: "none", outputSchema: { type: "string" } }));
    mockRunStructured.mockResolvedValue({ data: "done", raw: "done" });
    const finished = await post("audit", { inputs: {} });
    expect(finished.status).toBe(200);

    const res = await cancel("run_1");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_running" });
    expect(mockRunsCancel).not.toHaveBeenCalled();
  });

  it("404s a run with no running agent here and touches no row", async () => {
    const res = await cancel("run_elsewhere");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_running" });
    expect(mockRunsCancel).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const res = await cancel("run_live", {});

    expect(res.status).toBe(422);
    expect(mockRunsCancel).not.toHaveBeenCalled();
  });
});

describe("POST /actions/trigger", () => {
  const mockCreateInert = vi.mocked(Sessions.createInert);

  function trigger(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/actions/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    mockCreateInert.mockResolvedValue({ id: "sess_1" } as never);
  });

  // THE invariant. The seeded prompt must tell the agent to call begin_action,
  // because that call is what creates the run row. If this route ever pastes
  // the composed prompt instead, the work still happens but nothing records
  // it and the open-run listing goes blind.
  it("seeds an instruction to call begin_action, not the action's prompt", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ context: "session", outputSchema: undefined }));

    const body = await (await trigger({ action: "wrap-up", repo_path: "/repo" })).json();

    expect(body.prompt).toContain("begin_action");
    expect(body.prompt).toContain("complete_action");
    // The composed prompt must NOT be inlined — that is the bug this guards.
    expect(body.prompt).not.toContain("COMPOSED PROMPT");
  });

  // Exactly one row per trigger, and the agent writes it. A row created here
  // too would double-count every trigger.
  it("creates NO run row of its own", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ context: "session", outputSchema: undefined }));

    await trigger({ action: "wrap-up", repo_path: "/repo" });

    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  describe("caller-supplied inputs", () => {
    const withSchema = () =>
      actionMeta({
        context: "session",
        outputSchema: undefined,
        inputSchema: {
          type: "object",
          properties: { theme: { type: "string" }, audience: { type: "string" } },
        },
      });

    it("passes validated inputs into the seeded instruction", async () => {
      mockFindAction.mockResolvedValue(withSchema());

      const body = await (
        await trigger({ action: "story", repo_path: "/repo", inputs: { theme: "propublica" } })
      ).json();

      expect(body.prompt).toContain('{"theme":"propublica"}');
    });

    /**
     * The no-orphan-rows invariant, in its trigger-path form. Inputs are the
     * caller's to fix, so a bad one must be rejected before anything exists —
     * a session created here and then abandoned is one whose agent never
     * starts.
     */
    it("rejects an unknown input BEFORE creating the session", async () => {
      mockFindAction.mockResolvedValue(withSchema());
      mockValidateInputs.mockReturnValue(['Action "story" declares no input named "thmee".']);

      const response = await trigger({
        action: "story",
        repo_path: "/repo",
        inputs: { thmee: "propublica" },
      });

      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe("invalid_inputs");
      expect(mockCreateInert).not.toHaveBeenCalled();
    });

    it("records the inputs on the session so a run is auditable without the prompt", async () => {
      mockFindAction.mockResolvedValue(withSchema());

      await trigger({ action: "story", repo_path: "/repo", inputs: { theme: "pudding" } });

      expect(mockCreateInert).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ inputs: { theme: "pudding" } }),
        }),
      );
    });

    // 15 of 16 actions declare nothing. Sending inputs to one is the caller's
    // error, and it must not reach the session either.
    it("rejects inputs for an action that declares none", async () => {
      mockFindAction.mockResolvedValue(actionMeta({ inputSchema: undefined }));
      mockValidateInputs.mockReturnValue(['Action "extract-title" declares no inputs.']);

      const response = await trigger({
        action: "extract-title",
        repo_path: "/repo",
        inputs: { theme: "x" },
      });

      expect(response.status).toBe(422);
      expect(mockCreateInert).not.toHaveBeenCalled();
    });

    it("leaves the prompt unchanged when no inputs are sent", async () => {
      mockFindAction.mockResolvedValue(withSchema());

      const body = await (await trigger({ action: "story", repo_path: "/repo" })).json();

      expect(body.prompt).not.toContain("verbatim");
    });
  });

  it("grants the actions bag alongside the action's own", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ bag: "sessions" }));

    await trigger({ action: "wrap-up", repo_path: "/repo" });

    const created = mockCreateInert.mock.calls[0][0];
    // Without `actions` the seeded instruction names a tool the session cannot
    // invoke — a dead reference.
    expect(created.traits).toContain("actions");
    expect(created.traits).toContain("sessions");
  });

  // REGRESSION: the session was created with no identity_id, and the spawn path
  // later PATCHed a raw file-based Barry id onto the row — a name hash with no
  // matching row, so the session pointed at no identity. Every unit test
  // passed; only a real spawn caught it.
  it("resolves a real identity id onto the session, not a name hash", async () => {
    mockFindAction.mockResolvedValue(actionMeta());

    await trigger({ action: "extract-title", repo_path: "/repo" });

    expect(mockCreateInert.mock.calls[0][0].identity_id).toBe(7);
  });

  // REGRESSION: the session recorded no pid, so classifyProcessLiveness returned
  // `unknown/no-pid` and the reconciler — which skipped `alive` and
  // `other-host` but not `no-pid` — rewrote the session to `pending` while its
  // agent was mid-tool-call. A run that finished in 221s looked like a session
  // that had died. The session runs in the API's own process, so the API's pid
  // is the honest answer.
  it("records process identity so liveness is provable, not guessed", async () => {
    mockFindAction.mockResolvedValue(actionMeta());

    await trigger({ action: "extract-title", repo_path: "/repo" });

    expect(Processes.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: process.pid,
        pidStartedAt: 1_700_000_000,
        source: "api",
      }),
    );
  });

  it("records where it came from, so these sessions are identifiable", async () => {
    mockFindAction.mockResolvedValue(actionMeta());

    await trigger({ action: "extract-title", repo_path: "/repo" });

    expect(mockCreateInert.mock.calls[0][0].metadata).toMatchObject({
      source: "actions-app",
      working_directory: "/repo",
    });
  });

  // provider/model cannot ride on the follow-up message (its schema is strict
  // and rejects them), so creation is the only place they can be set.
  it("stores provider and model on the session", async () => {
    mockFindAction.mockResolvedValue(actionMeta());

    await trigger({ action: "extract-title", repo_path: "/repo", provider: "codex", model: "o3" });

    expect(mockCreateInert.mock.calls[0][0].metadata).toMatchObject({
      provider: "codex",
      model: "o3",
    });
  });

  it("marks a detachable action executable, and tells the agent to run it with run_action", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ context: "none" }));

    const body = await (await trigger({ action: "extract-title", repo_path: "/repo" })).json();

    expect(body.executable).toBe(true);
    expect(body.prompt).toContain("run_action");
  });

  it("404s an unknown action without creating a session", async () => {
    mockFindAction.mockResolvedValue(null);

    const res = await trigger({ action: "nope", repo_path: "/repo" });

    expect(res.status).toBe(404);
    expect(mockCreateInert).not.toHaveBeenCalled();
  });

  it("rejects a bad repo path rather than starting a session somewhere odd", async () => {
    mockFindAction.mockResolvedValue(actionMeta());

    const res = await trigger({ action: "extract-title", repo_path: "relative/path" });

    expect(res.status).toBe(400);
    expect(mockCreateInert).not.toHaveBeenCalled();
  });
});

describe("GET /actions/catalog", () => {
  it("reports which actions can run detached", async () => {
    vi.mocked(listAllActions).mockResolvedValue([
      actionMeta({ name: "wrap-up", context: "session", outputSchema: undefined }),
      actionMeta({ name: "extract-title", context: "none" }),
    ]);

    const body = await (await fetch(`${baseUrl}/actions/catalog`)).json();

    expect(body.count).toBe(2);
    expect(body.actions[0]).toMatchObject({ name: "wrap-up", executable: false });
    expect(body.actions[1]).toMatchObject({ name: "extract-title", executable: true });
  });

  it("scopes to the active identity's packed bags", async () => {
    vi.mocked(identityRecords.config).mockReturnValueOnce({ bags: ["web", "git"], adapters: {} } as never);
    vi.mocked(listAllActions).mockResolvedValue([actionMeta()]);

    const body = await (await fetch(`${baseUrl}/actions/catalog`)).json();

    expect(listAllActions).toHaveBeenCalledWith(REGISTERED_BAGS, { bagNames: ["web", "git"] });
    expect(body.scope).toEqual({ kind: "identity", identity: "default", bags: ["web", "git"] });
  });

  it("lists a sub-bag's actions when only the parent is packed", async () => {
    // The stored list is the PARENT only; composition is what makes the
    // child's actions runnable. Reading metadata.bags raw would hide them.
    vi.mocked(identityRecords.config).mockReturnValueOnce({ bags: ["vantage"], adapters: {} } as never);
    vi.mocked(expandCompositionFromSnapshot).mockResolvedValueOnce(["vantage", "clickhouse"]);
    vi.mocked(listAllActions).mockResolvedValue([actionMeta({ bag: "clickhouse" })]);

    const body = await (await fetch(`${baseUrl}/actions/catalog`)).json();

    expect(listAllActions).toHaveBeenCalledWith(REGISTERED_BAGS, { bagNames: ["vantage", "clickhouse"] });
    expect(body.scope.bags).toEqual(["vantage", "clickhouse"]);
  });

  it("an identity with nothing packed returns no actions, and says so", async () => {
    // The empty case must not fall back to the full catalog: that is exactly
    // the silent revert this endpoint's scoping exists to prevent.
    vi.mocked(identityRecords.config).mockReturnValueOnce({ bags: [], adapters: {} } as never);
    vi.mocked(listAllActions).mockResolvedValue([]);

    const body = await (await fetch(`${baseUrl}/actions/catalog`)).json();

    expect(listAllActions).toHaveBeenCalledWith(REGISTERED_BAGS, { bagNames: [] });
    expect(body.count).toBe(0);
    expect(body.scope).toMatchObject({ kind: "identity", identity: "default" });
  });

  it("falls back to the full catalog when no identity resolves, and marks it", async () => {
    // A trigger UI stays usable, but `kind: "all"` is what keeps the fallback
    // distinguishable from a healthy scoped result — without it a broken
    // resolution reverts the filter invisibly.
    vi.mocked(identityRecords.resolve).mockRejectedValueOnce(new BarryError("not_found", "no identity"));
    vi.mocked(listAllActions).mockResolvedValue([actionMeta(), actionMeta({ name: "wrap-up" })]);

    const body = await (await fetch(`${baseUrl}/actions/catalog`)).json();

    expect(listAllActions).toHaveBeenCalledWith(REGISTERED_BAGS);
    expect(body.count).toBe(2);
    expect(body.scope).toEqual({ kind: "all", identity: null, bags: [] });
  });

  it("marks the catalog unscoped when there is no user to resolve an identity from", async () => {
    // No user means no identity to scope BY, so the catalog widens to
    // everything without any error being thrown. Pinned because that is the
    // one widening with nothing to notice it — it must still announce itself
    // as `kind: "all"` rather than pass for scoped.
    vi.mocked(identityRecords.resolve).mockRejectedValueOnce(new BarryError("not_found", "No Barry user is configured", "Run barry setup"));
    vi.mocked(listAllActions).mockResolvedValue([actionMeta()]);

    const body = await (await fetch(`${baseUrl}/actions/catalog`)).json();

    expect(listAllActions).toHaveBeenCalledWith(REGISTERED_BAGS);
    expect(body.scope).toEqual({ kind: "all", identity: null, bags: [] });
  });
});

describe("POST /actions/:name/begin", () => {
  const begin = (name: string, body: Record<string, unknown> = {}) =>
    fetch(`${baseUrl}/actions/${name}/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    const { runActionPreflight } = await import("@barry-rocks/sdk/internal/actions");
    vi.mocked(runActionPreflight).mockResolvedValue({ skipped: true, passed: true, unknown: false, warning: null } as never);
  });

  it("opens a run the way begin_action does, attributed to the given session", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ prompt: "Extract the title of the page" }));
    mockRunsCreate.mockResolvedValue(runRecord({ id: "run_9", session_id: "s1" }));

    const res = await begin("extract-title", { session_id: "s1" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ run_id: "run_9", action: "web:extract-title", prompt: expect.stringContaining("Extract the title") });
    // The output contract is snapshotted into the row, as begin_action does.
    expect(mockRunsCreate).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "s1",
      metadata: expect.objectContaining({ output_schema: { type: "string" } }),
    }));
  });

  it("answers 404 for an unknown action and records nothing", async () => {
    mockFindAction.mockResolvedValue(null);
    const res = await begin("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_action" });
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("answers 422 for inputs the action rejects, before any row exists", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ inputSchema: undefined }));
    mockValidateInputs.mockReturnValue(["Action declares no inputs"]);
    const res = await begin("extract-title", { inputs: { stray: 1 } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_inputs", details: [expect.stringContaining("declares no inputs")] });
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("answers 422 for a body it does not understand", async () => {
    const res = await begin("extract-title", { sessionId: "camel" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });
});


/**
 * Credentials live on a barry and nowhere else. Before the executor resolved
 * one, a detached run's agent saw only PATH and HOME: every z.ai model got a
 * 401, retried, and came back as a 504 after the full timeout.
 */
describe("POST /actions/:name/run — acting for a barry", () => {
  const mockResolveEnv = vi.mocked(resolveEnvForBarry);
  const mockResolveIdentity = vi.mocked(identityRecords.resolve);
  const zaiAction = () =>
    actionMeta({ agent: { agent: "claude", model: "glm-5-turbo" } });
  const ok = () =>
    mockRunStructured.mockResolvedValue({ data: "t", raw: '{"value":"t"}' });

  it("refuses a credential present only in the process-facing map", async () => {
    mockFindAction.mockResolvedValue(zaiAction());
    mockResolveEnv.mockResolvedValueOnce({ base: { PATH: "/bin", HOME: "/h" }, environment: null,
      vars: { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "ambient", Z_AI_API_KEY: "ambient" } });
    const response = await post("extract-title");
    expect(response.status).toBe(424);
    expect(mockRunStructured).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("refuses when the barry's environment cannot be built, naming why", async () => {
    mockFindAction.mockResolvedValue(zaiAction());
    mockResolveEnv.mockRejectedValueOnce(new IdentityEnvironmentError(7, "vault is sealed"));
    const response = await post("extract-title");
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ error: "identity_environment_failed", message: "vault is sealed" });
    expect(mockRunStructured).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("hands the barry's resolved env to the run, so its keys reach the agent", async () => {
    mockFindAction.mockResolvedValue(zaiAction());
    mockResolveEnv.mockResolvedValueOnce({ base: { PATH: "/bin", HOME: "/h" }, environment: { vars: { ANTHROPIC_API_KEY: "fixture-key", Z_AI_API_KEY: "zk-test", TOOL_ONLY_KEY: "withheld" }, sources: { ANTHROPIC_API_KEY: "keychain", Z_AI_API_KEY: "keychain", TOOL_ONLY_KEY: "keychain" } }, vars: { PATH: "/bin", HOME: "/h" } });
    ok();

    const res = await post("extract-title");

    expect(res.status).toBe(200);
    expect(mockResolveEnv).toHaveBeenCalledWith(7);
    const config = mockRunStructured.mock.calls[0][0].config;
    expect(config.env?.Z_AI_API_KEY).toBe("zk-test");
    expect(config.env?.TOOL_ONLY_KEY).toBeUndefined();
    expect(config.model).toBe("zai/glm-5-turbo");
    expect(mockSessionsCreate.mock.calls[0][0]).toMatchObject({ identity_id: 7 });
    expect(mockRunsCreate.mock.calls[0][0].metadata).toMatchObject({ identity: "default" });
  });

  it("runs a model the action names by its vendor on that vendor", async () => {
    // hq's collectors name `ollama/qwen3:8b`; read as a bare id it was asked of Anthropic.
    mockFindAction.mockResolvedValue(actionMeta({ agent: { agent: "claude", model: "ollama/qwen3:8b" } }));
    ok();

    const res = await post("extract-title");

    expect(res.status).toBe(200);
    expect(mockRunStructured.mock.calls[0][0].config.model).toBe("ollama/qwen3:8b");
  });

  it("424s a model whose key the barry lacks, before any session or run exists", async () => {
    mockFindAction.mockResolvedValue(zaiAction());

    const res = await post("extract-title");

    expect(res.status).toBe(424);
    const body = await res.json();
    expect(body.error).toBe("missing_credential");
    expect(body.message).toContain("Z_AI_API_KEY");
    expect(body.message).toContain('"default"');
    expect(mockRunStructured).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("refuses an agent no adapter is installed for, before any session or run exists", async () => {
    // A manifest checks the id's shape only, so "ollama" (a vendor, not a
    // harness) gets this far and must be stopped here.
    mockFindAction.mockResolvedValue(actionMeta({ agent: { agent: "ollama" } }));

    const res = await post("extract-title");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unknown_harness");
    expect(body.message).toContain('"ollama"');
    expect(mockRunStructured).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("does not refuse a model that needs no key", async () => {
    mockFindAction.mockResolvedValue(
      actionMeta({ agent: { agent: "claude", model: "claude-haiku-4-5" } }),
    );
    ok();

    const res = await post("extract-title");

    expect(res.status).toBe(200);
  });

  it("resolves the barry the caller names", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    ok();

    await post("extract-title", { identity: "bux" });

    expect(mockResolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bux" }),
      { kind: "owner" },
    );
  });

  it("resolves the barry by id, which is how run_action names the caller's", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    ok();

    await post("extract-title", { identity_id: 7 });

    expect(mockResolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      { kind: "owner" },
    );
  });

  it("422s a request naming the barry both ways", async () => {
    mockFindAction.mockResolvedValue(actionMeta());

    const res = await post("extract-title", { identity: "bux", identity_id: 7 });

    expect(res.status).toBe(422);
    expect(mockRunStructured).not.toHaveBeenCalled();
  });

  it("404s a barry that does not exist, without running anything", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    mockResolveIdentity.mockRejectedValueOnce(new BarryError("not_found", 'Barry "nope" not found'));

    const res = await post("extract-title", { identity: "nope" });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_identity");
    expect(mockRunStructured).not.toHaveBeenCalled();
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("uses the identity model for a requested harness", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    vi.mocked(identityRecords.config).mockReturnValueOnce({ bags: [], adapters: { "claude-code": { default: true }, codex: { model: "gpt-5" } } } as never);
    ok();
    await post("extract-title", { provider: "codex" });
    expect(mockRunStructured.mock.calls[0][0].config.model).toBe("openai/gpt-5");
    expect(mockRunsCreate.mock.calls[0][0].metadata).toMatchObject({ agent_from: "request", model_from: "identity" });
  });

  it("falls back to the barry's default model when neither request nor manifest names one", async () => {
    mockFindAction.mockResolvedValue(actionMeta());
    vi.mocked(identityRecords.config).mockReturnValueOnce({
      bag_configs: {},
      secrets: {},
      vault: undefined,
      traits: [],
      bags: [],
      bounds: [],
      bound: undefined,
      adapters: { "claude-code": { default: true, model: "claude-opus-5" } },

      status_notify: undefined,

      bag_grant: "session",
    });
    ok();

    await post("extract-title");

    expect(mockRunStructured.mock.calls[0][0].config.model).toBe("anthropic/claude-opus-5");
    expect(mockRunsCreate.mock.calls[0][0].metadata).toMatchObject({ model_from: "identity" });
  });
});

describe("POST /actions/:name/run — an ad-hoc action runs as its caller", () => {
  const mockAdhocGet = vi.mocked(AdhocActions.get);
  const mockSessionsGet = vi.mocked(Sessions.get);
  const mockEgressSandbox = vi.mocked(resolveEgressSandbox);

  function adhocMeta(overrides: Partial<AdhocActionMeta> = {}): AdhocActionMeta {
    return {
      source: "adhoc",
      name: "survey-auth",
      qualifiedName: "survey-auth@caller1",
      ownerSessionId: "caller1",
      // A real directory: an ad-hoc run's cwd is checked to exist.
      dir: tmpdir(),
      description: "Survey auth code",
      prompt: "List every file that checks a token.",
      requires: { tools: [], secrets: [], bins: [] },
      instructions: [],
      steps: [],
      scripts: [],
      context: "none",
      legacySkill: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockFindAction.mockResolvedValue(null);
    // The store holds one action, for one owner, as the real one would.
    mockAdhocGet.mockImplementation(async (owner, name) =>
      owner === "caller1" && name === "survey-auth" ? adhocMeta() : null,
    );
    mockSessionsGet.mockResolvedValue(callerSession());
    mockRunStructured.mockResolvedValue({ data: "three files", raw: '{"value":"three files"}' });
    vi.mocked(identityRecords.config).mockReturnValue({
      bag_configs: {},
      secrets: {},
      vault: undefined,
      traits: [{ name: "barry-trait", optional: false }],
      bags: [],
      bounds: [],
      bound: undefined,
      adapters: { "claude-code": { default: true } },

      status_notify: undefined,

      bag_grant: "session",
    });
  });

  it("gives the run's session the caller's barry, traits and both bounds", async () => {
    const res = await post("survey-auth", { caller_session_id: "caller1" });

    expect(res.status).toBe(200);
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_id: 7,
        traits: ["coding", "readonly"],
        bound: { network: { enforce: "sandbox", allow: ["github.com"] } },
        bounds: ["readonly"],
        metadata: expect.objectContaining({ source: "action-executor", caller_session_id: "caller1" }),
      }),
    );
  });

  it("denies the subagent the native tools a session's own agent is denied, and passes its sandbox", async () => {
    const sandbox = { allowDomains: ["github.com"] };
    mockEgressSandbox.mockResolvedValueOnce(sandbox);

    await post("survey-auth", { caller_session_id: "caller1" });

    const config = mockRunStructured.mock.calls[0][0].config;
    expect(config.deniedTools).toEqual((await nativeToolPolicy({ id: "test", provider: "claude" })).denied);
    expect(config.deniedTools).toContain("Bash");
    // And refuses them when a hosted harness asks before running one.
    await expect(config.decide?.({ id: "1", tool: "Bash", input: {} })).resolves.toMatchObject({ allow: false });
    await expect(config.decide?.({ id: "2", tool: "mcp__barry__search", input: {} })).resolves.toEqual({ allow: true });
    expect(config.egressSandbox).toEqual(sandbox);
    expect(config.cwd).toBe(tmpdir());
    expect(config.maxTurns).toBe(50);
    // Resolved against the subagent's own row, which carries the caller's barry and traits.
    expect(mockEgressSandbox).toHaveBeenCalledWith(
      { id: mockSessionsCreate.mock.calls[0][0].id },
      expect.objectContaining({ provider: "claude" }),
    );
  });

  it("gives a caller with no barry no barry traits, rather than a default barry's", async () => {
    mockSessionsGet.mockResolvedValue(callerSession({ identity_id: null }));

    await post("survey-auth", { caller_session_id: "caller1" });

    const created = mockSessionsCreate.mock.calls[0][0];
    expect(created).not.toHaveProperty("identity_id");
    expect(mockEgressSandbox).toHaveBeenCalledWith({ id: created.id }, expect.anything());
  });

  it("records the run under its full name, with no bag, the definition and what it was allowed", async () => {
    await post("survey-auth", { caller_session_id: "caller1" });

    expect(mockRunsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "survey-auth@caller1",
        bag: null,
        metadata: expect.objectContaining({
          source: "adhoc",
          definition: expect.objectContaining({ prompt: "List every file that checks a token." }),
          caller_session_id: "caller1",
          grant: expect.objectContaining({ traits: ["coding", "readonly"], bounds: ["readonly"], narrowed: false }),
        }),
      }),
    );
  });

  it("records a session's agent run as a subagent job run, naming the session", async () => {
    await post("survey-auth", { caller_session_id: "caller1" });

    expect(mockRunsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "job",
        metadata: expect.objectContaining({ job: { kind: "subagent", caller_session_id: "caller1" } }),
      }),
    );
  });

  it("leaves a job run's own trigger alone, and does not call it a subagent", async () => {
    const action = { ...adhocMeta(), qualifiedName: "survey-auth@caller1" };
    await executeDetached(action, { caller_session_id: "caller1", trigger: "job" }, []);

    const created = mockRunsCreate.mock.calls[0][0];
    expect(created.trigger).toBe("job");
    expect(created.metadata).not.toHaveProperty("job");
  });

  it("narrows to a subset of the caller's traits", async () => {
    await post("survey-auth", { caller_session_id: "caller1", traits: ["readonly"] });
    expect(mockSessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ traits: ["readonly"] }));
  });

  it("refuses a trait the caller does not hold, and creates nothing", async () => {
    const res = await post("survey-auth", { caller_session_id: "caller1", traits: ["readonly", "admin"] });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("traits_not_held");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockRunsCreate).not.toHaveBeenCalled();
  });

  it("accepts the caller's own barry, and refuses any other", async () => {
    expect((await post("survey-auth", { caller_session_id: "caller1", identity_id: 7 })).status).toBe(200);

    const res = await post("survey-auth", { caller_session_id: "caller1", identity_id: 99 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("identity_not_allowed");
  });

  it("refuses an agent that cannot deny its own tools, and creates nothing", async () => {
    const { setAgentRuntime } = await import("../agent-runtime.js");
    setAgentRuntime({ createSession, runStructured: mockRunStructured, describeAdapter: id => {
      const record = describeShipped(id);
      return record ? { ...record, capabilities: { ...record.capabilities, toolDenial: "none" } } : undefined;
    } });
    const res = await post("survey-auth", { caller_session_id: "caller1", provider: "codex" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("unenforceable_grant");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    wireShippedHarnesses({ createSession, runStructured: mockRunStructured });
  });

  it("refuses a hook-only scoped subagent before creating a run", async () => {
    const res = await post("survey-auth", { caller_session_id: "caller1", provider: "antigravity" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "unenforceable_grant", message: expect.stringContaining("per-call native-tool ruling") });
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockRunsCreate).not.toHaveBeenCalled();
    expect(mockRunStructured).not.toHaveBeenCalled();
  });

  it("refuses to run from inside a detached run", async () => {
    mockSessionsGet.mockResolvedValue(callerSession({ metadata: { source: "action-executor" } }));

    const res = await post("survey-auth", { caller_session_id: "caller1" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nested_run");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("finds nothing for a request that names no caller, since ad-hoc actions are the caller's own", async () => {
    const res = await post("survey-auth", {});

    expect(res.status).toBe(404);
    expect(mockAdhocGet).not.toHaveBeenCalled();
  });

  it("refuses a bare name that both a bag and the caller define", async () => {
    mockFindAction.mockResolvedValue(actionMeta({ name: "survey-auth", qualifiedName: "web:survey-auth" }));

    const res = await post("survey-auth", { caller_session_id: "caller1" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("ambiguous_action");
  });

});

describe("POST /actions/:name/run — an installed action a session starts runs as that session", () => {
  beforeEach(() => {
    mockFindAction.mockResolvedValue(actionMeta());
    vi.mocked(AdhocActions.get).mockResolvedValue(null);
    vi.mocked(Sessions.get).mockResolvedValue(callerSession());
    mockRunStructured.mockResolvedValue({ data: "t", raw: '{"value":"t"}' });
    vi.mocked(identityRecords.config).mockReturnValue({
      bag_configs: {},
      secrets: {},
      vault: undefined,
      traits: [{ name: "barry-trait", optional: false }],
      bags: [],
      bounds: [],
      bound: undefined,
      adapters: { "claude-code": { default: true } },

      status_notify: undefined,

      bag_grant: "session",
    });
  });

  it("gets the caller's barry, traits, bounds and tool denials, not its bag's readwrite access", async () => {
    const res = await post("extract-title", { caller_session_id: "caller1" });

    expect(res.status).toBe(200);
    expect(mockSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_id: 7,
        traits: ["coding", "readonly"],
        bound: { network: { enforce: "sandbox", allow: ["github.com"] } },
        bounds: ["readonly"],
      }),
    );
    const config = mockRunStructured.mock.calls[0][0].config;
    expect(config.deniedTools).toEqual((await nativeToolPolicy({ id: "test", provider: "claude" })).denied);
    // Still the installed action's own directory and turn budget.
    expect(config.cwd).toBe("/tmp/actions/extract-title");
    expect(config.maxTurns).toBe(15);
    expect(mockRunsCreate.mock.calls[0][0]).toMatchObject({
      bag: "web",
      metadata: { caller_session_id: "caller1", grant: { traits: ["coding", "readonly"], bounds: ["readonly"] } },
    });
  });

  it("refuses a caller it cannot find, rather than falling back to the bag's access", async () => {
    vi.mocked(Sessions.get).mockResolvedValue(undefined);

    const res = await post("extract-title", { caller_session_id: "made-up" });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown_caller_session");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("refuses to run from inside a detached run", async () => {
    vi.mocked(Sessions.get).mockResolvedValue(callerSession({ metadata: { source: "action-executor" } }));

    const res = await post("extract-title", { caller_session_id: "caller1" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("nested_run");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("runs with its bag's access only when no session started it, as a schedule or the CLI does", async () => {
    await post("extract-title", {});

    const created = mockSessionsCreate.mock.calls[0][0];
    expect(created.traits).toEqual(["actions", "web"]);
    expect(created).not.toHaveProperty("bound");
    expect(created).not.toHaveProperty("bound_id");
    expect(mockRunStructured.mock.calls[0][0].config).not.toHaveProperty("deniedTools");
    // Nothing denied is not nothing allowed: a harness that asks first still runs its calls.
    await expect(mockRunStructured.mock.calls[0][0].config.decide?.({ id: "1", tool: "command_execution", input: {} })).resolves.toEqual({ allow: true });
    expect(mockRunsCreate.mock.calls[0][0].metadata).not.toHaveProperty("grant");
  });

  it("refuses `traits` without a calling session, since there is no access to narrow", async () => {
    const res = await post("extract-title", { traits: ["readonly"] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_caller_session");
  });
});


describe("session action catalog", () => {
  it("answers a placed session's actions in the existing entry shape", async () => {
    vi.mocked(sessionIdentity).mockReturnValue("default");
    const forSession = vi.fn(async () => [{ name: "local", qualifiedName: "local", bag: "", description: "Local action", executable: true, inputs: ["path"] }]);
    Barry.use(fakeIdentities({ get: async () => ({ id: 7, token: "fixture", name: "default", bags: ["web"], traits: [], displayName: null, bounds: [], adapters: {}, envKeys: [], vaultEmail: null, isDefault: false, createdAt: null, lastUsedAt: null }) }), fakeSessions(), { name: "actions", list: async () => [], forSession, run: async () => { throw new Error("unused"); }, runs: async () => [] });
    const response = await fetch(`${baseUrl}/actions/catalog?session_id=placed`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ actions: [{ name: "local", bag: "", input_names: ["path"] }], scope: { kind: "identity", identity: "default", bags: ["web"] } });
    expect(forSession).toHaveBeenCalledWith("default", "placed", expect.anything());
  });
  it("answers an unplaceable session with the action routes' 404 dialect", async () => {
    vi.mocked(sessionIdentity).mockReturnValue(undefined);
    const response = await fetch(`${baseUrl}/actions/catalog?session_id=missing`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "session_not_found" });
  });
});
