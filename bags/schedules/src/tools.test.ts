import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { setDb, closeDb } from "./db.js";
import { getAtSchedule, listAtSchedules } from "./at-schedules.js";
import { createScheduleTool, runScheduleTool } from "./tools.js";

beforeEach(() => setDb(new Database(":memory:")));
afterAll(() => closeDb());

const create = (name: string, spec: Record<string, unknown>) =>
  createScheduleTool.handler({ name, spec }, { sessionId: "sess_1" } as never);

describe("create_schedule", () => {
  it.each([{ at: "2030-01-01T09:00:00Z" }, { every: "1h" }])("rejects identity-free, bag-free schedules at creation: %j", async trigger => {
    await expect(create("missing-permissions", { ...trigger, action: "ops:x" })).rejects.toThrow("an identity-free schedule must explicitly select bags");
    expect(listAtSchedules()).toEqual([]);
  });
  it("makes an at: schedule a one-off of the named action, keyed by its name", async () => {
    const spec = { bags: ["bash"], at: "2030-01-01T09:00:00Z", action: "sessions:watch-tick", inputs: { sessionId: "s1" } };
    const made = (await create("watch:s1:2030-01-01T09:00:00Z", spec)) as { id: string };
    expect(getAtSchedule(made.id)).toMatchObject({
      bag: "sessions",
      action: "sessions:watch-tick",
      inputs: { sessionId: "s1" },
      idempotencyKey: "runtime:watch:s1:2030-01-01T09:00:00Z",
      createdBy: "sess_1",
    });
    // Repeating the same create returns the same one-off rather than a second.
    await create("watch:s1:2030-01-01T09:00:00Z", spec);
    expect(listAtSchedules()).toHaveLength(1);
  });

  it("accepts an inline action for a one-off with a free-form name", async () => {
    const made = (await create("Remind me: standup", {
      at: "2030-01-01T09:00:00Z",
      bags: ["bash"],
      action: { description: "Remind", run: { command: "barry", args: ["notify", "standup"] } },
      retry: { attempts: 2 },
    })) as { id: string };
    expect(getAtSchedule(made.id)).toMatchObject({ bag: "runtime", action: null, retryAttempts: 2 });
  });

  it("requires a kebab-case name for a recurring schedule, whose name is its id", async () => {
    await expect(create("Nightly Thing", { every: "1h", action: "ops:x" })).rejects.toThrow(/kebab-case/);
  });
});

it("persists shorthand one-off scripts as runnable authored actions", async () => {
  const made = await create("Maintenance script", { at: "2030-01-01T09:00:00Z", bags: ["bash"], entry: "task.ts", secrets: ["API_KEY"], env: ["MODE=fast"], timeout: "5m" }) as { id: string };
  expect(getAtSchedule(made.id)?.inlineAction).toEqual({ description: "task.ts", run: { entry: "task.ts" }, secrets: ["API_KEY"], env: ["MODE=fast"], timeout: 300 });
});

afterEach(() => vi.unstubAllGlobals());
it("runs an extension schedule using its last slash and an encoded bag segment", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ run_id: "arn_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  expect(await runScheduleTool.handler({ id: "sessions/search/embed" }, {} as never)).toEqual({ run_id: "arn_1" });
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/schedules\/sessions%2Fsearch\/embed\/run$/), expect.objectContaining({ method: "POST" }));
});
