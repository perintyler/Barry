import { createServer } from "node:http";
import { preCreateSession } from "./launch-context.js";
import { describe, expect, it, vi } from "vitest";
import { classifySkew, ensureApiCurrent, type ApiHealth } from "./api-skew.js";
const ours = { version: "1.2.0", commit: "ours", stores: { sessions: 20 } };
const health = (schema: number, version = "1.2.0", commit = "ours"): ApiHealth => ({ build: { schema: { sessions: schema }, release: { version, commit } } });
describe("API skew evidence", () => {
  it.each([
    [health(20), "none"], [health(19), "api-older"], [health(21), "api-newer"],
    [health(20, "1.1.0", "old"), "api-older"], [health(20, "1.3.0", "new"), "api-newer"],
    [health(20, "1.2.0", "different"), "unknown"], [undefined, "unknown"],
  ] as const)("classifies %j as %s", (value, kind) => expect(classifySkew(ours, { health: value }).kind).toBe(kind));
  it("recognizes legacy migration errors while leaving unrelated errors unknown", () => {
    expect(classifySkew(ours, { errorText: "sessions.db is at version 20, but this build only knows 19" })).toMatchObject({ kind: "api-older", detail: "sessions.db v20 vs 19" });
    expect(classifySkew(ours, { errorText: "connection refused" }).kind).toBe("unknown");
  });
  it("compares development builds by schema without inventing commit order", () => {
    expect(classifySkew({ stores: { sessions: 20 } }, { health: { build: { release: null, schema: { sessions: 20 } } } }).kind).toBe("none");
    expect(classifySkew(ours, { health: health(21, "1.1.0", "old") }).kind).toBe("api-newer");
  });
});
describe("API currency guard", () => {
  const deps = (values: (ApiHealth | undefined)[]) => ({ base: "http://127.0.0.1:9", fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(values.shift() ?? {}))), restart: vi.fn(async () => {}), write: vi.fn() });
  it("starts health immediately and restarts once before create", async () => {
    const d = deps([health(19), health(20)]), guard = ensureApiCurrent(ours, d);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await guard.beforeCreate(); expect(d.restart).toHaveBeenCalledTimes(1);
    expect(d.write).toHaveBeenCalledWith(expect.stringContaining("older build"));
    await expect(guard.retryCreate("sessions.db is at version 20, but this build only knows 19")).rejects.toThrow("still running an older build");
    expect(d.restart).toHaveBeenCalledTimes(1);
  });
  it("uses legacy error evidence to recover after the first create", async () => {
    const d = deps([undefined, health(20)]), guard = ensureApiCurrent(ours, d);
    await guard.beforeCreate(); expect(d.restart).not.toHaveBeenCalled();
    expect(await guard.retryCreate("sessions.db is at version 20, but this build only knows 19")).toBe(true);
    expect(d.restart).toHaveBeenCalledTimes(1);
  });
  it("does not make an extra health request after a connection failure", async () => {
    const d = deps([undefined]), guard = ensureApiCurrent(ours, d);
    await guard.beforeCreate(); expect(await guard.retryCreate("fetch failed")).toBe(false);
    expect(d.fetch).toHaveBeenCalledTimes(1); expect(d.restart).not.toHaveBeenCalled();
  });
  it("makes a transport failure optional for an unbound guest", async () => {
    const d = deps([undefined]);
    vi.mocked(d.fetch!).mockRejectedValue(new TypeError("fetch failed"));
    const guard = ensureApiCurrent(ours, d);
    await expect(guard.beforeCreate(false)).resolves.toMatchObject({ ok: false, warning: expect.stringContaining("Could not reach") });
    await expect(guard.beforeCreate()).resolves.toEqual({ ok: true });
    expect(d.write).toHaveBeenCalledWith(expect.stringContaining("attempting session creation"));
    expect(d.restart).not.toHaveBeenCalled();
  });
  it("refuses newer APIs without restarting", async () => {
    const d = deps([health(21)]);
    await expect(ensureApiCurrent(ours, d).beforeCreate()).rejects.toThrow("newer build");
    expect(d.restart).not.toHaveBeenCalled();
  });
  it("respects the option and environment opt-outs", async () => {
    for (const noRestart of [true, false]) {
      if (!noRestart) vi.stubEnv("BARRY_NO_SERVICE_RESTART", "1");
      try {
        const d = deps([health(19)]);
        await expect(ensureApiCurrent(ours, { ...d, noRestart }).beforeCreate()).rejects.toThrow("automatic restart is disabled");
        expect(d.restart).not.toHaveBeenCalled();
      } finally { vi.unstubAllEnvs(); }
    }
  });
  it("reports restart failure with an actionable command", async () => {
    const d = deps([health(19)]); d.restart.mockRejectedValueOnce(new Error("launchctl refused"));
    await expect(ensureApiCurrent(ours, d).beforeCreate()).rejects.toThrow("barry service restart sessions.api");
  });
  it("bounds polling and leaves a still-old service as a clear failure", async () => {
    let clock = 0; const d = deps([health(19), health(19), health(19)]);
    await expect(ensureApiCurrent(ours, { ...d, now: () => clock, sleep: async () => { clock += 100; }, pollMs: 200 }).beforeCreate()).rejects.toThrow("did not become current");
    expect(d.restart).toHaveBeenCalledTimes(1);
  });
});

it("retries a legacy create refusal over HTTP after one restart", async () => {
  let restarted = false, creates = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.startsWith("/health")) response.end(JSON.stringify(restarted ? health(20) : {}));
    else {
      creates++;
      response.statusCode = restarted ? 200 : 500;
      response.end(JSON.stringify(restarted ? {} : { detail: "sessions.db is at version 20, but this build only knows 19" }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const restart = vi.fn(async () => { restarted = true; });
    const guard = ensureApiCurrent(ours, { base, restart, write: () => {} });
    await guard.beforeCreate();
    const input = { sessionId: "retry", cwd: "/tmp", source: "cli", identityId: 1, selectedBounds: [], provider: "claude" };
    const deps = { fetch, endpoint: `${base}/sessions/start`, headers: {} };
    const first = await preCreateSession(input, deps);
    expect(first.ok).toBe(false);
    expect(await guard.retryCreate(first.warning!)).toBe(true);
    expect((await preCreateSession(input, deps)).ok).toBe(true);
    expect(creates).toBe(2); expect(restart).toHaveBeenCalledTimes(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("does not restart when the store itself exceeds this CLI", () => {
  expect(classifySkew(ours, { errorText: "sessions.db is at version 21, but this build only knows 19" }).kind).toBe("api-newer");
});

it("continues hosted creation when health accepts TCP but never responds", async () => {
  let creates = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/health")) return;
    creates++;
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const base = `http://127.0.0.1:${address.port}`, restart = vi.fn(), write = vi.fn();
    const started = performance.now();
    await expect(ensureApiCurrent(ours, { base, restart, write }).beforeCreate()).resolves.toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`within 1.5 s at ${base}`));
    const input = { sessionId: "slow-health", cwd: "/tmp", source: "cli", identityId: 1, selectedBounds: [], provider: "claude", mode: "hosted" as const };
    expect((await preCreateSession(input, { fetch, endpoint: `${base}/sessions/start`, headers: {} })).ok).toBe(true);
    expect(creates).toBe(1);
    expect(restart).not.toHaveBeenCalled();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("uses liveness without querying history, and falls back for an older server", async () => {
  const urls: string[] = [];
  const request = vi.fn<typeof fetch>(async url => {
    urls.push(String(url));
    if (String(url).endsWith("/health/live")) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(health(20)));
  });
  await ensureApiCurrent(ours, { base: "http://127.0.0.1:9", fetch: request }).beforeCreate();
  expect(urls).toEqual(["http://127.0.0.1:9/health/live", "http://127.0.0.1:9/health"]);
});

it("lets required creation report its own transport failure after an advisory probe failure", async () => {
  const request = vi.fn<typeof fetch>(async () => { throw new TypeError("connection refused"); });
  const restart = vi.fn(), write = vi.fn();
  const guard = ensureApiCurrent(ours, { base: "http://127.0.0.1:9", fetch: request, restart, write });
  await expect(guard.beforeCreate()).resolves.toEqual({ ok: true });
  const input = { sessionId: "unreachable", cwd: "/tmp", source: "cli", identityId: 1, selectedBounds: ["readonly"], provider: "claude" };
  await expect(preCreateSession(input, { fetch: request, endpoint: "http://127.0.0.1:9/sessions/start", headers: {} })).resolves.toMatchObject({ ok: false, warning: expect.stringContaining("connection refused") });
  expect(request).toHaveBeenCalledTimes(2);
  expect(restart).not.toHaveBeenCalled();
});
