import { afterEach, describe, expect, it, vi } from "vitest";
import { Barry, BarryError, type Caller, type Sessions } from "./index.js";
import { fakeIdentities, fakeSessions, fakeTracker } from "./testing.js";

afterEach(() => Barry.reset());

const identities = fakeIdentities;
const sessions = fakeSessions;

const grants = { traits: ["git"], bound: null, namespaces: ["git"], tools: [{ name: "status", namespace: "git", bag: "git", description: "", access: "read" as const }], skills: [], instructions: [] };

describe("Barry", () => {
  it("shares installs, caller and reset across separate SDK copies", async () => {
    const first = await import("./runtime.js");
    vi.resetModules();
    const second = await import("./runtime.js");
    const list = vi.fn(async () => []);
    first.Barry.use(identities({ list }));
    first.Barry.useCaller(() => ({ kind: "session", identity: "bux", sessionId: "s1" }));
    expect(await second.Barry.identities()).toEqual([]);
    expect(list).toHaveBeenCalledWith({ kind: "session", identity: "bux", sessionId: "s1" });
    second.Barry.reset();
    await expect(first.Barry.identities()).rejects.toMatchObject({ reason: "unavailable" });
    await expect(second.Barry.identities()).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("recognizes another SDK copy's refusals", async () => {
    const first = await import("./errors.js");
    vi.resetModules();
    const second = await import("./errors.js");
    expect(second.isBarryError(new first.BarryError("forbidden", "refused"))).toBe(true);
    expect(second.isBarryError(Object.assign(new Error("refused"), { name: "BarryError", reason: "other" }))).toBe(false);
    expect(second.isBarryError({ name: "BarryError", reason: "forbidden" })).toBe(false);
  });

  it("answers from a subject this process installed", async () => {
    const list = vi.fn(async () => [{ name: "bux" }] as never);
    Barry.use(identities({ list }));
    expect(await Barry.identities()).toEqual([{ name: "bux" }]);
    expect(list).toHaveBeenCalledWith({ kind: "owner" });
  });

  it("removes an identity's sessions before the identity, when both are installed", async () => {
    const order: string[] = [];
    Barry.use(
      identities({ remove: vi.fn(async () => { order.push("identity"); return { name: "bux", sessionsDeleted: 0, directory: null, nextDefault: undefined }; }) }),
      sessions({ removeAll: vi.fn(async () => { order.push("sessions"); return 3; }) }),
    );
    expect((await Barry.identity("bux").remove()).sessionsDeleted).toBe(3);
    expect(order).toEqual(["sessions", "identity"]);
  });

  it("names the method a fake was not given", async () => {
    Barry.use(identities());
    await expect(Barry.identity("bux").get()).rejects.toThrow(/fake identities.get .* did not supply it/);
  });

  it("refuses loudly when nothing is installed and nothing is connected", async () => {
    await expect(Barry.identity("bux").get()).rejects.toMatchObject({ name: "BarryError", reason: "unavailable" });
    await expect(Barry.identity("bux").get()).rejects.toBeInstanceOf(BarryError);
  });

  it("asks a session for its tools through its identity, with the ambient caller", async () => {
    const sessionGrants = vi.fn(async () => grants);
    Barry.use(sessions({ grants: sessionGrants }));
    const ambient: Caller = { kind: "session", identity: "bux", sessionId: "s1" };
    Barry.useCaller(() => ambient);
    const tools = await Barry.identity("bux").session("s1").tools();
    expect(tools.map((tool) => tool.name)).toEqual(["status"]);
    expect(sessionGrants).toHaveBeenCalledWith("bux", "s1", ambient);
  });

  it("acts as the caller it is given, over the ambient one", async () => {
    const update = vi.fn(async () => ({ name: "bux", warnings: [] }) as never);
    Barry.use(identities({ update }));
    Barry.useCaller(() => ({ kind: "session", identity: "bux", sessionId: "s1" }));
    const device: Caller = { kind: "device", principal: { kind: "device", credentialId: "d", actorId: 1, identityIds: [3], scopes: ["identities:read"] } };
    await Barry.as(device).identity(3).update({ displayName: "Bux" });
    expect(update).toHaveBeenCalledWith(3, { displayName: "Bux" }, device);
  });

  it("iterates a collection page by page, or awaits it whole", async () => {
    const list: Sessions["list"] = async (_identity, _query, cursor) =>
      cursor === null ? { items: [{ id: "a" } as never], next: "2" } : { items: [{ id: "b" } as never], next: null };
    Barry.use(sessions({ list }));
    const seen: string[] = [];
    for await (const session of Barry.identity("bux").sessions()) seen.push(session.id);
    expect(seen).toEqual(["a", "b"]);
    expect((await Barry.identity("bux").sessions()).map((session) => session.id)).toEqual(["a", "b"]);
  });

  it("starts a session and hands back its handle", async () => {
    Barry.use(sessions({ start: vi.fn(async () => ({ id: "new" }) as never) }));
    const started = await Barry.identity("bux").start({ prompt: "hello" });
    expect(started.id).toBe("new");
    expect(started.identity.ref).toBe("bux");
  });

  it("keeps a bag's store binding for code running inside Barry", () => {
    expect(Barry.bag("linear").name).toBe("linear");
    expect(() => Barry.bag("linear").store()).toThrow(/execution context/);
  });
});

it("answers start and stop through an installed fake services subject", async () => {
  const { fakeServices } = await import("./testing.js");
  const start = vi.fn(async () => ({ key: "fixture.api" }) as never), stop = vi.fn(async () => ({ key: "fixture.api" }) as never);
  Barry.use(fakeServices({ start, stop }));
  await Barry.service("fixture.api").start(); await Barry.service("fixture.api").stop();
  expect(start).toHaveBeenCalledWith("fixture.api", { kind: "owner" }); expect(stop).toHaveBeenCalledWith("fixture.api", { kind: "owner" });
});

it("refuses conflicting message bounds before any collection starts", () => {
  const messages = vi.fn();
  Barry.use(fakeSessions({ messages }));
  const session = Barry.identity("bux").session("s1");
  expect(() => session.messages({ after: 0, before: 2 })).toThrow(BarryError);
  expect(() => session.messages({ after: 0, newestFirst: true })).toThrow(/after cannot/);
  expect(messages).not.toHaveBeenCalled();
});

it("passes message queries, sequences, listener calls and file paths to installed subjects", async () => {
  const messages = vi.fn(async () => ({ items: [], next: null }));
  const message = vi.fn(async () => ({ type: "text" as const, sessionId: "s1", sequence: 2 }));
  const listening = vi.fn(async () => true);
  const lastChanges = vi.fn(async () => [{ sessionId: "s1", path: "a", at: "now", tool: null }]);
  Barry.use(fakeSessions({ messages, message, listening }), fakeTracker({ lastChanges }));
  const caller: Caller = { kind: "session", identity: "bux", sessionId: "s1" };
  const asked = Barry.as(caller);
  const session = asked.identity("bux").session("s1");
  expect(await session.messages({ before: 3, brief: true })).toEqual([]);
  expect((await session.message(2)).sequence).toBe(2);
  expect(await session.listening()).toBe(true);
  expect(await asked.lastChanges(["a"])).toEqual([{ sessionId: "s1", path: "a", at: "now", tool: null }]);
  expect(messages).toHaveBeenCalledWith("bux", "s1", { before: 3, brief: true }, null, caller);
  expect(message).toHaveBeenCalledWith("bux", "s1", 2, caller);
  expect(listening).toHaveBeenCalledWith("bux", "s1", caller);
  expect(lastChanges).toHaveBeenCalledWith(["a"], caller);
});
