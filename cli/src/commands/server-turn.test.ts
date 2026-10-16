/**
 * The one-shot a harness hands to the server reaches it in requests the API
 * accepts. Checked against the API's own request schemas: the message used to
 * name the harness, the strict schema rejected it, and every such run failed
 * with "Unrecognized key" before starting.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AttachRendererRequestSchema,
  DetachRendererRequestSchema,
  SendMessageRequestSchema,
  UpdateSessionRequestSchema,
} from "@barry-rocks/sdk/internal/sessions";
import { attachToHostedSession, detachFromHostedSession, detachWhenGone, startServerTurn, postSessionMessage } from "../sessions/launch.js";


function recordingApi(status: Record<string, number> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fake: typeof fetch = async (url, init) => {
    const path = String(url).replace("http://api.test/api/v1", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: JSON.parse(String(init?.body ?? "null")) });
    const code = status[`${method} ${path}`] ?? 200;
    return new Response(JSON.stringify(code === 200 ? { ok: true } : { detail: `refused ${method}` }), { status: code });
  };
  return { calls, api: { base: "http://api.test/api/v1", headers: {}, fetch: fake } };
}

const TURN = { harness: "codex", model: "qwen3:4b", modelProvider: "ollama", prompt: "do it", repoPath: "/repo" };

describe("startServerTurn", () => {
  it("retries an uncertain send with the same client message id", async () => {
    const bodies: string[] = [];
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("connection reset after admission");
      return new Response("{}", { status: 200 });
    });
    await postSessionMessage("s1", { content: "hello" }, { base: "http://api.test", headers: {}, fetch: request });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]).clientMessageId).toBeTruthy();
  });
  it("allows cold message admission to take longer than ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>(() => new Promise(resolve => setTimeout(() => resolve(new Response("{}")), 12_000)));
      const response = postSessionMessage("s1", { content: "hello" }, { base: "http://api.test", headers: {}, fetch: request });
      await vi.advanceTimersByTimeAsync(12_001);
      expect((await response).ok).toBe(true);
      expect(request).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("records the harness and model on the session, then sends only the message", async () => {
    const { calls, api } = recordingApi();

    expect(await startServerTurn("s1", TURN, api)).toBeNull();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["PATCH /sessions/s1", "POST /sessions/s1/message"]);
    expect(UpdateSessionRequestSchema.parse(calls[0]?.body)).toMatchObject({ provider: "codex", model: "qwen3:4b", modelProvider: "ollama" });
    expect(SendMessageRequestSchema.safeParse(calls[1]?.body).success).toBe(true);
  });

  it("does not send the message when the session could not be told its harness", async () => {
    const { calls, api } = recordingApi({ "PATCH /sessions/s1": 422 });

    expect(await startServerTurn("s1", TURN, api)).toBe("refused PATCH");
    expect(calls).toHaveLength(1);
  });

  it("reports the server's reason when the message is refused", async () => {
    const { api } = recordingApi({ "POST /sessions/s1/message": 409 });

    expect(await startServerTurn("s1", TURN, api)).toBe("refused POST");
  });
});

describe("attaching a TUI to the hosted session", () => {
  const ATTACHMENT = { attachmentId: "a-1", address: "/tmp/engine.sock", harnessSessionId: "thread-1" };

  function attachingApi(status: Record<string, number> = {}) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fake: typeof fetch = async (url, init) => {
      const path = String(url).replace("http://api.test/api/v1", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: JSON.parse(String(init?.body ?? "null")) });
      const code = status[`${method} ${path}`] ?? 200;
      if (code !== 200) return new Response(JSON.stringify({ detail: `refused ${method} ${path}` }), { status: code });
      return new Response(JSON.stringify(path.endsWith("/attach") ? ATTACHMENT : { message: "ok" }), { status: 200 });
    };
    return { calls, api: { base: "http://api.test/api/v1", headers: {}, fetch: fake } };
  }

  it("records the harness, then attaches for this process", async () => {
    const { calls, api } = attachingApi();
    expect(await attachToHostedSession("s1", { harness: "codex", model: "gpt-5.5" }, api)).toEqual(ATTACHMENT);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["PATCH /sessions/s1", "POST /sessions/s1/attach"]);
    expect(AttachRendererRequestSchema.parse(calls[1]?.body)).toEqual({ launcherPid: process.pid });
  });
  it("allows cold attachment preparation beyond five seconds", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<typeof fetch>(async (_url, init) => init?.method === "PATCH"
        ? new Response("{}")
        : new Promise<Response>(resolve => setTimeout(() => resolve(new Response(JSON.stringify(ATTACHMENT))), 6000)));
      const attachment = attachToHostedSession("s1", { harness: "codex" }, { base: "http://api.test/api/v1", headers: {}, fetch: request });
      await vi.advanceTimersByTimeAsync(6001);
      expect(await attachment).toEqual(ATTACHMENT);
    } finally { vi.useRealTimers(); }
  });

  it("does not attach when the session could not be told its harness, and says why it was refused", async () => {
    const refusedPatch = attachingApi({ "PATCH /sessions/s1": 422 });
    await expect(attachToHostedSession("s1", { harness: "codex" }, refusedPatch.api)).rejects.toThrow("refused PATCH");
    expect(refusedPatch.calls).toHaveLength(1);
    const refusedAttach = attachingApi({ "POST /sessions/s1/attach": 409 });
    await expect(attachToHostedSession("s1", { harness: "codex" }, refusedAttach.api)).rejects.toThrow("refused POST /sessions/s1/attach");
  });

  it("detaches with the attachment's id, and an unreachable API does not stop the exit", async () => {
    const { calls, api } = attachingApi();
    await detachFromHostedSession("s1", "a-1", api);
    expect(DetachRendererRequestSchema.parse(calls[0]?.body)).toEqual({ attachmentId: "a-1" });
    await expect(detachFromHostedSession("s1", "a-1", { ...api, fetch: () => Promise.reject(new Error("down")) })).resolves.toBeUndefined();
  });

  it("detaches once however the TUI goes, before leaving", async () => {
    const order: string[] = [];
    const run = () => {
      const child = Object.assign(new EventEmitter(), { kill: () => { order.push("kill"); return true; } });
      const signals = new EventEmitter();
      detachWhenGone(child, async () => void order.push("detach"), (code) => order.push(`leave ${code}`), signals);
      return { child, signals };
    };

    const neverStarted = run();
    neverStarted.child.emit("error", new Error("spawn codex ENOENT"));
    neverStarted.child.emit("close", -2);
    await vi.waitFor(() => expect(order).toEqual(["detach", "leave 1"]));

    order.length = 0;
    const stopped = run();
    stopped.signals.emit("SIGTERM");
    await vi.waitFor(() => expect(order).toEqual(["kill", "detach", "leave 0"]));
  });
});
