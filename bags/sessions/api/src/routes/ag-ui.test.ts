import { authorizeRequest } from "@barry-rocks/sdk/internal/auth";
import express from "express";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TurnExecution } from "@barry-rocks/sdk/sessions";
import { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";
import { AgUiConnection, AgUiEventType, type AgUiEvent, type RunAgentInput } from "@barry-rocks/sdk/apps";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";

const mock = vi.hoisted(() => ({ service: null as { store: TurnContinuations; execution: TurnExecution } | null, effects: 0, gating: "per-call" }));
vi.mock("../turn-execution.js", () => ({ turnExecutionService: () => mock.service, prepareTurnSession: async () => ({ provider: "fixture" }) }));
vi.mock("../agent-runtime.js", () => ({ getDescribeAdapter: () => () => ({ modes: { hosted: { approvalContinuation: "durable", guarantees: { gating: mock.gating } } } }) }));
vi.mock("../session-runtime.js", () => ({ sessionRuntime: { prepareTurnAttachments: vi.fn(async () => "<attachments>fixture</attachments>") } }));
vi.mock("../db.js", () => ({ getSessionRecord: async (id: string) => id === "session" ? { metadata: {}, active: true, state: "open" } : null }));
vi.mock("@barry-rocks/sessions-bag/client", async original => ({ ...await original<Record<string, unknown>>(), getSession: async (id: string) => id === "session" ? { id, metadata: {}, active: true, state: "open" } : null }));
vi.mock("@barry-rocks/identities-bag", async original => {
  const actual = await original<typeof import("@barry-rocks/identities-bag")>();
  return { ...actual, owner: { ...actual.owner, current: async () => ({ id: 1 }), users: { ...actual.owner.users, get: async () => ({ id: 1 }) } } };
});
const { createAgUiRouter } = await import("./ag-ui.js");
let server: Server; let url: string; let db: Database.Database; let client: AgUiConnection;

async function run(input: RunAgentInput): Promise<AgUiEvent[]> {
  const events: AgUiEvent[] = [];
  for await (const delivery of client.run(input)) events.push(delivery.event);
  return events;
}

describe("AG-UI HTTP approval flow", () => {
  beforeAll(async () => {
    db = new Database(":memory:"); db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('session');");
    db.exec(readFileSync(new URL("../../../migrations/sessions/010_turn_continuations.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../../../migrations/sessions/011_turn_owner_process.sql", import.meta.url), "utf8"));
    const store = new TurnContinuations(db);
    const execution = new TurnExecution({ store, authorize: async () => ({ allow: true }), openHarness: async () => ({
      approvalContinuation: "durable", validate: () => {}, close: async () => {}, interrupt: async () => {},
      begin: async (_input, emit) => {
        await emit({ type: "tool_use", id: "call", tool: "effect", input: { exact: "original" } });
        return { type: "interrupted", calls: [{ id: "call", tool: "effect", input: { exact: "original" } }], continuation: { format: "fixture", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "config", payload: {} } };
      },
      restore: async (_checkpoint, decisions, effects, emit) => {
        if (decisions.get("call")?.allow) await effects.execute({ id: "call", tool: "effect", input: { exact: "original" } }, async () => { mock.effects++; return { id: "call", result: "Done" }; });
        await emit({ type: "tool_result", id: "call", result: "Done" });
        await emit({ type: "partial", text: "Finished" });
        return { type: "completed", result: "Finished" };
      },
    }) });
    mock.service = { store, execution };
    // Execution is the installation owner's, and the identities subject says who that is.
    Barry.use(fakeIdentities({ owner: async () => ({ id: 1, name: "fixture", defaultIdentity: null }) }));
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { request.headers.authorization = "Bearer protocol-fixture"; next(); });
    app.use(authorizeRequest({ verifyCredential: () => ({ kind: "installation", actorId: 1, credentialId: "installation" }), policy: () => null }));
    app.use(createAgUiRouter());
    server = createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    client = new AgUiConnection({ baseUrl: url });
  });
  afterAll(async () => { client.close(); await mock.service?.execution.close(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); Barry.reset(); });

  it("pauses without effects and resumes the same turn with idempotent run retries", async () => {
    const initial = { threadId: "session", runId: "initial", messages: [{ id: "user", role: "user", content: "Work" }] };
    const paused = await run(initial as RunAgentInput);
    const terminal = paused.at(-1);
    expect(terminal).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } });
    expect(mock.effects).toBe(0);
    const turnId = (await client.snapshot("session")).turn?.id;
    const replay = await run(initial as RunAgentInput); expect(replay).toEqual(paused);
    const state = await client.snapshot("session");
    expect(state.turn?.state).toBe("waiting_for_input");
    if (terminal?.type !== AgUiEventType.RUN_FINISHED || terminal.outcome?.type !== "interrupt") throw new Error("the run did not pause on an interrupt");
    const resume = { threadId: "session", runId: "resumed", messages: state.messages, resume: [{ interruptId: terminal.outcome.interrupts[0].id, status: "resolved", payload: { approved: true } }] };
    const finished = await run(resume as RunAgentInput);
    expect(finished.at(-1)).toMatchObject({ type: "RUN_FINISHED", runId: "resumed" });
    expect((await client.snapshot("session")).turn?.id).toBe(turnId);
    expect(mock.effects).toBe(1);
    const retry = await run(resume as RunAgentInput); expect(retry).toEqual(finished); expect(mock.effects).toBe(1);
    await expect(run({ ...resume, resume: [{ ...resume.resume[0], payload: { approved: false } }] } as RunAgentInput)).rejects.toThrow("409");
  });

  it("rejects requests for missing sessions", async () => {
    await expect(run({ threadId: "foreign", runId: "bad", messages: [], tools: [], context: [] })).rejects.toThrow("404");
    await expect(client.snapshot("foreign")).rejects.toThrow("404");
    const mismatch = await fetch(`${url}/session/ag-ui`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: "foreign", runId: "bad", messages: [] }) });
    expect(mismatch.status).toBe(400);
  });

  it("refuses hook-only gating with a conflict before admitting execution", async () => {
    mock.gating = "hooks";
    try {
      const messages = (await client.snapshot("session")).messages;
      const response = await fetch(`${url}/session/ag-ui`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: "session", runId: "hooks-refused", messages: [...messages, { id: "hooks-user", role: "user", content: "Work" }], forwardedProps: { barry: { ifActive: "queue" } } }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ detail: "This adapter cannot provide per-call approval runs" });
      expect(mock.service!.store.byRun("session", "hooks-refused")).toBeUndefined();
    } finally { mock.gating = "per-call"; }
  });

  it("queues an incoming turn when active with ifActive queue and returns 202 with turn ID", async () => {
    // Start a turn that pauses on interrupt (state: waiting_for_input)
    const turn1 = {
      threadId: "session",
      runId: "turn1-run",
      messages: [...(await client.snapshot("session")).messages, { id: "u1", role: "user", content: "Work again" }],
    };
    const paused = await run(turn1 as RunAgentInput);
    expect(paused.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } });
    expect((await client.snapshot("session")).turn?.state).toBe("waiting_for_input");

    // Submitting without ifActive: "queue" throws 409 conflict
    const messages = (await client.snapshot("session")).messages;
    const turnQueued = {
      threadId: "session",
      runId: "queued-run-test",
      messages: [...messages, { id: "u2", role: "user", content: "Turn 2" }],
    };
    await expect(run(turnQueued as RunAgentInput)).rejects.toThrow("409");

    // Submitting with ifActive: "queue" returns 202 Accepted
    const res = await fetch(`${url}/session/ag-ui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...turnQueued,
        forwardedProps: { barry: { ifActive: "queue" } },
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; state: string };
    expect(body.state).toBe("queued");
    expect(res.headers.get("x-barry-turn-id")).toBe(body.id);

    const updatedMessages = (await client.snapshot("session")).messages;
    const queuedViaClient = await client.queue({
      threadId: "session",
      runId: "queued-via-client",
      messages: [...updatedMessages, { id: "u3", role: "user", content: "Turn 3" }],
    } as RunAgentInput);
    expect(queuedViaClient.state).toBe("queued");
  });
});
