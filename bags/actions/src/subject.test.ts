import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities, fakeSessions } from "@barry-rocks/sdk/testing";
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: vi.fn(async () => ({ bags: [] })),
  expandCompositionFromSnapshot: vi.fn(async () => ["git"]),
}));
vi.mock("@barry-rocks/sdk/internal/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/actions")>(),
  listAllActions: vi.fn(async () => []),
}));
vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  instanceEnvValue: () => "test",
  getServiceUrl: () => "http://example.test",
}));

vi.mock("./adhoc-actions.js", () => ({ AdhocActions: { list: vi.fn(async () => []) } }));
vi.mock("./action-runs.js", () => ({ ActionRuns: { list: vi.fn(async () => []), get: vi.fn() } }));
vi.mock("./orphaned-runs.js", () => ({ abandonOrphanedActionRuns: vi.fn(async () => 0) }));
import { listAllActions } from "@barry-rocks/sdk/internal/actions";
import { BarryClient } from "@barry-rocks/sdk/internal/client";
import { AdhocActions } from "./adhoc-actions.js";
import { actions } from "./subject.js";
import { ActionRuns } from "./action-runs.js";
import { abandonOrphanedActionRuns } from "./orphaned-runs.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => { Barry.reset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("omits shadowed actions from the unscoped list", async () => {
  vi.mocked(listAllActions).mockResolvedValue([
    { name: "visible", qualifiedName: "git:visible", source: "bag", bag: "git", description: "visible", shadowed: false },
    { name: "shadow", shadowed: true },
  ] as never);
  expect((await actions.list({ kind: "owner" })).map(a => a.name)).toEqual(["visible"]);
});

it("checks the session before scoping the catalog to its identity bags", async () => {
  const get = vi.fn(async () => ({ id: "s1" }) as never);
  Barry.use(fakeSessions({ get }), fakeIdentities({ get: async () => ({ bags: ["filesystem"] }) as never }));
  vi.mocked(AdhocActions.list).mockResolvedValueOnce([{ name: "adhoc", qualifiedName: "adhoc", description: "ad hoc", source: "adhoc" }] as never);
  vi.mocked(listAllActions).mockResolvedValueOnce([{ name: "installed", qualifiedName: "git:installed", description: "installed", source: "bag", bag: "git" }] as never);
  expect((await actions.forSession("bux", "s1", { kind: "owner" })).map(a => a.name)).toEqual(["adhoc", "installed"]);
  expect(get).toHaveBeenCalledWith("bux", "s1", { kind: "owner" });
  expect(listAllActions).toHaveBeenLastCalledWith([], { bagNames: ["git"] });
});

it("sweeps before filtering recorded runs", async () => {
  await actions.runs({ schedule: "git/nightly", limit: 7 }, { kind: "owner" });
  expect(abandonOrphanedActionRuns).toHaveBeenCalled();
  expect(ActionRuns.list).toHaveBeenCalledWith({ action: undefined, schedule_id: "git/nightly", limit: 7 });
  expect(vi.mocked(abandonOrphanedActionRuns).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ActionRuns.list).mock.invocationCallOrder[0]);
});

it("forwards identity and session caller, then maps the stored action run", async () => {
  const run = vi.fn(async () => ({ runId: "r1" }));
  vi.spyOn(BarryClient, "connect").mockReturnValue({ actions: { run } } as never);
  vi.mocked(ActionRuns.get).mockResolvedValueOnce({ id: "r1", action: "ops:task", session_id: "s1", status: "complete", summary: "done", started_at: new Date("2026-10-01T00:00:00Z"), completed_at: new Date("2026-10-01T00:00:02Z"), output: "ok" } as never);
  const result = await actions.run("ops:task", { x: 1 }, { identity: 7 }, { kind: "session", identity: "bux", sessionId: "s1" });
  expect(run).toHaveBeenCalledWith("ops:task", { inputs: { x: 1 }, identity: 7, callerSessionId: "s1" });
  expect(result).toMatchObject({ status: "succeeded", summary: "done", output: "ok", endedAt: "2026-10-01T00:00:02.000Z" });
});
it("refuses devices before running actions", async () => {
  await expect(actions.run("ops:task", {}, {}, { kind: "device" } as never)).rejects.toMatchObject({ reason: "forbidden" });
});
