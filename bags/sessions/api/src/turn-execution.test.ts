import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Barry, type Grants } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
interface Records {
  row: Record<string, unknown>;
  active: Record<string, unknown> | undefined;
  process: Record<string, unknown> | null;
  liveness: Record<string, unknown>;
}
const fixture = vi.hoisted(() => {
  const records: Records = { row: {}, active: undefined, process: null, liveness: { state: "alive" } };
  const granted: Grants = { traits: ["git-read"], bound: null, namespaces: ["git"], tools: [], skills: [], instructions: [] };
  return Object.assign(records, {
    start: vi.fn(async (_config: unknown) => ({ provider: "fixture" })),
    mcp: vi.fn(async () => ({ barry: { command: "fixture", args: [] } })),
    granted,
    grants: vi.fn(async (): Promise<Grants> => granted),
    authorize: vi.fn(async (principal: unknown) => principal),
  });
});
vi.mock("@barry-rocks/sessions-bag/execution-authorization", () => ({ authorizeSessionExecution: fixture.authorize }));
vi.mock("./db.js", () => ({ getSessionRecord: async () => fixture.row }));
vi.mock("./session-runtime.js", () => ({ sessionRuntime: { getActiveSession: () => fixture.active, startSession: fixture.start } }));
vi.mock("./mcp-config.js", () => ({ sessionMcpServers: fixture.mcp }));
// The sessions bag reads the same row when it composes the session's grants.
vi.mock("@barry-rocks/sessions-bag/client", () => ({ Processes: { getLive: async () => fixture.process }, getSession: async () => fixture.row }));
vi.mock("@barry-rocks/sessions-bag/process-liveness", () => ({ classify: () => fixture.liveness, readProcessStartTime: () => 100 }));
const { prepareTurnSession } = await import("./turn-execution.js");

beforeEach(() => {
  fixture.row = { active: false, state: "open", identity_id: 1, traits: ["git-read"], metadata: { working_directory: "/fixture/repository", provider: "pi", model: "fixture-model", model_provider: "fixture-vendor" } };
  fixture.active = undefined; fixture.process = null; fixture.liveness = { state: "alive" };
  fixture.start.mockClear(); fixture.mcp.mockClear(); fixture.authorize.mockClear(); fixture.grants.mockClear();
  Barry.use(fakeIdentities({ grants: fixture.grants }));
});
afterEach(() => Barry.reset());

describe("shared continuation session preparation", () => {
  it("prepares an inert open session with its granted MCP tools and model route", async () => {
    await prepareTurnSession("session");
    // The row's grants, asked of its identity, are what its MCP servers are built from.
    expect(fixture.grants).toHaveBeenCalledWith(1, expect.objectContaining({ traits: ["git-read"], harness: "pi" }), { kind: "owner" });
    expect(fixture.mcp).toHaveBeenCalledWith("session", fixture.granted);
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ prepareOnly: true, prompt: "", traits: ["git-read"], provider: "pi", model: "fixture-model", modelProvider: "fixture-vendor", mcpServers: { barry: { command: "fixture", args: [] } } }), undefined);
  });

  it("rechecks a supplied principal before returning an existing active session", async () => {
    fixture.active = { provider: "fixture" };
    const principal = { kind: "installation", actorId: 1, credentialId: "installation" } as const;
    fixture.authorize.mockRejectedValueOnce(new Error("Ownership changed"));
    await expect(prepareTurnSession("session", principal)).rejects.toThrow("Ownership changed");
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.authorize).toHaveBeenCalledWith(principal, { sessionId: "session" });
  });

  it("passes the verified principal separately to runtime preparation", async () => {
    const principal = { kind: "installation", actorId: 1, credentialId: "installation" } as const;
    await prepareTurnSession("session", principal);
    expect(fixture.authorize).toHaveBeenCalledWith(principal, { sessionId: "session" });
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", prepareOnly: true }), principal);
  });

  it("refuses live and unknown external drivers rather than starting a competing harness", async () => {
    fixture.process = { pid: process.pid + 1, pidStartedAt: 100, hostname: "fixture" };
    for (const liveness of [{ state: "alive" }, { state: "unknown", reason: "other-host" }]) {
      fixture.liveness = liveness;
      await expect(prepareTurnSession("session")).rejects.toThrow("live or its liveness is unknown");
    }
    expect(fixture.start).not.toHaveBeenCalled();
    fixture.liveness = { state: "dead", reason: "no-process" };
    await prepareTurnSession("session"); expect(fixture.start).toHaveBeenCalledTimes(1);
  });

  it("requires explicit reopening of closed sessions and lets legacy work drain", async () => {
    fixture.row.state = "closed";
    await expect(prepareTurnSession("session")).rejects.toThrow("not open");
    fixture.active = { pendingTurns: 1 };
    await expect(prepareTurnSession("session")).rejects.toThrow("legacy turn");
    expect(fixture.start).not.toHaveBeenCalled();
  });
});
