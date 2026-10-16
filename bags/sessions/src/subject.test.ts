/**
 * The sessions subject answering `Barry`'s session questions: reads and
 * settings from a real (scratch) session store, and start, send and end
 * through the sessions API, here a stand-in that records what it was asked.
 * Identities are a fake that refuses what the real subject refuses, so the
 * identity checks are the subject's own.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Barry, BarryError, isBarryError, type Bound, type Caller, type Identity } from "@barry-rocks/sdk";
import type { DevicePrincipal } from "@barry-rocks/sdk/internal/auth";
import { fakeBags, fakeIdentities } from "@barry-rocks/sdk/testing";

const scratch = mkdtempSync(join(tmpdir(), "barry-sessions-subject-"));
process.env.BARRY_SESSIONS_DB = join(scratch, "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("./store/sessions-db.js");
const { appendMessage, getSession, hostDelivery } = await import("./client/index.js");
const { sessions } = await import("./subject.js");
const { sessionOf } = await import("./domain.js");

function identity(id: number, name: string): Identity {
  return {
    id, name, token: `token-${name}`, displayName: null, bags: ["git"], bounds: [],
    adapters: {}, envKeys: [], vaultEmail: null,
    isDefault: false, createdAt: null, lastUsedAt: null,
  };
}

const BUX = identity(7, "bux");
const IDA = identity(8, "ida");

/** What the real identities subject refuses: a device without the grant, a session of another identity. */
const identities = fakeIdentities({
  get: async (ref, caller) => {
    const found = [BUX, IDA].find((candidate) => candidate.id === ref || candidate.name === ref || `stable-${candidate.name}` === ref);
    if (!found) throw new BarryError("not_found", `Identity ${String(ref)} not found`);
    if (caller.kind === "device" && !caller.principal.identityIds.includes(found.id)) throw new BarryError("forbidden", "This device may not read that identity");
    if (caller.kind === "session" && caller.identity !== found.name && caller.identity !== found.id) throw new BarryError("forbidden", "A session may read only its own identity");
    return found;
  },
  bounds: async () => [{ name: "readonly", tools: { deny: ["*:write"] } }],
  bound: async (_ref, requested) => {
    const names = (requested ?? []).filter((entry): entry is string => typeof entry === "string");
    if (names.some((name) => name !== "readonly")) throw new BarryError("invalid", "Unknown bound");
    if (names.includes("readonly")) {
      return { name: "readonly", tools: { deny: ["*:write"] } };
    }
    return {};
  },
  tools: async (_ref, selection) => {
    const bagNames = (selection.bags ?? []).map((b) => (typeof b === "string" ? b : b.name));
    const allTools = [
      { name: "status", namespace: "git", bag: "git", access: "read" as const },
      { name: "commit", namespace: "git", bag: "git", access: "write" as const },
    ].filter((tool) => bagNames.length === 0 || bagNames.includes(tool.bag));
    const bound = selection.bounds && !Array.isArray(selection.bounds) ? (selection.bounds as Bound) : null;
    if (bound?.tools?.deny?.includes("*:write")) {
      return allTools.filter((tool) => tool.access !== "write");
    }
    return allTools;
  },
});

const bagsSubject = fakeBags({
  list: async () => [
    { name: "git", type: "local" as const, description: "Git tools" },
    { name: "linear", type: "local" as const, description: "Linear tools" },
  ],
  tools: async (bag) =>
    bag === "git"
      ? [
          { name: "status", namespace: "git", bag: "git", access: "read" as const },
          { name: "commit", namespace: "git", bag: "git", access: "write" as const },
        ]
      : [],
});

function device(scopes: DevicePrincipal["scopes"] = ["sessions:read", "identities:read"]): Caller {
  return { kind: "device", principal: { kind: "device", credentialId: "phone", actorId: 1, identityIds: [7], scopes } };
}

let created = 0;
function seed(row: {
  id?: string;
  identity?: number | null;
  user?: number | null;
  createdAt?: string;
  closed?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
} = {}): string {
  const id = row.id ?? `s-${++created}`;
  getSessionsSqlite()
    .prepare(
      `INSERT INTO sessions (id, active, state, status, identity_id, user_id, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      row.closed ? 0 : 1,
      row.closed ? "closed" : "open",
      row.status ?? "running",
      row.identity === undefined ? BUX.id : row.identity,
      row.user ?? null,
      JSON.stringify(row.metadata ?? {}),
      row.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, created)).toISOString(),
    );
  return id;
}

async function refusal(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isBarryError(error)) return error.reason;
    throw error;
  }
  throw new Error("expected a refusal");
}

// The sessions API, as far as these calls reach it.
interface Asked { method: string; path: string; authorization: string | undefined; body: Record<string, unknown> }
let asked: Asked[] = [];
let api: Server;

async function respond(request: Asked): Promise<{ status: number; body: unknown }> {
  if (request.method === "POST" && request.path === "/api/v1/sessions") {
    const id = seed({ identity: request.body.identityId as number, metadata: { name: request.body.name ?? null } });
    const row = await getSession(id);
    if (!row) throw new Error(`session ${id} was not stored`);
    const session = sessionOf(row, null);
    return request.body.prompt === "fail"
      ? { status: 201, body: { ...session, started: false, startError: "the model is not installed" } }
      : { status: 201, body: { ...session, started: true } };
  }
  const message = /^\/api\/v1\/sessions\/([^/]+)\/message$/.exec(request.path);
  if (request.method === "POST" && message) {
    if (message[1] === "busy") return { status: 409, body: { type: "about:blank", title: "Session is busy", status: 409 } };
    return { status: 200, body: { ok: true, sessionId: message[1], deliveryState: "accepted", clientMessageId: request.body.clientMessageId ?? null, messageId: "msg-1" } };
  }
  if (request.method === "POST" && /^\/api\/v1\/sessions\/[^/]+\/stop$/.test(request.path)) return { status: 200, body: { message: "Session stopped" } };
  return { status: 404, body: { title: "Not found", status: 404 } };
}

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      void (async () => {
        const request: Asked = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
        };
        asked.push(request);
        const answer = await respond(request);
        res.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify(answer.body));
      })();
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  // An instance of this test's own: its registry names the stand-in API, and its env holds the secret.
  const home = mkdtempSync(join(tmpdir(), "barry-sessions-subject-home-"));
  mkdirSync(join(home, "app-support"), { recursive: true });
  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  writeFileSync(join(home, "app-support", "bag-resources.json"), JSON.stringify({
    version: 2,
    generated: new Date().toISOString(),
    resources: { "sessions.api": { bag: "sessions", name: "api", kind: "service", url } },
  }));
  writeFileSync(join(home, "app-support", "env"), "BARRY_SECRET=instance-secret\n");
  process.env.BARRY_HOME = home;
});

afterAll(async () => {
  closeSessionsDb();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  getSessionsSqlite().prepare("DELETE FROM sessions").run();
  asked = [];
  Barry.use(identities, sessions, bagsSubject);
});

afterEach(() => Barry.reset());

describe("listing an identity's sessions", () => {
  it("pages through every session of the identity, newest first, and none of another's", async () => {
    const mine: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      mine.push(seed());
      if (i % 10 === 0) seed({ identity: IDA.id });
    }

    const first = await sessions.list("bux", {}, null, { kind: "owner" });
    expect(first.next).not.toBeNull();
    expect(first.items).toHaveLength(50);

    const listed = await Barry.identity("bux").sessions();
    expect(listed.map((session) => session.id)).toEqual([...mine].reverse());
    expect(listed.every((session) => session.identityId === BUX.id)).toBe(true);
  });

  it("matches status as the session reports it, and pinned", async () => {
    // Closed with a live column: the session reports it completed.
    const ended = seed({ closed: true, status: "running" });
    const pinned = seed({ metadata: { pinned: true } });
    seed();

    expect((await Barry.identity("bux").sessions({ status: "completed" })).map((s) => s.id)).toEqual([ended]);
    expect((await Barry.identity("bux").sessions({ pinned: true })).map((s) => s.id)).toEqual([pinned]);
    expect((await Barry.identity(7).sessions({ status: ["completed", "running"] })).length).toBe(3);
  });

  it("refuses a cursor it did not hand out", async () => {
    expect(await refusal(sessions.list("bux", {}, "not-a-cursor", { kind: "owner" }))).toBe("invalid");
  });

  it("shows a device only its own user's sessions of an identity it was granted", async () => {
    const own = seed({ user: 1 });
    const shared = seed({ user: null });
    seed({ user: 2 });

    const seen = await Barry.as(device()).identity("bux").sessions();
    expect(seen.map((s) => s.id).sort()).toEqual([own, shared].sort());
    expect(await refusal(Barry.as(device()).identity("ida").sessions())).toBe("forbidden");
    expect(await refusal(Barry.as(device(["identities:read"])).identity("bux").sessions())).toBe("forbidden");
  });
});

describe("reading a session", () => {
  it("resolves stable identity references and refuses another identity", async () => {
    const id = seed();
    expect((await Barry.identity("stable-bux").session(id).get()).id).toBe(id);
    expect(await refusal(Barry.identity("stable-ida").session(id).get())).toBe("not_found");
  });

  it("reads it as Barry hands it out", async () => {
    const id = seed({
      closed: true,
      status: "running",
      metadata: { name: "fix the build", working_directory: "~/repo", barry_source: "repo", pinned: true, provider: "claude", model: "m-1", model_provider: "acme" },
    });

    const session = await Barry.identity("bux").session(id).get();
    expect(session).toMatchObject({
      id,
      name: "fix the build",
      repoPath: join(homedir(), "repo"),
      identityId: BUX.id,
      identitySource: "repo",
      status: "completed",
      pinned: true,
      provider: "claude",
      model: "m-1",
      modelRef: "acme/m-1",
    });
    expect((await Barry.identity(7).session(id).get()).id).toBe(id);
  });

  it("does not find it through another identity, or for a device of another user", async () => {
    const id = seed({ user: 2 });

    expect(await refusal(Barry.identity("ida").session(id).get())).toBe("not_found");
    expect(await refusal(Barry.identity("bux").session("no-such-session").get())).toBe("not_found");
    expect(await refusal(Barry.as(device()).identity("bux").session(id).get())).toBe("not_found");
  });

  it("lets a session read its identity's sessions and no other's", async () => {
    const id = seed();
    const caller: Caller = { kind: "session", identity: "ida", sessionId: "s-elsewhere" };

    expect(await refusal(Barry.as(caller).identity("bux").session(id).get())).toBe("forbidden");
    expect((await Barry.as({ kind: "session", identity: "bux", sessionId: "s-elsewhere" }).identity("bux").session(id).get()).id).toBe(id);
  });
});

describe("a session's messages", () => {
  it("pages oldest first through every message", async () => {
    const id = seed();
    for (let i = 0; i < 520; i += 1) await appendMessage(id, { type: "text", role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });

    const first = await sessions.messages("bux", id, {}, null, { kind: "owner" });
    expect(first.items).toHaveLength(500);
    expect(first.next).toBe("499");

    const all = await Barry.identity("bux").session(id).messages();
    expect(all.map((message) => message.sequence)).toEqual(Array.from({ length: 520 }, (_, i) => i));
    expect(all[1]).toMatchObject({ type: "text", sessionId: id, role: "assistant", content: "m1" });
  });

  it("refuses a cursor that is not a sequence", async () => {
    const id = seed();
    expect(await refusal(sessions.messages("bux", id, {}, "abc", { kind: "owner" }))).toBe("invalid");
  });
});

describe("changing a session", () => {
  it("changes its settings and answers the session as it now is", async () => {
    const id = seed({ metadata: { name: "before", provider: "claude" } });

    const updated = await Barry.identity("bux").session(id).update({
      name: "after", pinned: true, bags: ["git"], bounds: ["readonly"], harness: "codex", model: "m-2", modelProvider: "acme",
    });
    expect(updated).toMatchObject({ id, name: "after", pinned: true, bags: ["git"], bounds: ["readonly"], provider: "codex", model: "m-2", modelRef: "acme/m-2" });

    const row = await getSession(id);
    expect(row?.bags).toEqual(["git"]);
    expect(row?.bounds).toEqual(["readonly"]);
    expect(row?.bound).toMatchObject({ tools: { deny: ["*:write"] } });
    expect(row?.metadata.model_provider).toBe("acme");
  });

  it("refuses a bound nothing is named, a malformed harness, and a device", async () => {
    const id = seed();
    expect(await refusal(Barry.identity("bux").session(id).update({ bounds: ["nonexistent"] }))).toBe("invalid");
    expect(await refusal(Barry.identity("bux").session(id).update({ harness: "Not A Harness" }))).toBe("invalid");
    expect(await refusal(Barry.as(device()).identity("bux").session(id).update({ name: "x" }))).toBe("forbidden");
    expect((await getSession(id))?.bound).toBeNull();
  });
});

describe("starting, messaging and ending a session through the runtime", () => {
  it("starts one through the sessions API, as the identity named", async () => {
    const started = await Barry.identity("bux").start({ systemPrompt: "keep the build green", prompt: "go", bags: ["git"], harness: "claude", bounds: ["readonly"] });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/sessions",
      authorization: "Bearer instance-secret",
      body: { systemPrompt: "keep the build green", prompt: "go", identityId: BUX.id, bags: ["git"], provider: "claude", bounds: ["readonly"] },
    });
    expect((await started.get()).identityId).toBe(BUX.id);
  });

  it("reports a session whose agent did not start, and refuses one with no system prompt before asking", async () => {
    const failed = await sessions.start("bux", { systemPrompt: "x", prompt: "fail" }, { kind: "owner" }).catch((error: unknown) => error);
    expect(isBarryError(failed) && failed.reason).toBe("unavailable");
    expect(String((failed as Error).message)).toContain("the model is not installed");

    asked = [];
    expect(await refusal(sessions.start("bux", { prompt: "go" }, { kind: "owner" }))).toBe("invalid");
    expect(asked).toHaveLength(0);
  });

  it("sends a message and reports how it was delivered", async () => {
    const id = seed();
    const delivery = await Barry.identity("bux").session(id).send("hello", { clientMessageId: "c-1" });
    expect(delivery).toEqual({ state: "accepted", messageId: "msg-1", clientMessageId: "c-1" });
    expect(asked[0]).toMatchObject({ path: `/api/v1/sessions/${id}/message`, body: { content: "hello", clientMessageId: "c-1" } });
  });

  it("answers the API's refusal as the same error an in-process one throws", async () => {
    seed({ id: "busy" });
    expect(await refusal(Barry.identity("bux").session("busy").send("hello"))).toBe("conflict");
  });

  it("ends one by stopping it in the runtime", async () => {
    const id = seed();
    await Barry.identity("bux").session(id).end();
    expect(asked).toEqual([expect.objectContaining({ method: "POST", path: `/api/v1/sessions/${id}/stop`, authorization: "Bearer instance-secret" })]);
  });

  it("lets a device run nothing, and asks the API nothing for one", async () => {
    const id = seed({ user: 1 });
    const phone = Barry.as(device()).identity("bux");
    expect(await refusal(phone.start({ systemPrompt: "x" }))).toBe("forbidden");
    expect(await refusal(phone.session(id).send("hello"))).toBe("forbidden");
    expect(await refusal(phone.session(id).end())).toBe("forbidden");
    expect(asked).toHaveLength(0);
  });

  it("has no live event stream yet, and says where to look", async () => {
    const id = seed();
    const events = Barry.identity("bux").session(id).events()[Symbol.asyncIterator]();
    const error = await events.next().catch((thrown: unknown) => thrown);
    expect(isBarryError(error) && error.reason).toBe("unavailable");
    expect(isBarryError(error) && error.hint).toContain("messages()");
  });
});

describe("session queries for external bags", () => {
  it("lists only open sessions when active is true", async () => {
    const open = seed();
    const ended = seed({ closed: true });
    expect((await Barry.identity("bux").sessions({ active: true })).map(s => s.id)).toEqual([open]);
    expect((await Barry.identity("bux").sessions({ active: false })).map(s => s.id)).toEqual([ended]);
  });

  it("pages in activity order across more than one page", async () => {
    const ids = Array.from({ length: 60 }, () => seed());
    for (const [i, id] of ids.entries()) {
      getSessionsSqlite().prepare("UPDATE sessions SET last_message_at = ? WHERE id = ?")
        .run(new Date(Date.UTC(2026, 1, 1, 0, 0, 60 - i)).toISOString(), id);
    }
    const listed = await Barry.identity("bux").sessions({ order: "activity" });
    expect(listed.map(s => s.id)).toEqual(ids);
  });

  it("reads newest first across pages and supports before and after bounds", async () => {
    const id = seed();
    for (let i = 0; i < 520; i++) await appendMessage(id, { type: "text", content: `m${i}` });
    const session = Barry.identity("bux").session(id);
    expect((await session.messages({ newestFirst: true })).map(m => m.sequence))
      .toEqual(Array.from({ length: 520 }, (_, i) => 519 - i));
    expect((await session.messages({ before: 3 })).map(m => m.sequence)).toEqual([2, 1, 0]);
    expect((await session.messages({ after: 517 })).map(m => m.sequence)).toEqual([518, 519]);
  });

  it("brief messages carry a preview without results", async () => {
    const id = seed();
    getSessionsSqlite().prepare(`INSERT INTO messages (id, session_id, sequence, type, name, input, result, created_at)
      VALUES (?, ?, 0, 'tool_call', 'Edit', ?, ?, ?)`)
      .run(`message-${id}`, id, JSON.stringify({ text: "x".repeat(500) }), JSON.stringify({ done: true }), "2026-10-01T00:00:00.000Z");
    const session = Barry.identity("bux").session(id);
    const brief = await session.messages({ brief: true });
    expect(String(brief[0].input)).toHaveLength(200);
    expect(brief[0].result).toBeNull();
    expect(brief[0].hasDetail).toBe(true);
    expect((await session.message(0)).result).toEqual({ done: true });
  });

  it("finds a single sequence and refuses a gap or a sequence past the end", async () => {
    const id = seed();
    await appendMessage(id, { type: "text", content: "zero" });
    await appendMessage(id, { type: "text", content: "one" });
    await appendMessage(id, { type: "text", content: "two" });
    getSessionsSqlite().prepare("DELETE FROM messages WHERE session_id = ? AND sequence = 1").run(id);
    const session = Barry.identity("bux").session(id);
    expect(await session.message(2)).toMatchObject({ sequence: 2, content: "two" });
    expect(await refusal(session.message(1))).toBe("not_found");
    expect(await refusal(session.message(3))).toBe("not_found");
  });

  it("reads listener status through the delivery host", async () => {
    const id = seed();
    let listeners: import("./client/index.js").SessionListeners = {};
    hostDelivery({
      getListeners: async () => listeners,
      waitForPrompts: async () => [], registerListener: async () => {}, unregisterListener: async () => {},
      recordWake: async () => ({ allowed: true }), promptQueued: () => {},
    });
    const session = Barry.identity("bux").session(id);
    expect(await session.listening()).toBe(false);
    listeners = { [id]: { guarantee: "wake", listeners: [] } };
    expect(await session.listening()).toBe(true);
    listeners = { [id]: { guarantee: "none", listeners: [{ sessionId: id, kind: "runtime", guarantee: "none", lastWaitAt: 1 }] } };
    expect(await session.listening()).toBe(true);
    listeners = { [id]: { guarantee: "none", listeners: [] } };
    expect(await session.listening()).toBe(false);
  });

  it("refuses another identity for each history and listener method", async () => {
    const id = seed();
    const other = Barry.identity("ida").session(id);
    expect(await refusal(other.messages({ newestFirst: true }))).toBe("not_found");
    expect(await refusal(other.message(0))).toBe("not_found");
    expect(await refusal(other.listening())).toBe("not_found");
  });

  it("lets a device read history it may read, and refuses it the listener status", async () => {
    const id = seed({ user: 1 });
    await appendMessage(id, { type: "text", content: "zero" });
    const phone = Barry.as(device()).identity("bux").session(id);
    expect((await phone.messages()).map(m => m.sequence)).toEqual([0]);
    expect(await phone.message(0)).toMatchObject({ sequence: 0 });
    expect(await refusal(phone.listening())).toBe("forbidden");
    const otherUser = Barry.as(device()).identity("bux").session(seed({ user: 2 }));
    expect(await refusal(otherUser.message(0))).toBe("not_found");
  });

  it("maps branch, transcript and process metadata, retaining only numeric pids", async () => {
    const id = seed({ metadata: { git_branch: "feature", transcript_path: "/scratch/transcript", hostname: "mac", pid: 42, pid_started_at: 1700000000 } });
    expect(await Barry.identity("bux").session(id).get()).toMatchObject({
      branch: "feature", transcriptPath: "/scratch/transcript", hostname: "mac", pid: 42, pidStartedAt: 1700000000,
    });
    const invalid = seed({ metadata: { pid: "42", pid_started_at: "1700000000" } });
    expect(await Barry.identity("bux").session(invalid).get()).toMatchObject({
      branch: null, transcriptPath: null, hostname: null, pid: null, pidStartedAt: null,
    });
  });
});

describe("session bags, bounds, pinned bound, and tools", () => {
  it("resolves bags from the session row or falls back to identity bags", async () => {
    const inherited = seed();
    expect((await Barry.identity("bux").session(inherited).bags()).map((b) => b.name)).toEqual(["git"]);

    await Barry.identity("bux").session(inherited).update({ bags: ["linear"] });
    expect((await Barry.identity("bux").session(inherited).bags()).map((b) => b.name)).toEqual(["linear"]);
  });

  it("pins the resolved bound and filters tools without re-resolving live bounds until updated", async () => {
    const id = seed();
    const session = Barry.identity("bux").session(id);

    // Unrestricted initially: both read and write tools from `git` are enabled
    expect((await session.tools()).map((t) => t.name)).toEqual(["status", "commit"]);

    // Update bounds to ["readonly"] — pins { tools: { deny: ["*:write"] } } on the row
    await session.update({ bounds: ["readonly"] });
    expect(await session.bounds()).toEqual(["readonly"]);
    expect(await session.bound()).toMatchObject({ tools: { deny: ["*:write"] } });
    expect((await session.tools()).map((t) => t.name)).toEqual(["status"]);

    // Directly mutate the pinned bound column to verify session.bound() reads the pinned row.bound
    getSessionsSqlite()
      .prepare("UPDATE sessions SET bound = ? WHERE id = ?")
      .run(JSON.stringify({ files: { deny: [".env"] } }), id);
    expect(await session.bound()).toEqual({ files: { deny: [".env"] } });
  });
});
