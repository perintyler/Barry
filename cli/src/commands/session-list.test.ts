import { afterEach, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@barry-rocks/sessions-bag/client", () => ({ listSessions: fixtures.list, Sessions: { parseMetadata: (meta: object) => meta } }));
import { sessionListCommand } from "./session.js";
afterEach(() => vi.restoreAllMocks());
it("lists live message-less sessions while hiding unprepared drafts", async () => {
  const row = { status: "pending", created_at: new Date(), metadata: {}, last_message_at: null, active: false, started_at: null };
  fixtures.list.mockResolvedValue([
    { ...row, id: "draft-hidden" },
    { ...row, id: "prepared-live", active: true },
    { ...row, id: "started-live", status: "running", started_at: new Date() },
    { ...row, id: "prompted-live", last_message_at: new Date() },
  ]);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await sessionListCommand();
  const text = output.mock.calls.flat().join("\n");
  expect(text).not.toContain("draft-hidden");
  for (const id of ["prepared-liv", "started-live", "prompted-liv"]) expect(text).toContain(id);
  expect(fixtures.list).toHaveBeenCalledWith({ limit: 200 });
});
