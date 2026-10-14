import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Barry } from "../barry/index.js";
import { localConnection } from "./local-connection.js";
import { writeServiceRegistry } from "./service-registry.js";
const directories: string[] = [];
afterEach(() => { Barry.reset(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
it("selects registry addresses and the scratch installation secret without a request", async () => {
  const home = mkdtempSync(join(tmpdir(), "local-connection-"));
  directories.push(home);
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_SERVICE_REGISTRY", "");
  vi.stubEnv("BARRY_SECRET", "unrelated-shell-key");
  mkdirSync(join(home, "app-support"));
  writeFileSync(join(home, "app-support", "env"), "BARRY_SECRET=installation-key\n");
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
    "sessions.api": { bag: "sessions", name: "api", kind: "service", url: "http://api.test" },
    "identities.identities": { bag: "identities", name: "identities", kind: "service", url: "http://identities.test" },
  } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ identities: [] }));
  const options = await localConnection({ fetch });
  expect(options).toMatchObject({ baseUrl: "http://api.test", secret: "installation-key", identities: { baseUrl: "http://identities.test", secret: "installation-key" } });
  expect(fetch).not.toHaveBeenCalled();
  Barry.connect(options);
  await Barry.identities();
  expect(String(fetch.mock.calls[0][0])).toBe("http://identities.test/api/v1/identities");
  expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer installation-key" });
  expect(await localConnection({ baseUrl: "http://explicit.test", secret: "explicit-key", identities: { baseUrl: "http://identity-override.test" } })).toMatchObject({ baseUrl: "http://explicit.test", secret: "explicit-key", identities: { baseUrl: "http://identity-override.test" } });
});

function scratchInstance(resources: Parameters<typeof writeServiceRegistry>[0]["resources"]): void {
  const home = mkdtempSync(join(tmpdir(), "local-connection-"));
  directories.push(home);
  vi.stubEnv("BARRY_HOME", home);
  vi.stubEnv("BARRY_SERVICE_REGISTRY", "");
  mkdirSync(join(home, "app-support"));
  writeFileSync(join(home, "app-support", "env"), "BARRY_SECRET=installation-key\n");
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {
    "sessions.api": { bag: "sessions", name: "api", kind: "service", url: "http://api.test" }, ...resources,
  } });
}
it("reaches service control through the registry's mcp.server, keeping explicit services options", async () => {
  scratchInstance({ "mcp.server": { bag: "mcp", name: "server", kind: "service", url: "http://mcp.test" } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ services: [] }));
  expect(await Barry.at(await localConnection({ fetch })).services()).toEqual([]);
  expect(String(fetch.mock.calls[0][0])).toBe("http://mcp.test/api/v1/services");
  expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer installation-key" });
  expect((await localConnection({ fetch, services: { baseUrl: "http://explicit-mcp.test" } })).services).toEqual({ baseUrl: "http://explicit-mcp.test" });
});
it("leaves service control unconfigured when the registry does not name mcp.server", async () => {
  scratchInstance({});
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(Barry.at(await localConnection({ fetch })).services()).rejects.toMatchObject({ reason: "unavailable" });
  expect(fetch).not.toHaveBeenCalled();
});
