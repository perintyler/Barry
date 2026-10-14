import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeRequest, revalidateRequestAuthorization, type RequestAuthorizationOptions } from "./http.js";
import { requestCredential } from "./credentials.js";
import { hasIdentityGrant, type AuthPrincipal } from "./principal.js";

const device = { kind: "device", credentialId: "device-a", actorId: 7, identityIds: [12], scopes: ["identities:read"] };
const servers: Server[] = [];
const heldResponses: Response[] = [];
afterEach(async () => {
  for (const response of heldResponses.splice(0)) if (!response.destroyed && !response.writableEnded) response.end();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

async function serve(options: Partial<RequestAuthorizationOptions> = {}) {
  const app = express();
  app.use(authorizeRequest({
    verifyCredential: credential => credential === "valid" ? device : null,
    policy: request => request.path === "/identities/12" ? {
      scopes: ["identities:read"], authorize: principal => hasIdentityGrant(principal, 12),
    } : null,
    ...options,
  }));
  app.use((request, response) => response.json({ principal: request.authPrincipal, frozen: Object.isFrozen(request.authPrincipal), mutable: Object.getOwnPropertyDescriptor(request, "authPrincipal")?.writable }));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return (path = "/identities/12", token = "valid", signal?: AbortSignal) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { authorization: `Bearer ${token}` }, signal });
}

async function openRequest(options: Partial<RequestAuthorizationOptions> = {}) {
  let admitted!: (value: { request: Request; response: Response }) => void;
  const ready = new Promise<{ request: Request; response: Response }>(resolve => { admitted = resolve; });
  const app = express();
  app.use(authorizeRequest({ verifyCredential: token => token === "valid" ? device : null,
    policy: () => ({ scopes: ["identities:read"], authorize: () => true }), ...options }));
  app.use("/mounted", (request, response) => {
    heldResponses.push(response);
    response.flushHeaders();
    admitted({ request, response });
  });
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const result = await fetch(`http://127.0.0.1:${address.port}/mounted/identities/12`, { headers: { Authorization: "Bearer valid" } });
  expect(result.status).toBe(200);
  return ready;
}

describe("transport authorization revalidation", () => {
  it("refuses a synchronous verifier result that arrives after its deadline", async () => {
    let calls = 0;
    let elapsed = 0;
    const authorize = vi.fn(() => true);
    const { request } = await openRequest({ timeoutMs: 5000, verifyCredential: () => {
      if (++calls > 1) elapsed = 5001;
      return device;
    }, policy: () => ({ scopes: ["identities:read"], authorize }) });
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
    try {
      expect(await revalidateRequestAuthorization(request)).toBe(false);
      expect(authorize).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
  it("uses the original credential and route after mounting or header changes", async () => {
    const verify = vi.fn((token: string) => token === "valid" ? device : null);
    const authorize = vi.fn((_principal: AuthPrincipal, request: Request) => request.path === "/mounted/identities/12" && request.method === "GET");
    const selected = { scopes: ["identities:read" as const], authorize };
    const { request } = await openRequest({ verifyCredential: verify, policy: () => selected });
    request.url = "/other";
    request.method = "POST";
    request.headers.authorization = "Bearer wrong";
    selected.scopes.splice(0);
    expect(await revalidateRequestAuthorization(request)).toBe(true);
    expect(verify).toHaveBeenLastCalledWith("valid", expect.any(AbortSignal));
    expect(request.authPrincipal).toEqual(device);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("detects rotated installation credentials and rejects changed actor attribution", async () => {
    let actorId = 7;
    let valid = true;
    const { request } = await openRequest({ verifyCredential: () => valid ? { kind: "installation", actorId, credentialId: "installation" } : null });
    expect(await revalidateRequestAuthorization(request)).toBe(true);
    actorId = 8;
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    actorId = 7; valid = false;
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    expect(request.authPrincipal?.actorId).toBe(7);
  });

  it("accepts grant reordering but refuses expansions, reductions and ownership loss", async () => {
    let current = { ...device, identityIds: [12, 13], scopes: ["identities:read", "sessions:read"] };
    let allowed = true;
    const { request } = await openRequest({ verifyCredential: () => current, policy: () => ({ scopes: ["identities:read"], authorize: () => allowed }) });
    current = { ...current, identityIds: [13, 12], scopes: ["sessions:read", "identities:read"] };
    expect(await revalidateRequestAuthorization(request)).toBe(true);
    current = { ...current, identityIds: [12, 13, 14] };
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    current = { ...current, identityIds: [12, 13], scopes: ["identities:read"] };
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    current = { ...current, scopes: ["identities:read", "sessions:read"] }; allowed = false;
    expect(await revalidateRequestAuthorization(request)).toBe(false);
  });

  it("bounds an uncooperative verifier and never authorizes its late result", async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    let calls = 0;
    const authorize = vi.fn(() => true);
    const { request } = await openRequest({ timeoutMs: 20,
      verifyCredential: (_token, abort) => ++calls === 1 ? device : new Promise(resolve => { finish = resolve; signal = abort; }),
      policy: () => ({ scopes: ["identities:read"], authorize }),
    });
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    expect(signal.aborted).toBe(true);
    finish(device);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending recheck when the transport closes and releases its private state", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    let signal!: AbortSignal;
    let calls = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const { request, response } = await openRequest({ verifyCredential: (_token, abort) => ++calls === 1 ? device : new Promise(resolve => { finish = resolve; signal = abort; started(); }) });
    const pending = revalidateRequestAuthorization(request);
    await ready;
    response.destroy();
    expect(await pending).toBe(false);
    expect(signal.aborted).toBe(true);
    finish(device);
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    expect(calls).toBe(2);
  });

  it("honors caller cancellation and refuses requests that were never admitted", async () => {
    const verify = vi.fn(() => device);
    const { request } = await openRequest({ verifyCredential: verify });
    const controller = new AbortController(); controller.abort();
    expect(await revalidateRequestAuthorization(request, controller.signal)).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    // Derived from an admitted request, but never admitted itself.
    const stranger: Request = Object.create(request);
    expect(await revalidateRequestAuthorization(stranger)).toBe(false);
  });

  it("bounds resource revalidation and returns false without exposing verifier errors", async () => {
    let checks = 0;
    const { request } = await openRequest({ timeoutMs: 20, policy: () => ({ scopes: ["identities:read"], authorize: () => ++checks === 1 ? true : new Promise(() => {}) }) });
    expect(await revalidateRequestAuthorization(request)).toBe(false);
    let calls = 0;
    const another = await openRequest({ verifyCredential: () => { if (++calls === 1) return device; throw new Error("private-credential-error"); } });
    expect(await revalidateRequestAuthorization(another.request)).toBe(false);
  });

  it("cancels an in-flight verifier through the caller signal and suppresses its late policy check", async () => {
    let started!: () => void;
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    let calls = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const authorize = vi.fn(() => true);
    const { request } = await openRequest({ verifyCredential: (_token, abort) => ++calls === 1 ? device : new Promise(resolve => { signal = abort; finish = resolve; started(); }), policy: () => ({ scopes: ["identities:read"], authorize }) });
    const controller = new AbortController();
    const pending = revalidateRequestAuthorization(request, controller.signal);
    await ready; controller.abort();
    expect(await pending).toBe(false);
    expect(signal.aborted).toBe(true);
    finish(device);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

describe("request credentials", () => {
  it.each(["Bearer valid trailing", "Bearer  valid", "Basic valid", "Bearer\tvalid", "Bearer valid\n", "", `Bearer ${"x".repeat(4097)}`])("rejects malformed authorization %s despite a valid secret fallback", authorization => {
    expect(requestCredential({ headers: { authorization, "x-barry-secret": "valid" } })).toBeNull();
  });
  it("rejects conflicting and duplicate credentials including fields Node discarded", () => {
    expect(requestCredential({ headers: { authorization: "Bearer valid", "x-barry-secret": "other" } })).toBeNull();
    expect(requestCredential({ headers: { authorization: "Bearer valid" }, rawHeaders: ["Authorization", "Bearer valid", "authorization", "Bearer other"] })).toBeNull();
    expect(requestCredential({ headers: { "x-barry-secret": ["valid", "valid"] } })).toBeNull();
  });
  it("accepts a single credential or matching explicit fields", () => {
    expect(requestCredential({ headers: { authorization: "bearer valid" } })).toBe("valid");
    expect(requestCredential({ headers: { "x-barry-secret": "valid" } })).toBe("valid");
    expect(requestCredential({ headers: { authorization: "Bearer valid", "x-barry-secret": "valid" } })).toBe("valid");
  });
});

describe("HTTP authorization", () => {
  it("refuses a synchronous verification result past its deadline before checking resources", async () => {
    const authorize = vi.fn(() => true);
    const request = await serve({ timeoutMs: 10, verifyCredential: () => {
      const end = performance.now() + 20; while (performance.now() < end) { /* hold the thread past the deadline */ }
      return device;
    }, policy: () => ({ scopes: ["identities:read"], authorize }) });
    expect((await request()).status).toBe(503);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("binds a validated immutable principal after explicit scope and resource checks", async () => {
    const request = await serve();
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: device, frozen: true, mutable: false });
    expect(Object.isFrozen(device)).toBe(false);
  });
  it("rejects unknown routes, invalid credentials and missing identity grants", async () => {
    const request = await serve();
    expect((await request("/unclassified")).status).toBe(403);
    expect((await request(undefined, "wrong")).status).toBe(401);
    const foreign = await serve({ verifyCredential: () => ({ ...device, identityIds: [13] }) });
    expect((await foreign()).status).toBe(403);
  });
  it("rejects structurally forged principals and refuses scope-only permission", async () => {
    const forged = await serve({ verifyCredential: () => ({ ...device, scopes: ["admin"] }) });
    expect((await forged()).status).toBe(401);
    const authorize = vi.fn(() => true);
    const missing = await serve({ verifyCredential: () => ({ ...device, scopes: ["events:read"] }), policy: () => ({ scopes: ["identities:read"], authorize }) });
    expect((await missing()).status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
    const denied = await serve({ policy: () => ({ scopes: ["identities:read"], authorize: () => false }) });
    expect((await denied()).status).toBe(403);
  });
  it("keeps installation authorization distinct from device route grants", async () => {
    const request = await serve({ verifyCredential: () => ({ kind: "installation", actorId: 7, credentialId: "installation" }) });
    expect((await request("/operator-only")).status).toBe(200);
  });
  it("bounds a verifier that ignores cancellation and never authorizes its late result", async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const authorize = vi.fn(() => true);
    const request = await serve({ timeoutMs: 20, verifyCredential: (_, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); }, policy: () => ({ scopes: ["identities:read"], authorize }) });
    const response = await request();
    expect(response.status).toBe(503);
    expect(signal.aborted).toBe(true);
    finish(device);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authorize).not.toHaveBeenCalled();
  });
  it("redacts verifier and resource errors", async () => {
    for (const options of [{ verifyCredential: () => { throw new Error("private-token"); } }, { policy: () => ({ scopes: ["identities:read"] as const, authorize: () => { throw new Error("private-token"); } }) }]) {
      const request = await serve(options);
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-token");
    }
  });

  it("also bounds resource checks that ignore cancellation", async () => {
    const request = await serve({ timeoutMs: 20, policy: () => ({ scopes: ["identities:read"], authorize: () => new Promise(() => {}) }) });
    expect((await request()).status).toBe(503);
  });

  it("cancels verification when the HTTP client disconnects", async () => {
    let started!: () => void;
    let cancelled!: () => void;
    let finish!: (value: unknown) => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    const authorize = vi.fn(() => true);
    const request = await serve({ verifyCredential: (_, signal) => {
      signal.addEventListener("abort", cancelled, { once: true });
      started();
      return new Promise(resolve => { finish = resolve; });
    }, policy: () => ({ scopes: ["identities:read"], authorize }) });
    const controller = new AbortController();
    const response = request(undefined, undefined, controller.signal);
    const rejection = expect(response).rejects.toThrow();
    await ready;
    controller.abort();
    await rejection;
    await aborted;
    finish(device);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(authorize).not.toHaveBeenCalled();
  });
});
