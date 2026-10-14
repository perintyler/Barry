import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { announceEvent } from "./announce.js";
import { setInProcessPublisher } from "@barry-rocks/sdk/events";

beforeEach(() => {
  setInProcessPublisher(null);
  vi.stubEnv("BARRY_SECRET", "test_secret");
  vi.restoreAllMocks();
});
afterEach(() => {
  setInProcessPublisher(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("in-process (the API's own writes)", () => {
  it("publishes directly and reports the subscriber count", async () => {
    const publish = vi.fn().mockReturnValue(3);
    setInProcessPublisher(publish);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await announceEvent("evt_1")).toEqual({ ok: true, queued: 3 });
    expect(publish).toHaveBeenCalledWith("events", "evt_1", "created");
    // Must not HTTP itself over loopback.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a publisher that throws instead of failing the write", async () => {
    setInProcessPublisher(() => {
      throw new Error("bus exploded");
    });
    expect(await announceEvent("evt_1")).toEqual({ ok: false, reason: "bus exploded" });
  });

  it("reaching zero subscribers is success, not failure", async () => {
    setInProcessPublisher(() => 0);
    expect(await announceEvent("evt_1")).toEqual({ ok: true, queued: 0 });
  });
});

describe("cross-process (CLI, MCP server, launchd jobs)", () => {
  it("posts to the announce endpoint and returns the queued count", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, queued: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await announceEvent("evt_x")).toEqual({ ok: true, queued: 2 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/events\/evt_x\/announce$/);
    expect(init.method).toBe("POST");
    expect(init.headers["x-barry-secret"]).toBe("test_secret");
    expect(init.redirect).toBe("error");
  });

  /** A one-shot CLI must not hang on a stopped API. */
  it("bounds the request with a timeout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await announceEvent("evt_x");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("names a missing secret rather than reporting a bare 403", async () => {
    vi.stubEnv("BARRY_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await announceEvent("evt_x")).toEqual({ ok: false, reason: "BARRY_SECRET not set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    expect(await announceEvent("evt_gone")).toEqual({ ok: false, reason: "announce endpoint returned 404" });
  });

  it("reports an unreachable API rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await announceEvent("evt_x")).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });
});
