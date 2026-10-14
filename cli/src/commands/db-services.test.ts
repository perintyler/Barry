import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";
import { managedServices } from "@barry-rocks/mcp-bag";
import type { ServiceDefinition } from "@barry-rocks/mcp-bag";
import type { JobState, ServiceOS } from "@barry-rocks/mcp-bag";
import { scratchEnvironment, serviceFixture } from "../releases/__tests__/release-home.js";
import { storeServices, switchStoreGeneration } from "./db-services.js";
beforeEach(scratchEnvironment);
it.each(["Upgrade", "Release rollback"] as const)("%s restarts on failure with release-specific advice", async command => {
  const fixture = serviceFixture();
  await expect(switchStoreGeneration({ command, previous: "release A", services: fixture.services, switch: async () => { throw new Error("failed switch"); } })).rejects.toThrow(command === "Upgrade" ? "services restarted on the previous release" : "services restarted on the release the upgrade installed");
  expect(fixture.started).toEqual(fixture.stopped);
});
it.each(["Upgrade", "Release rollback"] as const)("%s reports a restart failure with the kept release", async command => {
  const fixture = serviceFixture();
  fixture.services.start = async () => { throw new Error("failed start"); };
  await expect(switchStoreGeneration({ command, previous: "release A", services: fixture.services, switch: async () => ({ directory: "release B" }) })).rejects.toThrow("release A is kept for `barry upgrade --rollback`");
});
it("reads the new on-disk service command before starting", async () => {
  const home = barryAppSupportDir(), path = join(home, "managed-definitions.json");
  const definition: ServiceDefinition = { name: "fixture.api", command: ["/old/node", "/old/entry"], directory: home, domain: `gui/${process.getuid!()}`, plistDirectory: join(home, "plists"), logDirectory: join(home, "logs") };
  let state: JobState = { loaded: false }, plist = "";
  const os: ServiceOS = { inspect: () => state, load: (_domain, path) => { plist = readFileSync(path, "utf8"); state = { loaded: true }; }, unload: async () => { state = { loaded: false }; }, start: () => {}, enable: () => {} };
  // Opening management creates only this scratch instance directory.
  managedServices({ os });
  vi.stubEnv("BARRY_SERVICE_REGISTRY", join(home, "bag-resources.json"));
  writeFileSync(join(home, "bag-resources.json"), JSON.stringify({ version: 2, generated: new Date().toISOString(), resources: {} }));
  writeFileSync(path, JSON.stringify([definition]));
  const services = storeServices(os), management = managedServices({ os });
  await management.apply("fixture.api", "add");
  writeFileSync(path, JSON.stringify([{ ...definition, command: ["/new/node", "/new/entry"], environment: { BARRY_NODE: "/new/node" } }]));
  await services.start("fixture.api");
  expect(plist).toContain("/new/entry"); expect(plist).toContain("BARRY_NODE"); expect(plist).not.toContain("/old/entry");
});
