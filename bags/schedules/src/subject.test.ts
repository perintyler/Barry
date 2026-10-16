import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBagRegistrySnapshot: vi.fn(async () => ({ bags: [] })),
  loadAllBags: vi.fn(async () => []),
  getInvalidManifests: vi.fn(() => new Map()),
}));
vi.mock("@barry-rocks/sdk/internal/actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/actions")>(),
  findAction: vi.fn(async () => ({ bag: "ops", qualifiedName: "ops:task", name: "task", context: "none" })),
}));
import { findAction } from "@barry-rocks/sdk/internal/actions";
import { schedules } from "./subject.js";
import { scheduleAt } from "./once.js";
import { closeDb, setDb } from "./db.js";
import { insertRuntimeSchedule, updateState, writeHeartbeat } from "./store.js";
import { getAtSchedule } from "./at-schedules.js";

beforeEach(() => { vi.clearAllMocks(); setDb(new Database(":memory:")); });
afterEach(() => { closeDb(); Barry.reset(); });
it("resolves an identity before storing an at-schedule and maps it back", async () => {
  const get = vi.fn(async () => ({ id: 7, name: "bux" }) as never);
  Barry.use(fakeIdentities({ get }));
  const row = await schedules.scheduleAt({ action: "ops:task", identity: 7, dueAt: new Date("2026-10-10T00:00:00Z") }, { kind: "owner" });
  expect(get).toHaveBeenCalledWith(7, { kind: "owner" });
  expect(getAtSchedule(row.id)?.permissions).toMatchObject({ identity: "bux", identityId: 7 });
  const { attempts: _attempts, ...listed } = row;
  expect(await schedules.atSchedules({ status: "pending", limit: 1 }, { kind: "owner" })).toEqual([listed]);
  expect(row.dueAt).toBe("2026-10-10T00:00:00.000Z");
});
it("rejects an unknown or non-detachable action before creating work", async () => {
  vi.mocked(findAction).mockResolvedValueOnce(null);
  await expect(scheduleAt({ action: "unknown", dueAt: "2026-10-10T00:00:00Z" })).rejects.toMatchObject({ reason: "not_found" });
  vi.mocked(findAction).mockResolvedValueOnce({ qualifiedName: "ops:task", context: "session" } as never);
  await expect(scheduleAt({ action: "ops:task", dueAt: "2026-10-10T00:00:00Z" })).rejects.toMatchObject({ reason: "invalid" });
});
it("refuses devices before reading schedules", async () => {
  await expect(schedules.list({ kind: "device", deviceId: "d", identityIds: [] } as never)).rejects.toMatchObject({ reason: "forbidden" });
});

it("maps recurring state and scheduler health without losing failure counters", async () => {
  insertRuntimeSchedule("nightly", { every: "1h", action: "ops:task" }, null);
  const at = new Date("2026-10-10T00:00:00Z");
  updateState("runtime/nightly", { paused: true, next_fire_at: at, last_status: "failed", consecutive_failures: 2, skipped_fires: 3, missed_fires: 4 });
  writeHeartbeat(1, []);
  expect(await schedules.list({ kind: "owner" })).toMatchObject([{ id: "runtime/nightly", paused: true, nextFireAt: at.toISOString(), lastStatus: "failed", consecutiveFailures: 2, skippedFires: 3, missedFires: 4 }]);
  expect(await schedules.scheduler({ kind: "owner" })).toMatchObject({ status: "ok", reason: null, loadErrors: [] });
});

it("filters by bag and preserves retry attempts", async () => {
  const row = await schedules.scheduleAt({ action: "ops:task", dueAt: "2026-10-10T00:00:00Z", attempts: 3 }, { kind: "owner" });
  expect(row.retryAttempts).toBe(3);
  expect(await schedules.atSchedules({ bag: "other" }, { kind: "owner" })).toEqual([]);
  expect(await schedules.atSchedules({ bag: "ops" }, { kind: "owner" })).toMatchObject([{ id: row.id }]);
});
it("refuses retry attempts the wire schema refuses", async () => {
  for (const attempts of [0, 6, 2.5]) {
    await expect(schedules.scheduleAt({ action: "ops:task", dueAt: "2026-10-10T00:00:00Z", attempts }, { kind: "owner" })).rejects.toMatchObject({ reason: "invalid" });
  }
  expect(await schedules.atSchedules({}, { kind: "owner" })).toEqual([]);
});
it("cancels pending work and refuses unknown ids and devices", async () => {
  Barry.use(schedules);
  const row = await Barry.scheduleAt({ action: "ops:task", dueAt: "2026-10-10T00:00:00Z" });
  expect(await Barry.atSchedule(row.id).cancel()).toMatchObject({ id: row.id, status: "cancelled", reason: "cancelled" });
  await expect(Barry.atSchedule("missing").cancel()).rejects.toMatchObject({ reason: "not_found" });
  await expect(Barry.as({ kind: "device" } as never).atSchedule(row.id).cancel()).rejects.toMatchObject({ reason: "forbidden" });
});
