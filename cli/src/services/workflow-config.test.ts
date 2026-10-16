import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadBagSync } from "@barry-rocks/sdk/internal/bags";
import type { Bag, BagRegistry } from "@barry-rocks/sdk/bags";
import { buildServiceSpecs, type ServiceSpec } from "./specs.js";
import { installationEnvironment } from "./installation-environment.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
let directory: string;
let configuration: string;
let runtime: ServiceSpec;
let sessions: ServiceSpec;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "workflow-service-config-"));
  configuration = join(directory, "barry.yaml");
  const registry: BagRegistry = {
    workflows: { type: "local", path: join(repository, "bags/workflows") },
    sessions: { type: "local", path: join(repository, "bags/sessions") },
  };
  const snapshot = join(directory, "bags.snapshot.json");
  writeFileSync(snapshot, JSON.stringify({ bags: registry }));
  vi.stubEnv("BARRY_BAGS_SNAPSHOT", snapshot);
  vi.stubEnv("BARRY_BUILTIN_DIR", join(repository, "bags"));
  // Use the production manifest loader, including its service normalization.
  // No service definitions or environment declarations are invented here.
  const bags = [loadBagSync("workflows"), loadBagSync("sessions")];
  expect(bags.every((bag): bag is Bag => Boolean(bag?.manifest))).toBe(true);
  const prepared = buildServiceSpecs(bags as Bag[], registry);
  expect(prepared.problems).toEqual([]);
  runtime = prepared.specs.find(spec => spec.key === "workflows.runtime")!;
  sessions = prepared.specs.find(spec => spec.key === "sessions.api")!;
  expect(runtime.entry).toBe(join(repository, "bags/workflows/runtime/src/service.ts"));
  expect(sessions.entry).toBe(join(repository, "bags/sessions/api/src/index.ts"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function configure(services: Record<string, Record<string, string>>) {
  writeFileSync(configuration, JSON.stringify({ services: Object.fromEntries(
    Object.entries(services).map(([key, env]) => [key, { env: Object.entries(env).map(([name, value]) => `${name}=${value}`) }]),
  ) }));
}

function environment(spec: ServiceSpec) {
  return Object.fromEntries(installationEnvironment(spec.key, spec.env, spec.secrets, configuration)
    .map(entry => [entry.name, entry.value]));
}

it("prepares installed identity workflow deployment paths through the real service declarations", () => {
  const deployed = {
    BARRY_WORKFLOW_POLICY: "/trusted deployment/current-policy.json",
    BARRY_WORKFLOW_ARCHIVE_DIR: "/trusted deployment/archive",
    BARRY_WORKFLOW_DELEGATION_KEYS: "/trusted deployment/runtime-delegation.json",
    BARRY_WORKFLOW_SCRIPT_RESOURCES: "/trusted deployment/scripts.json",
    BARRY_WORKFLOW_ACTION_PROJECTIONS: "/trusted deployment/projections.json",
    BARRY_WORKFLOW_COMMON_HOSTS: "/trusted deployment/hosts.json",
    BARRY_WORKFLOW_SCRIPT_TRAITS: '["bash", "sessions"]',
    BARRY_WORKFLOW_ARTIFACT_BYTES: "67108864",
  };
  configure({ "workflows.runtime": deployed });
  // The former manifests refused these requested installation overrides before
  // a service could start: installationEnvironment rejects undeclared values.
  expect(environment(runtime)).toMatchObject(deployed);
  expect(environment(sessions)).not.toHaveProperty("BARRY_WORKFLOW_POLICY");
  expect(runtime.env.find(entry => entry.name === "BARRY_WORKFLOW_DELEGATION_KEYS")?.value).toBe("");
});

it("configures the Sessions issuer key independently of the Runtime key", () => {
  configure({ "sessions.api": {
    BARRY_WORKFLOW_DELEGATION_KEYS: "/trusted deployment/sessions=keys-$literal.json",
  } });
  // Independently fails with the old Sessions manifest, even if Runtime's
  // declarations have already been repaired.
  expect(environment(sessions).BARRY_WORKFLOW_DELEGATION_KEYS).toBe("/trusted deployment/sessions=keys-$literal.json");
  expect(environment(runtime).BARRY_WORKFLOW_DELEGATION_KEYS).toBe("");
});

it("keeps opt-in workflow modes disabled with an empty installation configuration", () => {
  configure({});
  const defaults = environment(runtime);
  for (const name of ["BARRY_WORKFLOW_MODULE", "BARRY_WORKFLOW_POLICY", "BARRY_WORKFLOW_ARCHIVE_DIR",
    "BARRY_WORKFLOW_DELEGATION_KEYS", "BARRY_WORKFLOW_SCRIPT_RESOURCES", "BARRY_WORKFLOW_ACTION_PROJECTIONS",
    "BARRY_WORKFLOW_COMMON_HOSTS", "BARRY_WORKFLOW_SCRIPT_TRAITS"]) {
    expect(defaults[name], name).toBe("");
  }
  expect(defaults.BARRY_WORKFLOW_ARTIFACT_BYTES).toBe("33554432");
  expect(defaults.BARRY_WORKFLOW_CAPACITY).toBe("4");
  expect(environment(sessions).BARRY_WORKFLOW_DELEGATION_KEYS).toBe("");
  expect(environment(sessions).NODE_ENV).toBe("production");
});

it("rejects credential, test-clock and cross-service overrides before preparing launch environment", () => {
  for (const spec of [runtime, sessions]) {
    for (const name of ["BARRY_SECRET", "BARRY_WORKFLOW_ACTOR_KEY", "BARRY_ALLOW_REAL_VAULT",
      "BARRY_WORKFLOW_TEST_CLOCK", "BARRY_WORKFLOW_CLOCK_OFFSET_MS", "BARRY_WORKFLOW_WORKER_ONLY", "BARRY_WORKFLOW_PROFILE"]) {
      configure({ [spec.key]: { [name]: "not-an-installation-literal" } });
      expect(() => environment(spec), `${spec.key}/${name}`).toThrow("not a declared nonsecret value");
    }
  }
  configure({ "sessions.api": { BARRY_WORKFLOW_POLICY: "/runtime-only.json" } });
  expect(() => environment(sessions)).toThrow("BARRY_WORKFLOW_POLICY is not a declared nonsecret value");
  // An override addressed to Sessions must neither leak into Runtime nor
  // prevent Runtime from using its own declared defaults.
  expect(environment(runtime).BARRY_WORKFLOW_POLICY).toBe("");
});
