import { describe, expect, it, vi } from "vitest";
import { AgUiConnection } from "./connection.js";

function response(bytes: string, chunkSize = 3): Response {
  const encoded = new TextEncoder().encode(bytes);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i += chunkSize) controller.enqueue(encoded.slice(i, i + chunkSize));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
describe("AG-UI connection", () => {
  it("parses fragmented UTF-8 and CRLF frames with stable replay cursors", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response('id: 5:0\r\ndata: {"type":"TEXT_MESSAGE_CHUNK","messageId":"message","role":"assistant","delta":"héllo 👋"}\r\n\r\n'));
    const connection = new AgUiConnection({ baseUrl: "http://invalid.test/api/v2/sessions", secret: "instance-secret", fetch });
    const events = [];
    for await (const event of connection.subscribe("session", { after: "4:2" })) events.push(event);
    expect(events).toEqual([{ cursor: "5:0", event: { type: "TEXT_MESSAGE_CHUNK", messageId: "message", role: "assistant", delta: "héllo 👋" } }]);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://invalid.test/api/v2/sessions/session/events?after=4%3A2");
    connection.close();
    await expect(connection.snapshot("session")).rejects.toThrow("closed");
  });

  it("refuses incomplete and oversized frames", async () => {
    const incomplete = new AgUiConnection({ baseUrl: "http://invalid.test", fetch: async () => response('data: {"type":"RUN_ERROR","message":"failed"}') });
    await expect(async () => { for await (const _ of incomplete.subscribe("session")) { /* drain */ } }).rejects.toThrow("incomplete frame");
    const oversized = new AgUiConnection({ baseUrl: "http://invalid.test", maxFrameBytes: 10, fetch: async () => response('data: {"type":"RUN_ERROR","message":"too large"}\n\n') });
    await expect(async () => { for await (const _ of oversized.subscribe("session")) { /* drain */ } }).rejects.toThrow("frame limit");
  });

  it("counts UTF-8 bytes rather than characters when bounding a frame", async () => {
    const frame = `data: ${JSON.stringify({ type: "RUN_ERROR", message: "👋".repeat(30) })}\n\n`;
    const connection = new AgUiConnection({ baseUrl: "http://invalid.test", maxFrameBytes: frame.length + 10, fetch: async () => response(frame, 1) });
    await expect(async () => { for await (const _ of connection.subscribe("session")) { /* drain */ } }).rejects.toThrow("frame limit");
  });

  it("does not send a pre-cancelled operation or expose its private reason", async () => {
    const fetch = vi.fn();
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
    await expect(connection.snapshot("session", { signal: AbortSignal.abort("private-key") })).rejects.toMatchObject({ code: "cancelled", status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps permission errors and request IDs without retrying a write", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "scope_denied", message: "Missing sessions:turn" }, {
      status: 403, headers: { "x-request-id": "permission-request" },
    }));
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
    await expect(connection.cancel("session", "turn")).rejects.toMatchObject({ code: "scope_denied", status: 403, requestId: "permission-request" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels the response body when a consumer leaves the stream early", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('id: 1:0\ndata: {"type":"RUN_ERROR","message":"failed"}\n\n')); },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
    for await (const _ of connection.subscribe("session")) break;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("close cancels a paused stream immediately and refuses buffered delivery", async () => {
    const cancel = vi.fn();
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('id: 1:0\ndata: {"type":"RUN_ERROR","message":"one"}\n\nid: 2:0\ndata: {"type":"RUN_ERROR","message":"two"}\n\n')); },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream" } }) });
    const iterator = connection.subscribe("session")[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.cursor).toBe("1:0");
    connection.close();
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).rejects.toMatchObject({ code: "connection_closed" });
    await expect(connection.snapshot("session")).rejects.toMatchObject({ code: "connection_closed" });
  });

  it("cancellation releases a blocked read without waiting for another frame", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch: async () => {
      started();
      return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
    } });
    const controller = new AbortController();
    const iterator = connection.subscribe("session", { signal: controller.signal })[Symbol.asyncIterator]();
    const next = iterator.next();
    await startedPromise;
    await Promise.resolve();
    controller.abort("private reason");
    await expect(next).rejects.toMatchObject({ code: "cancelled" });
  });

  it("bounds connection time without exposing a fetch exception", async () => {
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", timeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private token")), { once: true });
    }) });
    await expect(connection.snapshot("session")).rejects.toMatchObject({ code: "timeout", status: null });
  });

  it("rejects malformed events without including their raw content", async () => {
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch: async () => response('id: 1:0\ndata: {"type":"PRIVATE_TOKEN"}\n\n') });
    const next = connection.subscribe("session")[Symbol.asyncIterator]().next();
    await expect(next).rejects.toMatchObject({ code: "malformed_response", message: "Invalid AG-UI event" });
  });

  it("waits for consumer demand before reading the next chunk", async () => {
    let reads = 0;
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new TextEncoder().encode(`id: ${reads}:0\ndata: {"type":"RUN_ERROR","message":"event"}\n\n`));
      },
    }, { highWaterMark: 0 }), { headers: { "Content-Type": "text/event-stream" } }) });
    const iterator = connection.subscribe("session")[Symbol.asyncIterator]();
    expect(reads).toBe(0);
    expect((await iterator.next()).value?.cursor).toBe("1:0");
    await Promise.resolve();
    expect(reads).toBe(1);
    expect((await iterator.next()).value?.cursor).toBe("2:0");
    await iterator.return?.();
  });

  it("reconnects GET from the delivered cursor and suppresses replay duplicates", async () => {
    const frame = (id: string) => `id: ${id}\ndata: {"type":"RUN_ERROR","message":"event"}\n\n`;
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(frame("1:0")))
      .mockResolvedValueOnce(response(frame("1:0") + frame("1:1") + frame("2:0")));
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
    const cursors = [];
    for await (const event of connection.subscribe("session", { reconnect: { maxAttempts: 1, delayMs: 0 } })) cursors.push(event.cursor);
    expect(cursors).toEqual(["1:0", "1:1", "2:0"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://fixture.test/session/events?after=1%3A0");
    expect(fetch.mock.calls.every(call => !call[1]?.method)).toBe(true);
  });

  it("does not reconnect on authorization or malformed event errors", async () => {
    for (const responseBody of [Response.json({}, { status: 401 }), response('id: 1:0\ndata: {"invalid":true}\n\n')]) {
      const fetch = vi.fn(async () => responseBody);
      const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
      await expect(connection.subscribe("session", { reconnect: { maxAttempts: 2, delayMs: 0 } })[Symbol.asyncIterator]().next()).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds retries of transient connection failures", async () => {
    const fetch = vi.fn(async () => { throw new Error("private network detail"); });
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
    await expect(connection.subscribe("session", { reconnect: { maxAttempts: 2, delayMs: 0 } })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "unreachable" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("close interrupts reconnect backoff and prevents another request", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const fetch = vi.fn(async () => response(""));
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch });
    try {
      const next = connection.subscribe("session", { reconnect: { maxAttempts: 1, delayMs: 30_000 } })[Symbol.asyncIterator]().next();
      await vi.waitFor(() => expect(timers).toHaveBeenCalledWith(expect.any(Function), 30_000));
      connection.close();
      await expect(next).rejects.toMatchObject({ code: "connection_closed" });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { connection.close(); timers.mockRestore(); }
  });

  it("reports malformed UTF-8 with the response request ID", async () => {
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch: async () => new Response(new Uint8Array([255]), {
      headers: { "Content-Type": "text/event-stream", "x-request-id": "invalid-encoding" },
    }) });
    await expect(connection.subscribe("session")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "malformed_response", status: 200, requestId: "invalid-encoding" });
  });

  it("releases an unopened body when the server answers with the wrong content type", async () => {
    const cancel = vi.fn();
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch: async () => new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "application/json" },
    }) });
    await expect(connection.subscribe("session")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "malformed_response" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([200, 403])("keeps response headers when a %s body exceeds the deadline", async status => {
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", timeoutMs: 10, fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("private body detail")), { once: true });
      },
    }), { status, headers: { "Content-Type": "application/json", "x-request-id": "body-deadline" } }) });
    await expect(connection.snapshot("session")).rejects.toMatchObject({ code: "timeout", status, requestId: "body-deadline" });
  });
});


describe("AG-UI credentials", () => {
  it("refreshes credentials on each reconnect", async () => {
    let count = 0;
    const resolveCredential = vi.fn(() => `token-${++count}`);
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(""));
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", resolveCredential, fetch });
    expect(resolveCredential).not.toHaveBeenCalled();
    for await (const _ of connection.subscribe("session", { reconnect: { maxAttempts: 1, delayMs: 1 } })) { /* drain */ }
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization"))).toEqual(["Bearer token-1", "Bearer token-2"]);
    connection.close();
  });

  it("closes while waiting for an uncooperative resolver without sending", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.fn();
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch, resolveCredential: () => { started(); return new Promise<string>(() => {}); } });
    const assertion = expect(connection.snapshot("session")).rejects.toMatchObject({ code: "connection_closed" });
    await ready;
    connection.close();
    await assertion;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes credential resolution in the header deadline", async () => {
    const fetch = vi.fn();
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch, resolveCredential: () => new Promise<string>(() => {}) });
    await expect(connection.snapshot("session", { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    expect(fetch).not.toHaveBeenCalled();
    connection.close();
  });

  it("redacts resolver failures without retrying subscriptions", async () => {
    const fetch = vi.fn();
    const resolveCredential = vi.fn(() => { throw new Error("private-key"); });
    const connection = new AgUiConnection({ baseUrl: "https://fixture.test", fetch, resolveCredential });
    await expect(async () => { for await (const _ of connection.subscribe("session", { reconnect: { maxAttempts: 3, delayMs: 1 } })) { /* drain */ } }).rejects.toMatchObject({ code: "credential_error", message: "Barry credential could not be resolved" });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    connection.close();
  });
});
