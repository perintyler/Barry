import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { applyBaseMiddleware } from "@barry-rocks/sdk/services/http";
import { hasValidSecret } from "@barry-rocks/sdk/internal/auth";

/**
 * SES-6: an attachment upload carries a base64 blob that routinely exceeds the
 * base parser's 1mb cap. The upload parser is mounted BEFORE applyBaseMiddleware
 * so a >1mb body reaches the attachments route, while every other route keeps
 * the 1mb cap. This reproduces that exact middleware ordering and proves both
 * halves: a 2mb attachment is accepted, and a 2mb body on a sibling route is
 * rejected with 413.
 */

vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  getSessionRecord: vi.fn(async (id: string) => (id.startsWith("sess_") ? { id, metadata: {} } : undefined)),
  appendMessage: vi.fn(async () => undefined),
}));
vi.mock("@barry-rocks/sessions-bag/execution-authorization", () => ({
  authorizeSessionExecution: vi.fn(async () => ({ kind: "installation", actorId: 1, credentialId: "installation" })),
}));
vi.mock("../session-runtime.js", () => ({ sessionRuntime: {}, buildMcpConfig: vi.fn() }));

import { sessionLifecycleRouter } from "./session-lifecycle.js";

describe("attachment upload body-size seam", () => {
  let server: Server;
  let baseUrl: string;
  let tmpHome: string;

  beforeAll(async () => {
    process.env.BARRY_SECRET = "barry_test_secret_ses6";
    const app = express();

    // Exactly the ordering from sessionsApi(): the large-body parsers are gated
    // on a valid instance secret and run before the base 1mb parser, so an
    // authenticated attachment upload reads a >1mb body while a sibling route
    // keeps the 1mb cap.
    const attachmentUpload = /^\/api\/v1\/sessions\/[^/]+\/attachments\/?$/;
    const attachmentParser = express.json({ limit: "30mb" });
    app.use((req, res, next) => {
      if (!hasValidSecret(req)) return next();
      if (req.method === "POST" && attachmentUpload.test(req.path)) return attachmentParser(req, res, next);
      next();
    });
    applyBaseMiddleware(app);
    app.use((req, _res, next) => {
      Object.defineProperty(req, "authPrincipal", { value: { kind: "installation", actorId: 1, credentialId: "installation" }, configurable: true });
      next();
    });
    // A sibling route under the same base parser, to prove the 1mb cap still
    // holds everywhere else.
    app.post("/api/v1/sessions/:id/echo", (req, res) => res.json({ ok: true, size: JSON.stringify(req.body).length }));
    app.use("/api/v1/sessions", sessionLifecycleRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "barry-att-size-"));
    vi.stubEnv("BARRY_HOME", tmpHome);
  });

  const AUTH = { Authorization: "Bearer barry_test_secret_ses6", "Content-Type": "application/json" };

  it("accepts a 2mb attachment through the early parser", async () => {
    const base64 = Buffer.alloc(2 * 1024 * 1024, 0x61).toString("base64"); // ~2.7mb of base64
    const res = await fetch(`${baseUrl}/sessions/sess_big/attachments`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "big.bin", mimeType: "application/octet-stream", base64 }),
    });
    // The upload reaches the route (not a 413 from the 1mb base parser). The
    // route may accept it (201) or reject the mime type (400) — either way it
    // got past the body-size cap, which is the seam under test.
    expect(res.status).not.toBe(413);
    const body = await res.json();
    if (res.status === 201) {
      expect(body.attachment.size).toBe(2 * 1024 * 1024);
    }
  });

  it("accepts a 2mb text attachment and records its full size", async () => {
    const base64 = Buffer.alloc(2 * 1024 * 1024, 0x62).toString("base64");
    const res = await fetch(`${baseUrl}/sessions/sess_text/attachments`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "big.txt", mimeType: "text/plain", base64 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.attachment.size).toBe(2 * 1024 * 1024);
  });

  it("still rejects a >1mb body on a sibling route with 413", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/sessions/sess_big/echo`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ blob: big }),
    });
    expect(res.status).toBe(413);
  });

  it("does not run the 30mb parser for an unauthenticated upload (SES-18 gate)", async () => {
    // Without a valid secret the large parser is skipped, so the base 1mb parser
    // sees the >1mb body and 413s it before auth would 401 — the point being the
    // API never parses a 30mb body for an unauthenticated caller.
    const base64 = Buffer.alloc(2 * 1024 * 1024, 0x63).toString("base64");
    const res = await fetch(`${baseUrl}/sessions/sess_big/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "big.txt", mimeType: "text/plain", base64 }),
    });
    expect(res.status).toBe(413);
  });
});
