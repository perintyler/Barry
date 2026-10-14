import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { FakeSession } from "../test-helpers/fake-session.js";

/**
 * SES-22: `POST /sessions/:id/compact` must answer 501 when the session's
 * adapter does not expose the `compact` capability, instead of delivering a
 * literal `/compact` that lands as a user message. A session whose adapter
 * does expose it compacts and answers 200.
 */

const activeSessions = new Map<string, { session: unknown; sessionId: string | null }>();

vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  getSessionRecord: vi.fn(async (id: string) => (id.startsWith("sess_") ? { id, metadata: {} } : undefined)),
  appendMessage: vi.fn(async () => undefined),
}));
vi.mock("@barry-rocks/sessions-bag/execution-authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sessions-bag/execution-authorization")>()),
  authorizeSessionExecution: vi.fn(async () => ({ kind: "installation", actorId: 1, credentialId: "installation" })),
}));
vi.mock("../session-runtime.js", () => ({
  sessionRuntime: {
    getActiveSession: (id: string) => activeSessions.get(id),
    sendMessage: vi.fn(async () => {
      throw new Error("compact must not fall back to sendMessage");
    }),
  },
  buildMcpConfig: vi.fn(),
}));

import { sessionLifecycleRouter } from "./session-lifecycle.js";

describe("POST /sessions/:id/compact capability", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "authPrincipal", { value: { kind: "installation", actorId: 1, credentialId: "installation" }, configurable: true });
      next();
    });
    app.use("/api/v1/sessions", sessionLifecycleRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  it("answers 501 when the adapter lacks compact", async () => {
    const fake = new FakeSession();
    expect("compact" in fake).toBe(false);
    activeSessions.set("sess_nocompact", { session: fake, sessionId: fake.harnessSessionId });

    const res = await fetch(`${baseUrl}/sessions/sess_nocompact/compact`, { method: "POST" });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("does not support compaction");
  });

  it("compacts and answers 200 when the adapter exposes compact", async () => {
    const fake = new FakeSession() as FakeSession & { compact?: () => Promise<void> };
    let compacted = 0;
    fake.compact = async () => {
      compacted += 1;
    };
    activeSessions.set("sess_withcompact", { session: fake, sessionId: fake.harnessSessionId });

    const res = await fetch(`${baseUrl}/sessions/sess_withcompact/compact`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(compacted).toBe(1);
    // It must not have fallen through to the literal `/compact` message path.
    expect(fake.delivered).toEqual([]);
  });

  it("answers 400 when no active session exists", async () => {
    const res = await fetch(`${baseUrl}/sessions/sess_inactive/compact`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});
