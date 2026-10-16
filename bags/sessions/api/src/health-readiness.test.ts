import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

/**
 * SES-11: `/health` is the readiness probe. When the session store is
 * unreachable it must answer 503 so a supervisor restarts the service, while
 * `/health/live` keeps answering 200 because the process itself is up. When the
 * store is reachable, `/health` stays 200 with `ok: true` for the callers that
 * grep for it.
 */

const stats = { reachable: true };

vi.mock("@barry-rocks/sessions-bag/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sessions-bag/client")>()),
  getSessionStats: vi.fn(async () => (stats.reachable ? { total: 0, active: 0 } : null)),
  listSessions: vi.fn(async () => []),
}));
vi.mock("../session-runtime.js", () => ({
  sessionRuntime: { getActiveSessionCount: () => 0 },
  buildMcpConfig: vi.fn(),
}));

const { sessionsApi } = await import("./app.js");

describe("GET /health readiness", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = sessionsApi();
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected a TCP address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  it("answers 200 with ok:true when the store is reachable", async () => {
    stats.reachable = true;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dbConnected).toBe(true);
    expect(body.build.schema.sessions).toBeGreaterThan(0);
    expect(body.build).toHaveProperty("release");
  });

  it("answers 503 with ok:false when the store is unreachable", async () => {
    stats.reachable = false;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.dbConnected).toBe(false);
  });

  it("keeps /health/live at 200 even when the store is unreachable", async () => {
    stats.reachable = false;
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
