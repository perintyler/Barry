import { describe, expect, it, vi } from "vitest";
import type { ServiceChoice, ServiceDefinition } from "@barry-rocks/mcp-bag";
import { readServiceRegistry } from "@barry-rocks/sdk/services";
import { systemPaths } from "./system.js";
import { installedServices, retainedDefinitions } from "./barry.js";

vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadRegistry: () => ({ vault: { type: "local", path: new URL("../../../bags/vault", import.meta.url).pathname } }),
  loadAllBags: async () => [{
  name: "vault", manifest: {}, apps: [],
  services: [{ name: "api", description: "vault", entry: "dist/server.mjs", user: "_barryvault", socket: "run/vault.sock", health: "/health" }],
}],
}));

const definition = (name: string): ServiceDefinition => ({
  name,
  command: ["/usr/bin/true"],
  directory: "/",
  domain: "gui/501",
  plistDirectory: "/tmp",
  logDirectory: "/tmp",
});

describe("definitions a bag no longer declares", () => {
  const choices: Record<string, ServiceChoice> = {
    "barry.mcp": { registered: false, enabled: false },
    "gone.daemon": { registered: true, enabled: true },
    "half.removed": { registered: false, enabled: false, pending: "remove" },
  };
  const choice = (name: string): ServiceChoice => choices[name] ?? { registered: false, enabled: false };
  const previous = ["barry.mcp", "gone.daemon", "half.removed", "never.added", "mcp.server"].map(definition);
  const kept = retainedDefinitions(previous, [definition("mcp.server")], choice).map((d) => d.name);

  it("are dropped once the service has been removed, so the old name stops shadowing the new one", () => {
    expect(kept).not.toContain("barry.mcp");
    expect(kept).not.toContain("never.added");
  });
  it("are kept while launchd may still hold the service, or a removal did not finish", () => {
    expect(kept).toEqual(["gone.daemon", "half.removed"]);
  });
  it("are not doubled when the bag still declares them", () => {
    expect(kept).not.toContain("mcp.server");
  });
});

it("prepares the vault registry at its per-instance state socket without changing launchd", async () => {
  const refuse = () => { throw new Error("preparation changed launchd"); };
  vi.stubEnv("BARRY_CONFIG_ALLOW_EMPTY", "1");
  const management = await installedServices({ refresh: true, os: { inspect: () => ({ loaded: false }), load: refuse, unload: async () => refuse(), start: refuse, enable: refuse } });
  const paths = systemPaths(management.instance, "vault", "vault.api");
  expect(management.definition("vault.api")).toMatchObject({ domain: "system", user: "_barryvault", directory: paths.code, logDirectory: paths.logs });
  expect(readServiceRegistry().resources["vault.api"].url).toBe(`unix://${paths.state}/run/vault.sock`);
  vi.unstubAllEnvs();
});
it("refuses root preparation and refresh before opening an instance", async () => {
  const uid = vi.spyOn(process, "getuid").mockReturnValue(0);
  try { await expect(installedServices({ prepare: true })).rejects.toThrow("not root"); await expect(installedServices({ refresh: true })).rejects.toThrow("not root"); }
  finally { uid.mockRestore(); }
});
