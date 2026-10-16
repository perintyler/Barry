import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Barry, type AtScheduleInput, type AtSchedule } from "@barry-rocks/sdk";
import { fakeSchedules } from "@barry-rocks/sdk/testing";

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: vi.fn(async (id: string) => (id === "sess_gone" ? null : { id })),
}));

import {
  resolveDue,
  deliverScheduledPrompt,
  deliveredText,
  schedulePrompt,
  listScheduledPrompts,
  DELIVER_PROMPT_ACTION,
} from "./scheduled-prompts.js";

const NOW = new Date("2026-09-25T12:00:00Z");

describe("resolveDue", () => {
  it("reads `in` as a duration from now", () => {
    expect(resolveDue({ in: "20m" }, NOW)).toEqual(new Date("2026-09-25T12:20:00Z"));
    expect(resolveDue({ in: "2h" }, NOW)).toEqual(new Date("2026-09-25T14:00:00Z"));
  });

  it("reads `at` as a time, refusing the past", () => {
    expect(resolveDue({ at: "2026-09-25T13:00:00Z" }, NOW)).toEqual(new Date("2026-09-25T13:00:00Z"));
    expect(resolveDue({ at: "2026-09-25T11:00:00Z" }, NOW)).toMatch(/in the past/);
  });

  it("wants exactly one of them, and a real duration", () => {
    expect(resolveDue({}, NOW)).toMatch(/exactly one/);
    expect(resolveDue({ in: "20m", at: "2026-09-25T13:00:00Z" }, NOW)).toMatch(/exactly one/);
    expect(resolveDue({ in: "soon" }, NOW)).toMatch(/not a duration/);
    expect(resolveDue({ in: "60d" }, NOW)).toMatch(/30 days/);
  });
});

function fakeFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : {} });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

describe("deliverScheduledPrompt", () => {
  const inputs = { sessionId: "sess_1", prompt: "Is the deploy green yet?", scheduledAt: "2026-09-25T11:40:00Z" };

  it("posts the prompt through the session message route, keyed by the schedule", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true, status: "running" } }]);
    const result = await deliverScheduledPrompt(inputs, { apiBase: "http://api/v1", secret: "s", scheduleId: "sch_1", fetch: fn });
    expect(calls[0]).toEqual({
      url: "http://api/v1/sessions/sess_1/message",
      body: { content: deliveredText(inputs), clientMessageId: "schedule:sch_1" },
    });
    expect(calls).toHaveLength(1);
    expect(result).toMatch(/delivered/);
  });

  it("records a notification when the session is live in a terminal and can only queue it", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true, status: "active-elsewhere" } }, { status: 201, body: {} }]);
    const result = await deliverScheduledPrompt(inputs, { apiBase: "http://api/v1", secret: "s", scheduleId: "sch_1", fetch: fn });
    expect(calls[1]).toMatchObject({ url: "http://api/v1/events", body: { type: "notification", title: "Scheduled check-in is waiting" } });
    expect(result).toMatch(/queued/);
  });

  it("fails the run when the API refuses, so the schedule retries", async () => {
    const { fn } = fakeFetch([{ status: 404, body: { ok: false, error: "Session not found" } }]);
    await expect(deliverScheduledPrompt(inputs, { apiBase: "http://api/v1", secret: "s", scheduleId: "sch_1", fetch: fn })).rejects.toThrow(/404 Session not found/);
  });

  it("delivers via AG-UI v2 with ifActive: queue when apiBase targets v2", async () => {
    const { fn, calls } = fakeFetch([{ status: 202, body: { id: "turn_queued_1", state: "queued" } }]);
    const result = await deliverScheduledPrompt(inputs, { apiBase: "http://api/v2/sessions", secret: "s", scheduleId: "sch_1", fetch: fn });
    expect(calls[0].url).toBe("http://api/v2/sessions/sess_1/ag-ui");
    expect(calls[0].body).toMatchObject({
      threadId: "sess_1",
      runId: "schedule:sch_1",
      forwardedProps: { barry: { ifActive: "queue" } },
    });
    expect(result).toBe("delivered to sess_1 (queued)");
  });

  it("falls back to v1 message route when AG-UI v2 returns 404", async () => {
    const { fn, calls } = fakeFetch([
      { status: 404, body: { error: "Not Found" } },
      { status: 200, body: { ok: true, status: "running" } },
    ]);
    const result = await deliverScheduledPrompt(inputs, { apiBase: "http://api/v2/sessions", secret: "s", scheduleId: "sch_1", fetch: fn });
    expect(calls[0].url).toBe("http://api/v2/sessions/sess_1/ag-ui");
    expect(calls[1].url).toBe("http://api/v1/sessions/sess_1/message");
    expect(result).toMatch(/delivered/);
  });
});

describe("schedule_prompt", () => {
  const scheduleAt = vi.fn(async (input: AtScheduleInput): Promise<AtSchedule> => ({
    id: "sch_9", bag: "sessions", action: input.action, inputs: input.inputs ?? {},
    dueAt: new Date(input.dueAt).toISOString(), createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    status: "pending", reason: null, idempotencyKey: null, timeoutS: 600, retryAttempts: input.attempts ?? 1, failures: 0, recoveries: 0,
  }));
  const atSchedules = vi.fn(async (): Promise<AtSchedule[]> => []);
  beforeEach(() => { vi.clearAllMocks(); Barry.use(fakeSchedules({ scheduleAt, atSchedules })); });
  afterEach(() => Barry.reset());
  it("books a schedule of deliver-prompt for the current session", async () => {
    const result = await schedulePrompt.handler({ prompt: "check the deploy", in: "20m" }, { sessionId: "sess_1" } as never);
    expect(scheduleAt).toHaveBeenCalledWith(expect.objectContaining({
      action: DELIVER_PROMPT_ACTION, inputs: expect.objectContaining({ sessionId: "sess_1", prompt: "check the deploy" }), attempts: 3,
    }), { kind: "owner" });
    expect(result).toMatchObject({ scheduled: true, id: "sch_9", sessionId: "sess_1" });
  });
  it("refuses a session that does not exist, without booking anything", async () => {
    await expect(schedulePrompt.handler({ prompt: "p", in: "20m", sessionId: "sess_gone" }, {} as never)).rejects.toThrow(/not found/);
    expect(scheduleAt).not.toHaveBeenCalled();
  });
  it("asks for the sessions bag's pending prompts or its full history", async () => {
    await listScheduledPrompts.handler({}, { sessionId: "sess_1" } as never);
    expect(atSchedules).toHaveBeenLastCalledWith({ bag: "sessions", status: "pending" }, { kind: "owner" });
    await listScheduledPrompts.handler({ all: true }, { sessionId: "sess_1" } as never);
    expect(atSchedules).toHaveBeenLastCalledWith({ bag: "sessions", limit: 200 }, { kind: "owner" });
  });
});
