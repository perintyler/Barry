import { describe, expect, it, vi } from "vitest";
import { authenticateCredential } from "./credential.js";

const device = { kind: "device", actorId: 1, credentialId: "device", scopes: ["sessions:read", "events:read"], identityIds: [1, 2] };
describe("transport credential authorization", () => {
  it("keeps immutable grants and requires scopes plus an explicit resource decision", async () => {
    const verify = vi.fn(() => device);
    const authorization = await authenticateCredential("private-token", { verifyCredential: verify });
    expect(authorization).not.toBeNull();
    expect(Object.isFrozen(authorization!.principal)).toBe(true);
    expect(await authorization!.authorize({ scopes: ["sessions:read"], authorize: () => true })).toBe(true);
    const denied = vi.fn(() => true);
    expect(await authorization!.authorize({ scopes: ["sessions:turn"], authorize: denied })).toBe(false);
    expect(denied).not.toHaveBeenCalled();
    expect(await authorization!.authorize({ scopes: ["sessions:read"], authorize: () => false })).toBe(false);
    expect(await authorization!.authorize(undefined as never)).toBe(false);
    expect(JSON.stringify(authorization)).not.toContain("private-token");
    authorization!.dispose();
    const calls = verify.mock.calls.length;
    expect(await authorization!.revalidate()).toBe(false);
    expect(verify.mock.calls).toHaveLength(calls);
  });
  it("rejects changed grants, identity, actor or credential but accepts reordered identical grants", async () => {
    let current: unknown = device;
    const authorization = await authenticateCredential("token", { verifyCredential: () => current });
    current = { ...device, scopes: [...device.scopes].reverse(), identityIds: [2, 1] };
    expect(await authorization!.revalidate()).toBe(true);
    for (const changed of [null, { ...device, actorId: 2 }, { ...device, credentialId: "other" }, { ...device, scopes: ["sessions:read"] }, { ...device, identityIds: [1] }]) {
      current = changed;
      expect(await authorization!.revalidate()).toBe(false);
    }
    expect(authorization!.principal.actorId).toBe(1);
    authorization!.dispose();
  });
  it("checks operator resources even though operator credentials bypass device scopes", async () => {
    const authorization = await authenticateCredential("token", { verifyCredential: () => ({ kind: "installation", actorId: 1, credentialId: "installation" }) });
    expect(await authorization!.authorize({ scopes: ["sessions:turn"], authorize: () => false })).toBe(false);
    expect(await authorization!.authorize({ scopes: ["sessions:turn"], authorize: () => true })).toBe(true);
    authorization!.dispose();
  });
  it("bounds an uncooperative verifier and redacts its errors", async () => {
    await expect(authenticateCredential("private-token", { timeoutMs: 100, verifyCredential: () => new Promise(() => {}) })).rejects.toThrow("Authorization unavailable");
    await expect(authenticateCredential("private-token", { verifyCredential: () => { throw new Error("private-token database details"); } })).rejects.toThrow(/^Authorization unavailable$/);
    expect(await authenticateCredential("", { verifyCredential: () => device })).toBeNull();
    expect(await authenticateCredential("token", { verifyCredential: () => ({ ...device, scopes: ["admin"] }) })).toBeNull();
  });
  it("stops pending resource checks on disposal and never lets late verification run a policy", async () => {
    let resolve!: (value: unknown) => void;
    let pending = false;
    const authorization = await authenticateCredential("token", { verifyCredential: () => pending ? new Promise(done => { resolve = done; }) : device });
    pending = true;
    const policy = vi.fn(() => true);
    const check = authorization!.authorize({ scopes: ["sessions:read"], authorize: policy });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    authorization!.dispose();
    expect(await check).toBe(false);
    resolve(device);
    await Promise.resolve(); await Promise.resolve();
    expect(policy).not.toHaveBeenCalled();
  });
  it("honors caller cancellation and one deadline covering verifier plus resource policy", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const verify = vi.fn(() => device);
    await expect(authenticateCredential("token", { signal: cancelled.signal, verifyCredential: verify })).rejects.toThrow("Authorization unavailable");
    expect(verify).not.toHaveBeenCalled();
    const authorization = await authenticateCredential("token", { timeoutMs: 100, verifyCredential: verify });
    expect(await authorization!.authorize({ scopes: ["sessions:read"], authorize: () => new Promise(() => {}) })).toBe(false);
    authorization!.dispose();
  });
  it("rejects synchronously late verification before invoking a resource predicate", async () => {
    let slow = false;
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const authorization = await authenticateCredential("token", { timeoutMs: 10, verifyCredential: () => {
        if (slow) clock += 15;
        return device;
      } });
      slow = true;
      const policy = vi.fn(() => true);
      expect(await authorization!.authorize({ scopes: ["sessions:read"], authorize: policy })).toBe(false);
      expect(policy).not.toHaveBeenCalled();
      authorization!.dispose();
    } finally { now.mockRestore(); }
  });
});
