import { afterEach, describe, expect, it, vi } from "vitest";
import { Barry, BarryError, type Caller, type Sessions } from "./index.js";
import { fakeIdentities, fakeSessions, fakeTracker } from "./testing.js";

afterEach(() => Barry.reset());

const identities = fakeIdentities;
const sessions = fakeSessions;

const statusTools = [{ name: "status", namespace: "git", bag: "git", description: "", access: "read" as const }];

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
    const sessionTools = vi.fn(async () => statusTools);
    Barry.use(sessions({ tools: sessionTools }));
    const ambient: Caller = { kind: "session", identity: "bux", sessionId: "s1" };
    Barry.useCaller(() => ambient);
    const tools = await Barry.identity("bux").session("s1").tools();
    expect(tools.map((tool) => tool.name)).toEqual(["status"]);
    expect(sessionTools).toHaveBeenCalledWith("bux", "s1", ambient);
  });

  it("delegates Barry.identity(ref).tools and Barry.tools(ref) to the identities subject", async () => {
    const identityTools = vi.fn(async () => statusTools);
    Barry.use(identities({ tools: identityTools }));
    await Barry.identity("bux").tools({ bags: ["git"] });
    expect(identityTools).toHaveBeenLastCalledWith("bux", { bags: ["git"] }, { kind: "owner" });
    await Barry.tools("bux", ["git"], ["readonly"]);
    expect(identityTools).toHaveBeenLastCalledWith("bux", { bags: ["git"], bounds: ["readonly"] }, { kind: "owner" });
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

describe("Barry.tools, Barry.bound, and Barry.Bound", () => {
  const sessionsBag = {
    name: "sessions",
    tools: [
      {
        name: "search_messages",
        access: "read" as const,
        description: "Lexical FTS5 search",
        handler: async () => "fts5",
      },
      {
        name: "send_message",
        access: "write" as const,
        description: "Send message",
        handler: async () => "sent",
      },
    ],
  };

  const vectorSearchBag = {
    name: "session-vector-search",
    requires: { sessions: {}, embeddings: {} },
    implements: { tools: ["sessions:search_messages"] },
    tools: [
      {
        name: "search_messages",
        access: "read" as const,
        description: "Hybrid vector + FTS5 search",
        handler: async () => "vector",
      },
    ],
  };

  it("replaces implemented tools in-place while preserving the target qualified ID", async () => {
    const tools = Barry.tools({ name: "me" }, [sessionsBag, vectorSearchBag]);
    expect(tools.map((t) => `${t.namespace}:${t.name}`)).toEqual([
      "sessions:search_messages",
      "sessions:send_message",
    ]);
    const searchTool = tools.find((t) => t.name === "search_messages")!;
    expect(searchTool.bag).toBe("session-vector-search");
    expect(await searchTool.handler!({}, {} as never)).toBe("vector");
  });

  it("uses a single pinned Bound directly without re-merging live identity.bounds", () => {
    const identityWithDenyAll = {
      name: "me",
      bounds: [{ tools: { deny: ["*"] } }],
    };
    const pinnedBound = Barry.Bound({
      tools: { allow: ["sessions:read"] },
    });
    // Passing a single pinned Bound object ignores identityWithDenyAll.bounds
    const withPinned = Barry.tools(identityWithDenyAll, [sessionsBag], pinnedBound);
    expect(withPinned.map((t) => t.name)).toEqual(["search_messages"]);

    // Passing an array of bounds merges identityWithDenyAll.bounds + array
    const withArray = Barry.tools(identityWithDenyAll, [sessionsBag], [pinnedBound]);
    expect(withArray).toEqual([]);
  });

  it("expands <bag>:read shorthand and guards tool input parameters", async () => {
    const slackBag = {
      name: "slack",
      bounds: {
        "self-dm-only": {
          inputs: {
            "slack:send_message": {
              channel_id: { allow: ["U12345"] },
            },
          },
        },
      },
      tools: [
        {
          name: "read_channel",
          access: "read" as const,
          handler: async () => "read",
        },
        {
          name: "send_message",
          access: "write" as const,
          input: {
            type: "object",
            properties: { channel_id: { type: "string" } },
          },
          handler: async (params: Record<string, unknown>) => `sent:${String(params.channel_id)}`,
        },
      ],
    };

    const readOnlyTools = Barry.tools({ name: "me" }, [slackBag], ["slack:read"]);
    expect(readOnlyTools.map((t) => t.name)).toEqual(["read_channel"]);

    const dmOnlyTools = Barry.tools({ name: "me" }, [slackBag], ["slack:self-dm-only"]);
    const sendTool = dmOnlyTools.find((t) => t.name === "send_message")!;
    expect((sendTool.input?.properties as Record<string, { enum?: string[] }>).channel_id.enum).toEqual([
      "U12345",
    ]);
    expect(await sendTool.handler!({ channel_id: "U12345" }, {} as never)).toBe("sent:U12345");
    await expect(sendTool.handler!({ channel_id: "C99999" }, {} as never)).rejects.toThrow(
      /Access denied/,
    );
  });

  it("defaults unannotated remote tools to write access so <bag>:read blocks them", () => {
    const remoteBag = {
      name: "remote-crm",
      tools: [
        { name: "get_contact", annotations: { readOnlyHint: true } },
        { name: "delete_contact" },
      ],
    };
    const tools = Barry.tools({ name: "me" }, [remoteBag], ["remote-crm:read"]);
    expect(tools.map((t) => t.name)).toEqual(["get_contact"]);
  });

  it("merges bounds via Barry.Bound.merge and resolves skills, instructions, and actions", () => {
    const merged = Barry.Bound.merge(
      { files: { allow: ["~/repos/**"] } },
      { files: { allow: ["~/repos/barry/**"], deny: ["**/.env"] } },
    );
    expect(merged?.files?.allow).toEqual(["~/repos/barry/**"]);
    expect(merged?.files?.deny).toEqual(["**/.env"]);

    const orthogonal = Barry.Bound.merge(
      { files: { allow: ["~/repos/**"] } },
      { files: { allow: ["**/*.ts"] } },
    );
    expect(orthogonal?.files?.allowClauses).toEqual([["~/repos/**"], ["**/*.ts"]]);

    const codingBag = {
      name: "coding",
      skills: [{ name: "tdd" }],
      instructions: [{ name: "coding-naming" }],
      actions: [
        {
          name: "review",
          qualifiedName: "coding:review",
          bag: "coding",
          description: "Review PR",
          executable: true,
          inputs: [],
        },
      ],
    };
    expect(Barry.skills({ name: "me" }, [codingBag])).toEqual([{ name: "coding:tdd" }]);
    expect(Barry.instructions({ name: "me" }, [codingBag])).toEqual([
      { name: "coding:coding-naming" },
    ]);
    expect(Barry.actions({ name: "me" }, [codingBag]).map((a) => a.qualifiedName)).toEqual([
      "coding:review",
    ]);
  });

  it("expands identity.bags, excludes optional identity bags unless selected in bags, and expands child bags (not requires)", () => {
    const childBag = {
      name: "child-bag",
      tools: [{ name: "child_tool", access: "read" as const }],
    };
    const requiredOnlyBag = {
      name: "required-only",
      tools: [{ name: "secret_tool", access: "read" as const }],
    };
    const parentBag = {
      name: "parent-bag",
      bags: { "child-bag": {} },
      requires: { "required-only": {} },
      tools: [{ name: "parent_tool", access: "read" as const }],
    };
    const optionalMcpBag = {
      name: "mcp",
      tools: [{ name: "call_mcp", access: "write" as const }],
    };
    const identity = {
      name: "builder",
      bags: [parentBag, { ...optionalMcpBag, optional: true }],
    };

    // Without optionalMcpBag in the 2nd argument, optional identity bag is excluded,
    // child-bag is expanded via parent-bag.bags, and required-only is NOT expanded via requires.
    const defaultTools = Barry.tools(identity, [childBag]);
    expect(defaultTools.map((t) => `${t.namespace}:${t.name}`)).toEqual([
      "parent-bag:parent_tool",
      "child-bag:child_tool",
    ]);

    // When optionalMcpBag is explicitly passed in the 2nd `bags` argument, it is included!
    const withExplicitOptional = Barry.tools(identity, [childBag, optionalMcpBag]);
    expect(withExplicitOptional.map((t) => `${t.namespace}:${t.name}`)).toEqual([
      "parent-bag:parent_tool",
      "child-bag:child_tool",
      "mcp:call_mcp",
    ]);

    expect(requiredOnlyBag.name).toBe("required-only");
  });

  it("throws a deterministic conflict error when two active bags implement the same tool", () => {
    const secondVectorBag = {
      name: "alt-vector-search",
      implements: { tools: ["sessions:search_messages"] },
      tools: [{ name: "search_messages", access: "read" as const }],
    };
    expect(() =>
      Barry.tools({ name: "me" }, [sessionsBag, vectorSearchBag, secondVectorBag]),
    ).toThrow(/Multiple active bags implement tool "sessions:search_messages"/);
  });

  it("exports boundHasProcessRestrictions, readTwin, and protectedConfigPaths from bounds barrel", async () => {
    const {
      boundHasProcessRestrictions,
      readTwin,
      protectedConfigPaths,
      BARRY_CONFIG_PROTECTION_BOUND,
    } = await import("../bounds/index.js");

    expect(boundHasProcessRestrictions(null)).toBe(false);
    expect(boundHasProcessRestrictions({ tools: { deny: ["*:write"] } })).toBe(false);
    expect(boundHasProcessRestrictions({ files: { allow: ["~/repos/**"] } })).toBe(true);
    expect(boundHasProcessRestrictions({ bash: { allow: ["git *"] } })).toBe(true);
    expect(boundHasProcessRestrictions({ network: { deny: ["*"] } })).toBe(true);

    const twin = readTwin("slack");
    expect(twin).toEqual({
      name: "slack:read",
      description: "Read-only access to slack tools",
      tools: { deny: ["slack:write"] },
    });

    const paths = protectedConfigPaths("/tmp/custom-barry-home");
    expect(paths).toContain("/tmp/custom-barry-home/identities/**");
    expect(BARRY_CONFIG_PROTECTION_BOUND.files?.deny).toContain("**/identity.yaml");
  });
});


