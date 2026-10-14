import { afterEach, expect, it, vi } from "vitest";
import { BarryClient } from "./platypus.js";
import { connectLocal } from "./local.js";
import { writeServiceRegistry } from "../services/service-registry.js";
import type { Service } from "../barry/types.js";
const service: Service = { key: "fixture.api", bag: "fixture", name: "api", kind: "service", state: "running", registered: true, enabled: true, system: false, pid: 123, port: 4885, address: "http://127.0.0.1:4885", health: "ok", restarts: 2, startedAt: null, lastExitCode: 7, workingDirectory: "/fixture", loopbackOnly: true, conflict: null, problem: null };
afterEach(() => vi.restoreAllMocks());
it("calls all five declarations against the separate transport with read/control deadlines", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetch = vi.fn<typeof globalThis.fetch>(async input => Response.json(String(input).endsWith("/services") ? { services: [service] } : { service }));
  const client = new BarryClient({ baseUrl: "http://api.test", services: { baseUrl: "http://mcp.test", secret: "fixture", fetch } });
  expect(await client.services.list()).toEqual([service]); expect(await client.services.get(service.key)).toEqual(service);
  await client.services.start(service.key); await client.services.stop(service.key); await client.services.restart(service.key);
  expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    ["http://mcp.test/api/v1/services", "GET"], ["http://mcp.test/api/v1/services/fixture.api", "GET"],
    ["http://mcp.test/api/v1/services/fixture.api/start", "POST"], ["http://mcp.test/api/v1/services/fixture.api/stop", "POST"], ["http://mcp.test/api/v1/services/fixture.api/restart", "POST"],
  ]);
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 30_000, 120_000, 120_000, 120_000]);
});
it("returns null for a missing service and refuses an unconfigured transport", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}, { status: 404 }));
  const client = new BarryClient({ baseUrl: "http://api.test", services: { baseUrl: "http://mcp.test", fetch } });
  expect(await client.services.get("missing.api")).toBeNull();
  await expect(new BarryClient({ baseUrl: "http://api.test" }).services.list()).rejects.toMatchObject({ code: "service_unconfigured" });
});
it("discovers MCP locally and keeps explicit services credentials", async () => {
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: { "mcp.server": { bag: "mcp", name: "server", kind: "service", url: "http://local-mcp.test" } } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ services: [] }));
  await (await connectLocal({ baseUrl: "http://api.test", secret: "fixture", fetch })).services.list();
  expect(String(fetch.mock.calls[0][0])).toBe("http://local-mcp.test/api/v1/services");
  await (await connectLocal({ baseUrl: "http://api.test", secret: "fixture", services: { baseUrl: "http://explicit.test", secret: "other", fetch } })).services.list();
  expect(String(fetch.mock.calls[1][0])).toBe("http://explicit.test/api/v1/services");
});
it("leaves services unconfigured when MCP is not registered", async () => {
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {} });
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = await connectLocal({ baseUrl: "http://api.test", secret: "fixture", fetch });
  await expect(client.services.list()).rejects.toMatchObject({ code: "service_unconfigured" });
  expect(fetch).not.toHaveBeenCalled();
});
