import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { applyBaseMiddleware } from "@barry-rocks/sdk/services/http";
import { hasValidSecret } from "@barry-rocks/sdk/internal/auth";

/**
 * SES-18: the 10mb OTLP parser must not run before authentication. It is gated
 * on a valid instance secret, so an unauthenticated caller cannot make the API
 * parse up to 10mb of JSON before being rejected. This reproduces the exact
 * gate `sessionsApi()` installs — the gated large parser, then the 1mb base
 * parser — and proves both halves: an authenticated >1mb `/v1` body is parsed
 * and reaches the handler, an unauthenticated one is caught by the 1mb parser
 * first (so the 10mb parser never runs for it).
 */
describe("OTLP parser is gated on the instance secret", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.BARRY_SECRET = "barry_test_secret_ses18";
    const app = express();

    const otlpParser = express.json({ limit: "10mb" });
    app.use((req, res, next) => {
      if (!hasValidSecret(req)) return next();
      if (req.path.startsWith("/v1/")) return otlpParser(req, res, next);
      next();
    });
    applyBaseMiddleware(app);
    // The receiver, standing in for otlpRouter mounted after auth. Reached only
    // if a parser already read the body.
    app.post("/v1/logs", (req, res) => res.json({ ok: true, bytes: JSON.stringify(req.body ?? {}).length }));
    // Express's body-parser raises a 413 as an error; surface it as the status
    // the client sees rather than the generic 500 the app's error handler uses.
    app.use((err: { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) return next(err);
      res.status(err.status ?? 500).json({ ok: false, type: err.type });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  it("parses a >1mb body for an authenticated OTLP request", async () => {
    const body = JSON.stringify({ blob: "x".repeat(1_500_000) }); // ~1.5mb
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer barry_test_secret_ses18" },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.bytes).toBeGreaterThan(1_000_000);
  });

  it("does not run the 10mb parser for an unauthenticated OTLP request", async () => {
    const body = JSON.stringify({ blob: "x".repeat(1_500_000) });
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // The 1mb base parser rejects it (413) before the 10mb parser could run.
    expect(res.status).toBe(413);
  });

  it("still parses a small authenticated OTLP body", async () => {
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer barry_test_secret_ses18" },
      body: JSON.stringify({ resourceLogs: [] }),
    });
    expect(res.status).toBe(200);
  });
});
