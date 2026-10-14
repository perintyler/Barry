import { describe, expect, it, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; last_message_at: string; metadata: Record<string, unknown> }>,
  counts: new Map<string, number>(),
  metadata: new Map<string, Record<string, unknown>>(),
}));
vi.mock("@barry-rocks/sessions-bag/client", () => ({
  listSessions: vi.fn(async () => store.sessions),
  getSessionMessageCounts: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, store.counts.get(id) ?? 0]))),
  updateSessionMetadata: vi.fn(async (id: string, update: Record<string, unknown>) => { store.metadata.set(id, update); }),
  getSession: vi.fn(),
  buildSessionHistoryContext: vi.fn(),
}));

const { summarizeQuietSessions } = await import("./session-summarizer.js");

const now = new Date("2026-10-07T12:00:00Z");
const quiet = new Date(now.getTime() - 20 * 60_000).toISOString();

beforeEach(() => {
  store.sessions = ["a", "b", "c"].map((id) => ({ id, last_message_at: quiet, metadata: {} }));
  store.counts = new Map([["a", 4], ["b", 9], ["c", 2]]);
  store.metadata.clear();
});

describe("summarizeQuietSessions", () => {
  it("summarizes due sessions up to the cap, watermarking past its own summary", async () => {
    const persisted: string[] = [];
    const result = await summarizeQuietSessions({
      now, maxSessions: 2, freeBytes: () => 64 * 1024 ** 3,
      generate: async (id) => ({ content: `### Done\n- ${id}`, status: "idle" }),
      persist: async (id) => { persisted.push(id); store.counts.set(id, (store.counts.get(id) ?? 0) + 1); },
    });
    expect(result).toEqual({ considered: 3, summarized: 2 });
    expect(persisted).toEqual(["a", "b"]);
    expect(store.metadata.get("a")).toMatchObject({ summary_watermark_seq: 5 });
    expect(store.metadata.has("c")).toBe(false);
  });

  it("stops when the machine cannot hold the model", async () => {
    const generate = vi.fn();
    const result = await summarizeQuietSessions({ now, freeBytes: () => 1024, generate, persist: vi.fn() });
    expect(result).toMatchObject({ summarized: 0, refused: "insufficient-memory" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("watermarks a session with nothing to say, so it is not asked again until it changes", async () => {
    await summarizeQuietSessions({ now, maxSessions: 1, freeBytes: () => 64 * 1024 ** 3, generate: async () => null, persist: vi.fn() });
    expect(store.metadata.get("a")).toMatchObject({ summary_watermark_seq: 4 });
  });
  it("leaves a session whose remote summary failed or is still running for the next sweep, and skips the local memory check", async () => {
    const result = await summarizeQuietSessions({
      now, on: "workers", maxSessions: 3, freeBytes: () => 0,
      generate: async (id, watermark) => { if (id === "a") throw new Error(`summary run summary-a-${watermark} is still pending`); return { content: `### Done\n- ${id}`, status: "idle" }; },
      persist: async (id) => { store.counts.set(id, (store.counts.get(id) ?? 0) + 1); },
    });
    expect(result).toEqual({ considered: 3, summarized: 2 });
    expect(store.metadata.has("a")).toBe(false);
    expect(store.metadata.get("b")).toMatchObject({ summary_watermark_seq: 10 });
  });
});
