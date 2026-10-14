import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateBarrySecret } from "./internal.js";

describe("secrets", () => {
  describe("generateBarrySecret", () => {
    it("produces a prefixed, high-entropy token", () => {
      const a = generateBarrySecret();
      const b = generateBarrySecret();
      expect(a).toMatch(/^barry_[A-Za-z0-9_-]{32}$/);
      expect(a).not.toBe(b);
    });
  });
});

describe("secret-dependent auth", () => {
  const SECRET = "barry_testsecret_abcdefghijklmnop";
  let mod: typeof import("./internal.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("BARRY_SECRET", SECRET);
    mod = await import("./internal.js");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a WebSocket from loopback or a private network without the secret: no address is trusted", () => {
    expect(mod.isAuthenticatedWs(undefined)).toBe(false);
    expect(mod.isAuthenticatedWs("wrong")).toBe(false);
  });

  it("accepts a WebSocket that presents the secret", () => {
    expect(mod.isAuthenticatedWs(SECRET)).toBe(true);
  });

  it("observes rotation and removal without reimporting the module", () => {
    expect(mod.verifyInstallationCredential(SECRET)).toBe(true);
    const rotated = "barry_rotatedsecret_abcdefghijklmnop";
    vi.stubEnv("BARRY_SECRET", rotated);
    expect(mod.verifyInstallationCredential(SECRET)).toBe(false);
    expect(mod.isAuthenticatedWs(SECRET)).toBe(false);
    expect(mod.verifyInstallationCredential(rotated)).toBe(true);
    expect(mod.hasValidSecret({ headers: { authorization: `Bearer ${rotated}` } } as never)).toBe(true);
    vi.stubEnv("BARRY_SECRET", "");
    expect(mod.verifyInstallationCredential(rotated)).toBe(false);
    expect(mod.isAuthenticatedWs(rotated)).toBe(false);
    const response = makeRes();
    mod.barryAuth({ path: "/mcp", headers: { authorization: `Bearer ${rotated}` } } as never, response.res as never, () => { throw new Error("Unexpected admission"); });
    expect(response.statusCode).toBe(500);
  });

  it("refuses ambiguous HTTP credentials even when one contains the installation secret", () => {
    for (const authorization of [`Bearer ${SECRET} ignored`, "Basic wrong", "Bearer wrong"]) {
      expect(mod.hasValidSecret({ headers: { authorization, "x-barry-secret": SECRET } } as never)).toBe(false);
    }
    expect(mod.hasValidSecret({ headers: { authorization: `Bearer ${SECRET}` }, rawHeaders: ["Authorization", `Bearer ${SECRET}`, "Authorization", "Bearer wrong"] } as never)).toBe(false);
  });

  it("refuses an HTTP request from loopback without the secret", () => {
    const loopback = { ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    expect(mod.isAuthenticated(loopback as never)).toBe(false);
    expect(mod.isAuthenticated({ ...loopback, headers: { authorization: `Bearer ${SECRET}` } } as never)).toBe(true);
  });

  it("barryAuth passes /health without a secret", () => {
    let nextCalled = false;
    const res = makeRes();
    mod.barryAuth(
      { path: "/health", headers: {} } as never,
      res.res as never,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it("barryAuth rejects a request with no secret", () => {
    let nextCalled = false;
    const res = makeRes();
    mod.barryAuth(
      { path: "/mcp", headers: {} } as never,
      res.res as never,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("barryAuth accepts a valid bearer secret", () => {
    let nextCalled = false;
    const res = makeRes();
    mod.barryAuth(
      { path: "/mcp", headers: { authorization: `Bearer ${SECRET}` } } as never,
      res.res as never,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("barryAuth accepts a valid x-barry-secret header", () => {
    let nextCalled = false;
    const res = makeRes();
    mod.barryAuth(
      { path: "/mcp", headers: { "x-barry-secret": SECRET } } as never,
      res.res as never,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });
});

function makeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return { json: (b: unknown) => { state.body = b; } };
    },
  };
  return { res, get statusCode() { return state.statusCode; }, get body() { return state.body; } };
}
