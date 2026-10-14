import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./store.js", () => ({ listEvents: vi.fn(), createEvent: vi.fn() }));
import { listEvents, createEvent } from "./store.js";
import { events } from "./subject.js";

const record = {
  id: "e1", seq: 1, type: "progress", session_id: "s1", source: "api", title: "progress",
  body: null, severity: "info", data: {}, metadata: {}, delivered_via: [], read_at: null, created_at: new Date("2026-10-01T00:00:00Z"),
};
beforeEach(() => vi.clearAllMocks());

it("maps event queries, cursor pages and domain timestamps", async () => {
  vi.mocked(listEvents).mockResolvedValue(Array.from({ length: 51 }, (_, i) => ({ ...record, id: `e${i}`, seq: i })));
  const page = await events.list({ session: "s1", type: "progress", unread: true }, null, { kind: "owner" });
  expect(page.items).toHaveLength(50);
  expect(page.items[0]).toMatchObject({ sessionId: "s1", createdAt: record.created_at.toISOString() });
  expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", unreadOnly: true, limit: 51 }));
  await events.list({}, page.next, { kind: "owner" });
  expect(listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ before: { createdAt: record.created_at.toISOString(), id: "e49", seq: 49 } }));
});

it("records with the API source and defaults", async () => {
  vi.mocked(createEvent).mockResolvedValue(record);
  await events.record({ type: "progress", title: "progress", session: "s1" }, { kind: "owner" });
  expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ session_id: "s1", source: "api", severity: "info" }));
});

it("refuses devices before touching the store", async () => {
  const caller = { kind: "device", principal: {} } as never;
  await expect(events.list({}, null, caller)).rejects.toMatchObject({ reason: "forbidden" });
  await expect(events.record({ type: "progress", title: "progress" }, caller)).rejects.toMatchObject({ reason: "forbidden" });
  expect(listEvents).not.toHaveBeenCalled();
  expect(createEvent).not.toHaveBeenCalled();
});
