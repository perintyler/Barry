import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Barry, BarryError } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";

/**
 * `startSession` upserts: it creates a row when the session is new and updates
 * one when it already exists. The update branch used to build `metadataUpdates`
 * from cwd/directive/transcript/permission/provider/model and simply omit
 * `name`, so naming an EXISTING session through POST /sessions/start silently
 * did nothing — which is the path `barry resume --session-name ...` takes.
 *
 * These tests mock the storage layer so they pin the branch logic itself,
 * with no database involved.
 */

const existingSession = vi.fn();
const createSession = vi.fn();
const updateSession = vi.fn();
const createProviderSession = vi.fn();

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: (...a: unknown[]) => existingSession(...a),
  createSession: (...a: unknown[]) => createSession(...a),
  updateSession: (...a: unknown[]) => updateSession(...a),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMessageCount: vi.fn(),
  createProviderSession: (...a: unknown[]) => createProviderSession(...a),
}));


const { startSession } = await import("./index.js");

// The identities a new session may link to, and the named bounds it may record.
beforeEach(() => {
  vi.clearAllMocks();
  Barry.use(fakeIdentities({
    get: async (ref) => {
      if (ref === 7) return { id: 7, name: "bux" } as never;
      throw new BarryError("not_found", `Identity ${String(ref)} not found`);
    },
    bound: async (_ref, requested) => {
      const names = (requested ?? []).filter((entry): entry is string => typeof entry === "string");
      if (names.some(name => name !== "no-files")) throw new BarryError("invalid", "Unknown bound");
      if (names.includes("no-files")) {
        return { files: { deny: ["**/*"] } };
      }
      return {};
    },
  }));
});
afterEach(() => Barry.reset());

describe("startSession — existing session (update branch)", () => {
  beforeEach(() => {
    existingSession.mockResolvedValue({ id: "sess-1", bags: [], bounds: [], bound: null, identity_id: null, metadata: { working_directory: "/old" } });
  });

  it("applies an explicit name to a session that already exists", async () => {
    await startSession({ session_id: "sess-1", name: "fix OAuth in MCP" });

    expect(createSession).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledTimes(1);
    const [, updates] = updateSession.mock.calls[0];
    // The regression: this was undefined, so the rename was dropped.
    expect(updates.metadata?.name).toBe("fix OAuth in MCP");
  });

  it("preserves the existing metadata when merging the name in", async () => {
    await startSession({ session_id: "sess-1", name: "renamed" });

    const [, updates] = updateSession.mock.calls[0];
    expect(updates.metadata?.working_directory).toBe("/old");
  });

  it("does not touch the name when none is supplied", async () => {
    await startSession({ session_id: "sess-1", cwd: "/new" });

    const [, updates] = updateSession.mock.calls[0];
    // Guards the other direction: a nameless resume must not blank an
    // existing name. `metadata` is only set when something changed.
    expect(updates.metadata?.name).toBeUndefined();
    expect(updates.metadata?.working_directory).toBe("/new");
  });

  it("updates and pins the resolved bound when bounds is passed on resume", async () => {
    await startSession({ session_id: "sess-1", identity_id: 7, bounds: ["no-files"] });

    expect(updateSession).toHaveBeenCalledTimes(1);
    const [, updates] = updateSession.mock.calls[0];
    expect(updates.bounds).toEqual(["no-files"]);
    expect(updates.bound).toEqual({ files: { deny: ["**/*"] } });
  });
});

describe("startSession — new session (insert branch)", () => {
  beforeEach(() => {
    existingSession.mockResolvedValue(undefined);
  });

  it("records an explicit name on create", async () => {
    await startSession({ session_id: "sess-2", name: "brand new" });

    expect(updateSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0].metadata.name).toBe("brand new");
  });

  it("stores a null name when none is given", async () => {
    await startSession({ session_id: "sess-2" });

    expect(createSession.mock.calls[0][0].metadata.name).toBeNull();
  });

  it("stores a known bound, pins its resolved bound, and refuses an unknown bound", async () => {
    await startSession({ session_id: "sess-2", identity_id: 7, bounds: ["no-files"] });
    await expect(startSession({ session_id: "sess-3", identity_id: 8, bounds: ["unknown"] })).rejects.toThrow("Unknown bound");
    expect(createSession.mock.calls[0][0]).toMatchObject({
      identity_id: 7,
      bounds: ["no-files"],
      bound: { files: { deny: ["**/*"] } },
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * The mode is the only record of what a session's guarantees actually were:
 * hosted, guest-plus and guest differ in what Barry can capture, gate and
 * deliver. Re-deriving it later from what the adapter declares TODAY gives the
 * wrong answer for any session that ran before a declaration changed, so it
 * has to be stored at start.
 *
 * `SessionMetadata` carries an index signature, so a misspelled key here would
 * typecheck happily and store nothing readable — which is why these assert on
 * what reaches the storage call rather than on the input.
 */
describe("startSession — the mode a session ran in", () => {
  it("records the mode when creating a session", async () => {
    existingSession.mockResolvedValue(undefined);

    await startSession({ session_id: "sess-3", provider: "codex", mode: "hosted" });

    expect(createSession.mock.calls[0][0].metadata.mode).toBe("hosted");
  });

  it("records the mode when the session already exists", async () => {
    existingSession.mockResolvedValue({ id: "sess-1", bags: [], bounds: [], bound: null, identity_id: null, metadata: { working_directory: "/old" } });

    await startSession({ session_id: "sess-1", mode: "guest-plus" });

    const [, updates] = updateSession.mock.calls[0];
    expect(updates.metadata?.mode).toBe("guest-plus");
  });

  /**
   * Null is a real answer, not a gap: a session Barry did not launch (a
   * foreign guest) chose no mode, and inventing one would misreport its
   * guarantees. Distinguishable from a session whose mode went unrecorded.
   */
  it("stores a null mode for a session barry did not launch", async () => {
    existingSession.mockResolvedValue(undefined);

    await startSession({ session_id: "sess-4" });

    expect(createSession.mock.calls[0][0].metadata.mode).toBeNull();
  });

  /**
   * A resume that passes no mode must not ERASE the one already recorded.
   *
   * The update branch merges over existing metadata, so the surviving value
   * is the stored `hosted` rather than `undefined` — asserting `undefined`
   * here (the first draft of this test) described the merge backwards and
   * would have demanded the bug it was meant to prevent.
   */
  it("keeps the recorded mode when a later start supplies none", async () => {
    existingSession.mockResolvedValue({
      id: "sess-1",
      metadata: { working_directory: "/old", mode: "hosted" },
    });

    await startSession({ session_id: "sess-1", cwd: "/new" });

    const [, updates] = updateSession.mock.calls[0];
    expect(updates.metadata?.mode).toBe("hosted");
  });
});

describe("startSession — what a launch guaranteed", () => {
  const guarantees = { capture: "post-hoc", delivery: "tool-call", steer: false, interrupt: false, gating: "static", keepsVendorUi: true, identity: "mcp-url" };

  it("records the guarantees when creating a session", async () => {
    existingSession.mockResolvedValue(undefined);

    await startSession({ session_id: "sess-5", provider: "claude-code", mode: "guest", guarantees });

    expect(createSession.mock.calls[0][0].metadata.guarantees).toEqual(guarantees);
  });

  it("records the guarantees when the session already exists", async () => {
    existingSession.mockResolvedValue({ id: "sess-1", bags: [], bounds: [], bound: null, identity_id: null, metadata: { working_directory: "/old" } });

    await startSession({ session_id: "sess-1", mode: "guest", guarantees });

    const [, updates] = updateSession.mock.calls[0];
    expect(updates.metadata?.guarantees).toEqual(guarantees);
  });

  it("keeps the recorded guarantees when a later start supplies none", async () => {
    existingSession.mockResolvedValue({ id: "sess-1", bags: [], bounds: [], bound: null, identity_id: null, metadata: { working_directory: "/old", guarantees } });

    await startSession({ session_id: "sess-1", cwd: "/new" });

    const [, updates] = updateSession.mock.calls[0];
    expect(updates.metadata?.guarantees).toEqual(guarantees);
  });
});


describe("startSession — bags before hosted preparation", () => {
  it("writes bags and model provenance on create", async () => {
    existingSession.mockResolvedValue(undefined);
    await startSession({ session_id: "prepared", identity_id: 7, bags: ["git"], provider: "claude", model: "model", model_provider: "vendor", mode: "hosted" });
    expect(createSession.mock.calls[0][0]).toMatchObject({ bags: ["git"], metadata: { provider: "claude", model: "model", model_provider: "vendor", mode: "hosted" } });
  });
  it("clears bags explicitly on resume and preserves them on a hook without a selection", async () => {
    existingSession.mockResolvedValue({ id: "prepared", identity_id: 7, bags: ["git"], bounds: [], bound: null, metadata: {} });
    await startSession({ session_id: "prepared", bags: [] });
    expect(updateSession.mock.calls[0][1].bags).toEqual([]);
    await startSession({ session_id: "prepared", provider_session_id: "vendor-session" });
    expect(updateSession.mock.calls[1][1]).not.toHaveProperty("bags");
  });
});
