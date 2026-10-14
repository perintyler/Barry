import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Barry, type Caller, type Grants } from "@barry-rocks/sdk";
import { fakeSessions } from "@barry-rocks/sdk/testing";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement, type ServiceDefinition } from "./management.js";
import type { ServiceOS } from "./launchd.js";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";

const injected = vi.hoisted(() => ({ management: vi.fn() }));
vi.mock("./control.js", async importOriginal => ({
  ...await importOriginal<typeof import("./control.js")>(),
  managedServices: injected.management,
}));
import { services } from "./subject.js";

let home: string, management: ServiceManagement, os: ServiceOS;
let declarations: ServiceDefinition[];
const owner: Caller = { kind: "owner" };
const session: Caller = { kind: "session", identity: "bux", sessionId: "s1" };
const device: Caller = { kind: "device", principal: { kind: "device", credentialId: "d1", actorId: 1, identityIds: [], scopes: [] } };
const grants = (write: boolean): Grants => ({
  traits: write ? ["mcp:services"] : ["mcp:read"], bound: null, namespaces: ["mcp"],
  tools: write ? [{ name: "services_restart", namespace: "mcp", bag: "mcp", access: "write" }] : [],
  skills: [], instructions: [],
});
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "barry-mcp-services-"));
  vi.stubEnv("BARRY_HOME", home); vi.stubEnv("BARRY_SERVICE", "");
  declarations = ["fixture.api", "other.api", "system.api"].map(name => ({ name, command: [process.execPath], directory: home, domain: name.startsWith("system") ? "system" : "gui/501", plistDirectory: home, logDirectory: home }));
  os = { inspect: vi.fn(() => ({ loaded: false, runs: 4, lastExitCode: 7 })), load: vi.fn(), unload: vi.fn(async () => {}), enable: vi.fn(), start: vi.fn(), canControl: domain => domain !== "system" };
  management = new ServiceManagement(openInstance(home), declarations, os);
  await management.apply("fixture.api", "add"); await management.apply("other.api", "add");
  injected.management.mockImplementation(() => management);
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: { "fixture.api": { bag: "fixture", name: "api", kind: "service" } } });
  Barry.use(services, fakeSessions({ grants: async () => grants(false) }));
});
afterEach(() => { Barry.reset(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

it("maps every domain field and fills absent observations with null", async () => {
  expect(await Barry.service("fixture.api").get()).toEqual({
    key: "fixture.api", bag: "fixture", name: "api", kind: "service", state: "stopped",
    registered: true, enabled: false, system: false, pid: null, port: null, address: null,
    health: "unknown", restarts: 3, startedAt: null, lastExitCode: 7,
    workingDirectory: home, loopbackOnly: null, conflict: null, problem: null,
  });
  os.inspect = vi.fn(() => ({ loaded: true, state: "waiting" }));
  expect(await Barry.service("other.api").get()).toMatchObject({ state: "backoff", lastExitCode: null });
});

describe.each([
  ["owner", owner, true],
  ["device", device, false],
  ["session", session, true],
  ["bag session", { ...session, bag: "fixture" }, true],
] as const)("%s reads", (_name, caller, allowed) => {
  it("lists and gets services according to caller", async () => {
    if (allowed) {
      expect(await Barry.as(caller).services()).toHaveLength(3);
      expect((await Barry.as(caller).service("fixture.api").get()).key).toBe("fixture.api");
    } else {
      await expect(Barry.as(caller).services()).rejects.toMatchObject({ reason: "forbidden" });
      await expect(Barry.as(caller).service("fixture.api").get()).rejects.toMatchObject({ reason: "forbidden" });
    }
  });
});

it("lets the owner restart and refuses devices before touching the OS", async () => {
  await Barry.service("fixture.api").restart();
  expect(os.unload).toHaveBeenCalledOnce(); vi.mocked(os.unload).mockClear();
  await expect(Barry.as(device).service("fixture.api").restart()).rejects.toMatchObject({ reason: "forbidden" });
  expect(os.unload).not.toHaveBeenCalled();
});

it("allows a bag its own service and requires a write grant for any other service", async () => {
  const bag = { ...session, bag: "fixture" };
  await Barry.as(bag).service("fixture.api").restart();
  await expect(Barry.as(bag).service("other.api").restart()).rejects.toMatchObject({ reason: "forbidden" });
  await expect(Barry.as(session).service("fixture.api").restart()).rejects.toMatchObject({ reason: "forbidden" });
  const granted = vi.fn(async () => grants(true)); Barry.use(fakeSessions({ grants: granted }));
  await Barry.as(session).service("other.api").restart();
  expect(granted).toHaveBeenCalledWith("bux", "s1", session);
  await Barry.as(bag).service("other.api").restart();
});

it("refuses after a read-only bound removes the write tool", async () => {
  let allowed = true;
  Barry.use(fakeSessions({ grants: async () => grants(allowed) }));
  await Barry.as(session).service("fixture.api").restart(); allowed = false;
  await expect(Barry.as(session).service("fixture.api").restart()).rejects.toMatchObject({ reason: "forbidden" });
});

it("refuses self-restart with a terminal hint", async () => {
  vi.stubEnv("BARRY_SERVICE", "fixture.api");
  await expect(Barry.service("fixture.api").restart()).rejects.toMatchObject({ reason: "conflict", hint: "barry service restart fixture.api" });
  expect(os.unload).not.toHaveBeenCalled();
});

it("translates unknown, unregistered, system and external-process refusals", async () => {
  await expect(Barry.service("missing.api").get()).rejects.toMatchObject({ reason: "not_found" });
  await expect(Barry.service("missing.api").restart()).rejects.toMatchObject({ reason: "not_found" });
  await management.apply("fixture.api", "remove");
  await expect(Barry.service("fixture.api").restart()).rejects.toMatchObject({ reason: "conflict" });
  await expect(Barry.service("system.api").restart()).rejects.toMatchObject({ reason: "forbidden" });
  writeFileSync(join(home, "service-other.api.lock"), String(process.pid));
  await expect(Barry.service("other.api").restart()).rejects.toMatchObject({ reason: "conflict" });
});

it("propagates unexpected failures unchanged and reads prepared services for every call", async () => {
  const error = new Error("OS failure"); os.inspect = () => { throw error; };
  await expect(Barry.services()).rejects.toBe(error);
  management = new ServiceManagement(management.instance, [], os);
  expect(await Barry.services()).toEqual([]);
  expect(injected.management.mock.calls.length).toBeGreaterThan(1);
});

it.each(["start", "stop"] as const)("authorizes %s for every caller and grant state", async operation => {
  await Barry.service("fixture.api")[operation]();
  await expect(Barry.as(device).service("fixture.api")[operation]()).rejects.toMatchObject({ reason: "forbidden" });
  await Barry.as({ ...session, bag: "fixture" }).service("fixture.api")[operation]();
  await expect(Barry.as({ ...session, bag: "other" }).service("fixture.api")[operation]()).rejects.toMatchObject({ reason: "forbidden" });
  await expect(Barry.as(session).service("fixture.api")[operation]()).rejects.toMatchObject({ reason: "forbidden" });
  Barry.use(fakeSessions({ grants: async () => grants(true) }));
  await Barry.as(session).service("fixture.api")[operation]();
  await Barry.as({ ...session, bag: "other" }).service("fixture.api")[operation]();
  Barry.use(fakeSessions({ grants: async () => grants(false) }));
  await expect(Barry.as(session).service("fixture.api")[operation]()).rejects.toMatchObject({ reason: "forbidden" });
});
it("refuses self-stop while allowing an explicit self-start", async () => {
  vi.stubEnv("BARRY_SERVICE", "fixture.api");
  await expect(Barry.service("fixture.api").stop()).rejects.toMatchObject({ reason: "conflict" });
  await Barry.service("fixture.api").start();
});
