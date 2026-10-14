import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestObject } from "@barry-rocks/sdk/bags";
import { buildServiceSpecs, retainUnreadableBagServices, type ServiceSpec } from "./specs.js";
import type { Bag } from "@barry-rocks/sdk/bags";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "service specs ")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const proxy = { proxy: { description: "proxy", command: "/usr/bin/env", args: ["true"] } };
const loaded = (name: string, services: Record<string, object> = proxy) => {
  const manifest = parseManifestObject({ name, description: name, services });
  return { name, manifest, services: Object.entries(manifest.services).map(([service, spec]) => ({ name: service, ...spec })) } as Bag;
};
const unreadable = (name: string): Bag => ({ ...loaded(name), manifest: null, services: [] });
const prepared = (bag: string, name: string): ServiceSpec & { port: number } => ({
  key: `${bag}.${name}`, bag, name, description: name, command: "/usr/bin/env", args: ["true"],
  cwd: directory, env: [], autostart: "login", localOnly: false, injects: [], port: 4900,
});

describe("preparing bag services", () => {
  it("prepares the services of every registered local bag", () => {
    const { specs, problems } = buildServiceSpecs([loaded("gateway"), loaded("hq")], {
      gateway: { type: "local", path: directory },
      hq: { type: "local", path: directory },
    });
    expect(problems).toEqual([]);
    expect(specs.map((spec) => spec.key)).toEqual(["gateway.proxy", "hq.proxy"]);
  });

  it("keeps the prepared services of a bag whose manifest could not be read", () => {
    const bags = [unreadable("gateway"), loaded("hq")];
    const { specs } = buildServiceSpecs(bags, { gateway: { type: "local", path: directory }, hq: { type: "local", path: directory } });
    const retained = retainUnreadableBagServices(bags, specs, { "gateway.proxy": prepared("gateway", "proxy"), "hq.proxy": prepared("hq", "proxy") });
    expect(retained.map((spec) => spec.key)).toEqual(["gateway.proxy"]);
    // The port is assigned again from the persisted assignment, not copied.
    expect(retained[0]).not.toHaveProperty("port");
  });

  it("drops a service its readable manifest no longer declares, and one whose bag left the registry", () => {
    const bags = [loaded("hq", {})];
    const retained = retainUnreadableBagServices(bags, [], { "hq.web": prepared("hq", "web"), "gone.api": prepared("gone", "api") });
    expect(retained).toEqual([]);
  });
});

it("requires a built entry for system services and resolves their socket under state", () => {
  const registry = { vault: { type: "local" as const, path: directory } };
  for (const entry of [undefined, "src/server.ts"]) {
    const result = buildServiceSpecs([loaded("vault", { api: { description: "vault", user: "_barryvault", ...(entry ? { entry } : { command: "/usr/bin/true" }) } })], registry, () => "/state");
    expect(result.problems[0].message).toContain("built JavaScript entry");
  }
  const result = buildServiceSpecs([loaded("vault", { api: { description: "vault", user: "_barryvault", entry: "dist/server.mjs", socket: "run/vault.sock" } })], registry, () => "/state");
  expect(result.problems).toEqual([]); expect(result.specs[0]).toMatchObject({ entry: join(directory, "dist/server.mjs"), socket: "/state/run/vault.sock" });
});
