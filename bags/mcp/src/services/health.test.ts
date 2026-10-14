import { expect, it } from "vitest";
import { createServer } from "node:http";
import { listenOnAssignedPort } from "@barry-rocks/sdk/services";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement } from "./management.js";
import { probeHealth, waitForServices } from "./health.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("waits for actual application readiness and cannot mistake an address for a running service", async () => {
  const home = mkdtempSync(join(tmpdir(), "barry-ready-"));
  let ready = false, running = true;
  const server = await listenOnAssignedPort(createServer((_req, response) => { response.statusCode = ready ? 200 : 503; response.end(); }), { PORT: "0" });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const url = `http://127.0.0.1:${address.port}`;
  const manager = new ServiceManagement(openInstance(home), [{ name: "fixture.api", command: ["/usr/bin/true"], directory: home, plistDirectory: home, logDirectory: home, domain: "gui/501", health: "/health" }], { inspect: () => ({ loaded: running, ...(running ? { pid: process.pid } : {}) }), enable: () => {}, load: () => {}, unload: async () => {}, start: () => {} });
  try {
    expect(await probeHealth(url, "/health")).toBe("failing");
    ready = true;
    await expect(waitForServices(manager, ["fixture.api"], { "fixture.api": { url } }, 500)).resolves.toBeUndefined();
    running = false;
    await expect(waitForServices(manager, ["fixture.api"], { "fixture.api": { url } }, 1)).rejects.toThrow("did not become ready");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});
