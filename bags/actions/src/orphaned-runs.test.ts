import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The abandoned-run sweep, after it stopped being a SQL join.
 *
 * It cannot be one `NOT EXISTS (SELECT ... FROM sessions WHERE endedAt IS
 * NULL)` statement: `action_runs` and `sessions` live in different databases
 * -- sessions behind the sessions bag's client, `action_runs` in this bag's
 * own store -- so the decision is TypeScript, and this is where it can be
 * pinned.
 *
 * These tests mock both sides deliberately. The old suite ran against a live
 * database because the decision WAS the join, and a TypeScript-only test would
 * have passed with the join written backwards. What a database test would
 * check instead is that `getSession` returns what the store holds, which is
 * the sessions client's own suite.
 *
 * The case that matters most is the third one: reading "the store has no such
 * session" as "the session ended" would fail a run that is still working.
 */

const listStartedActionRuns = vi.fn();
const abandonActionRuns = vi.fn();
const getSession = vi.fn();

// What this suite pins is the DECISION, not either store.
vi.mock("./action-runs.js", () => ({
  listStartedActionRunsWithSession: (...a: unknown[]) => listStartedActionRuns(...a),
  abandonActionRuns: (...a: unknown[]) => abandonActionRuns(...a),
}));

vi.mock("@barry-rocks/sdk/stores", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/stores")>(),
  sessionIdentity: vi.fn(() => "identity"),
}));
import { Barry } from "@barry-rocks/sdk";
import { fakeSessions } from "@barry-rocks/sdk/testing";
import { sessionIdentity } from "@barry-rocks/sdk/stores";

const { abandonOrphanedActionRuns } = await import("./orphaned-runs.js");

/** Only the two fields the sweep reads. */
function session(ended: string | null): { id: string; endedAt: string | null } {
  return { id: "s1", endedAt: ended };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sessionIdentity).mockReturnValue("identity");
  Barry.use(fakeSessions({ get: async (_identity, id) => getSession(id) }));
  abandonActionRuns.mockResolvedValue([]);
});

afterEach(() => Barry.reset());

describe("abandonOrphanedActionRuns", () => {
  it("leaves unplaceable and unreachable sessions alone", async () => {
    listStartedActionRuns.mockResolvedValue([{ id: "run-1", session_id: "s1" }]);
    vi.mocked(sessionIdentity).mockReturnValue(undefined);
    expect(await abandonOrphanedActionRuns()).toBe(0);
    expect(getSession).not.toHaveBeenCalled();
    vi.mocked(sessionIdentity).mockReturnValue("identity");
    getSession.mockRejectedValue(new Error("unreachable"));
    expect(await abandonOrphanedActionRuns()).toBe(0);
    expect(abandonActionRuns).toHaveBeenCalledWith([]);
  });

  it("sweeps a run whose session has ended", async () => {
    listStartedActionRuns.mockResolvedValue([{ id: "run-1", session_id: "s1" }]);
    getSession.mockResolvedValue(session(new Date().toISOString()));
    abandonActionRuns.mockResolvedValue([{ id: "run-1" }]);

    expect(await abandonOrphanedActionRuns()).toBe(1);
    expect(abandonActionRuns).toHaveBeenCalledWith(["run-1"]);
  });

  it("leaves a run alone while its session is still live", async () => {
    listStartedActionRuns.mockResolvedValue([{ id: "run-1", session_id: "s1" }]);
    getSession.mockResolvedValue(session(null));

    expect(await abandonOrphanedActionRuns()).toBe(0);
    // Asserted on the ARGUMENT, not just the count: calling it with an empty
    // list would satisfy a count-only check while still being a bug.
    expect(abandonActionRuns).toHaveBeenCalledWith([]);
  });

  it("leaves a run alone when the store has never heard of its session", async () => {
    // The regression this refactor exists to prevent. `undefined` here is
    // "no answer", which is equally consistent with an unreachable store or
    // one pointed at the wrong path -- never proof that a session ended.
    listStartedActionRuns.mockResolvedValue([{ id: "run-1", session_id: "s1" }]);
    getSession.mockResolvedValue(undefined);

    expect(await abandonOrphanedActionRuns()).toBe(0);
    expect(abandonActionRuns).toHaveBeenCalledWith([]);
  });

  it("sweeps only the ended sessions out of a mixed batch", async () => {
    listStartedActionRuns.mockResolvedValue([
      { id: "run-ended", session_id: "s-ended" },
      { id: "run-live", session_id: "s-live" },
      { id: "run-unknown", session_id: "s-gone" },
    ]);
    getSession.mockImplementation(async (id: string) => {
      if (id === "s-ended") return { id, endedAt: new Date().toISOString() };
      if (id === "s-live") return { id, endedAt: null };
      return undefined;
    });
    abandonActionRuns.mockResolvedValue([{ id: "run-ended" }]);

    expect(await abandonOrphanedActionRuns()).toBe(1);
    expect(abandonActionRuns).toHaveBeenCalledWith(["run-ended"]);
  });

  it("sweeps only the run named, when one is", async () => {
    // Checking one run must not close another as a side effect of reading it.
    listStartedActionRuns.mockResolvedValue([
      { id: "run-checked", session_id: "s-ended" },
      { id: "run-other", session_id: "s-ended" },
    ]);
    getSession.mockResolvedValue({ id: "s-ended", endedAt: new Date().toISOString() });
    abandonActionRuns.mockResolvedValue([{ id: "run-checked" }]);

    expect(await abandonOrphanedActionRuns("run-checked")).toBe(1);
    expect(abandonActionRuns).toHaveBeenCalledWith(["run-checked"]);
  });

  it("does not query the store when there are no candidates", async () => {
    // An unattributed run never reaches here -- the db-side query filters
    // `session_id IS NULL` out -- so an empty list must cost nothing.
    listStartedActionRuns.mockResolvedValue([]);

    expect(await abandonOrphanedActionRuns()).toBe(0);
    expect(getSession).not.toHaveBeenCalled();
    expect(abandonActionRuns).not.toHaveBeenCalled();
  });
});
