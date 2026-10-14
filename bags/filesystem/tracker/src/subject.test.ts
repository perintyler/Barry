import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry, BarryError } from "@barry-rocks/sdk";
import { fakeSessions } from "@barry-rocks/sdk/testing";
const ONE = [{ session_id: "s1", file_path: "/repo/a", tool: "Edit", created_at: "2026-10-01 12:00:00" }];
const stored = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("./db.js", () => ({ getDb: () => ({ prepare: () => ({ all: () => stored.rows }) }) }));
import { tracker } from "./subject.js";
beforeEach(() => { stored.rows = ONE; });
afterEach(() => Barry.reset());

it("checks ownership before mapping SQLite UTC changes", async () => {
  const get = vi.fn(async () => ({ id: "s1" }) as never);
  Barry.use(fakeSessions({ get }));
  expect(await tracker.changes("bux", "s1", { kind: "owner" })).toEqual([
    { sessionId: "s1", path: "/repo/a", tool: "Edit", at: "2026-10-01T12:00:00.000Z" },
  ]);
  expect(get).toHaveBeenCalledWith("bux", "s1", { kind: "owner" });
});

it("propagates the sessions subject's refusal", async () => {
  Barry.use(fakeSessions({ get: async () => { throw new BarryError("not_found", "wrong identity"); } }));
  await expect(tracker.changes("other", "s1", { kind: "owner" })).rejects.toMatchObject({ reason: "not_found" });
});

it("maps the originating session on the last change to a file", async () => {
  expect(await tracker.lastChanges(["/repo/a"], { kind: "owner" })).toEqual([
    { sessionId: "s1", path: "/repo/a", tool: "Edit", at: "2026-10-01T12:00:00.000Z" },
  ]);
});

it("refuses a device reading last changes", async () => {
  await expect(tracker.lastChanges(["/repo/a"], {
    kind: "device", principal: { kind: "device", credentialId: "d", actorId: 1, identityIds: [1], scopes: ["sessions:read"] },
  })).rejects.toMatchObject({ reason: "forbidden" });
});

it("names only the caller's own identity's sessions on the last change to a file", async () => {
  stored.rows = [
    { session_id: "mine", file_path: "/repo/a", tool: "Edit", created_at: "2026-10-01 12:00:00" },
    { session_id: "sibling", file_path: "/repo/b", tool: "Edit", created_at: "2026-10-01 12:00:01" },
    { session_id: "theirs", file_path: "/repo/c", tool: "Write", created_at: "2026-10-01 12:00:02" },
    { session_id: "gone", file_path: "/repo/d", tool: "Write", created_at: "2026-10-01 12:00:03" },
  ];
  const get = vi.fn(async (_identity: unknown, id: string, _caller: unknown) => {
    if (id === "theirs") throw new BarryError("forbidden", "A session may read only its own identity");
    if (id === "gone") throw new BarryError("not_found", "Session gone not found");
    return { id } as never;
  });
  Barry.use(fakeSessions({ get }));
  const caller = { kind: "session", identity: "bux", sessionId: "mine" } as const;
  const changes = await tracker.lastChanges(["/repo/a", "/repo/b", "/repo/c", "/repo/d"], caller);
  expect(changes.map(change => [change.path, change.sessionId])).toEqual([
    ["/repo/a", "mine"], ["/repo/b", "sibling"], ["/repo/c", null], ["/repo/d", null],
  ]);
  // The caller's own session needs no lookup; every other one is asked as the caller.
  expect(get.mock.calls).toEqual([
    ["bux", "sibling", caller], ["bux", "theirs", caller], ["bux", "gone", caller],
  ]);
});

it("reports a sessions outage rather than hiding the session", async () => {
  stored.rows = [{ session_id: "other", file_path: "/repo/a", tool: "Edit", created_at: "2026-10-01 12:00:00" }];
  Barry.use(fakeSessions({ get: async () => { throw new BarryError("unavailable", "sessions store offline"); } }));
  await expect(tracker.lastChanges(["/repo/a"], { kind: "session", identity: "bux", sessionId: "mine" }))
    .rejects.toMatchObject({ reason: "unavailable" });
});
