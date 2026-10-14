import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { BarryError } from "@barry-rocks/sdk";
import { ZodError } from "zod";
import { isStartValidationError } from "./start-session-errors.js";

/**
 * SES-24: `POST /sessions/start` must map validation to 400 and every other
 * fault to 500 via `sendProblem`. Before, the handler answered 400 for every
 * thrown error, so a transient store failure read as a client bug and leaked
 * the raw message. Both branches are exercised here.
 */
describe("isStartValidationError", () => {
  it("treats a ZodError as validation", () => {
    expect(isStartValidationError(new ZodError([]))).toBe(true);
  });

  it("treats a BarryError marked invalid as validation", () => {
    expect(isStartValidationError(new BarryError("invalid", "unknown bound"))).toBe(true);
  });

  it("does not treat an unavailable BarryError as validation", () => {
    expect(isStartValidationError(new BarryError("unavailable", "store down"))).toBe(false);
  });

  it("does not treat a plain Error as validation", () => {
    expect(isStartValidationError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
  });
});

const startSession = vi.fn(async () => {});

vi.mock("@barry-rocks/sessions-bag/lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sessions-bag/lifecycle")>()),
  startSession: (...args: unknown[]) => startSession(...(args as [])),
}));
vi.mock("@barry-rocks/sessions-bag/execution-authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sessions-bag/execution-authorization")>()),
  authorizeSessionExecution: vi.fn(async () => ({ kind: "installation", actorId: 1, credentialId: "installation" })),
}));
vi.mock("@barry-rocks/sessions-bag/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sessions-bag/client")>()),
  getSession: vi.fn(async () => undefined),
}));
vi.mock("../session-runtime.js", () => ({ sessionRuntime: {} }));

import { sessionsRouter } from "./sessions.js";

describe("POST /sessions/start error mapping", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "authPrincipal", { value: { kind: "installation", actorId: 1, credentialId: "installation" }, configurable: true });
      next();
    });
    app.use("/sessions", sessionsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  beforeEach(() => startSession.mockReset());

  async function postStart(): Promise<Response> {
    return fetch(`${baseUrl}/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess_ses24" }),
    });
  }

  it("answers 400 when startSession rejects with a validation error", async () => {
    startSession.mockRejectedValueOnce(new BarryError("invalid", "unknown bound: nope"));
    const res = await postStart();
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(body.detail).toContain("unknown bound");
  });

  it("answers 500 and hides the raw message when startSession fails for a server reason", async () => {
    startSession.mockRejectedValueOnce(new Error("SQLITE_BUSY: /Users/x/sessions.db locked"));
    const res = await postStart();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(body)).not.toContain("sessions.db");
  });

  it("answers 200 on success", async () => {
    startSession.mockResolvedValueOnce(undefined);
    const res = await postStart();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
