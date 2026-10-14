import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { managedServices, serviceRequest } from "./control.js";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import type { ServiceOS } from "./launchd.js";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

it("observes prepared services without configuring the application", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-service-observation-"));
  roots.push(root);
  const instance = openInstance(root);
  writeFileSync(join(root, "managed-definitions.json"), JSON.stringify([{
    name: "fixture.worker", command: [process.execPath], directory: root,
    domain: "gui/501", plistDirectory: root, logDirectory: root,
  }]));
  const os: ServiceOS = {
    inspect: vi.fn(() => ({ loaded: false })), load: vi.fn(),
    unload: vi.fn(async () => {}), enable: vi.fn(), start: vi.fn(),
  };
  writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: {} });
  const management = managedServices({ instance, os });
  const reply = await serviceRequest({ op: "status" }, { management });
  expect(reply.instance.id).toBe(instance.id);
  expect(reply.services).toMatchObject([{ key: "fixture.worker", state: "stopped" }]);
  expect(os.load).not.toHaveBeenCalled();
  expect(os.start).not.toHaveBeenCalled();
});

it("requires explicit application callbacks for reconfiguration", async () => {
  await expect(serviceRequest({ op: "reconcile" })).rejects.toThrow("requires an application");
  await expect(serviceRequest({ op: "move-port", service: "fixture.worker", port: 1234 })).rejects.toThrow("requires an application");
  const reconcile = vi.fn(async () => ({ started: ["fixture.worker"], stopped: [] }));
  expect(await serviceRequest({ op: "reconcile" }, { reconcile })).toEqual({ started: ["fixture.worker"], stopped: [] });
  expect(reconcile).toHaveBeenCalledOnce();
});

it("reports that an unregistered system service needs privileged setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-service-system-")); roots.push(root);
  const instance = openInstance(root);
  writeFileSync(join(root, "managed-definitions.json"), JSON.stringify([{ name: "vault.api", user: "_barryvault", domain: "system", command: [process.execPath], directory: root, plistDirectory: root, logDirectory: root }]));
  const refuse = () => { throw new Error("unexpected launchd change"); };
  const os: ServiceOS = { inspect: () => ({ loaded: false }), load: refuse, unload: async () => refuse(), enable: refuse, start: refuse };
  const result = await serviceRequest({ op: "status" }, { management: managedServices({ instance, os }) });
  expect(result.services[0].problem).toBe("needs `sudo barry setup --system`");
});

it("observes each definition once, and only the requested service for a keyed status", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-service-count-")); roots.push(root);
  const instance = openInstance(root);
  writeFileSync(join(root, "managed-definitions.json"), JSON.stringify(["fixture.a", "fixture.b"].map(name => ({ name, command: [process.execPath], directory: root, domain: "gui/501", plistDirectory: root, logDirectory: root }))));
  const os: ServiceOS = { inspect: vi.fn(() => ({ loaded: false })), load: vi.fn(), unload: vi.fn(async () => {}), enable: vi.fn(), start: vi.fn() };
  const management = managedServices({ instance, os });
  expect((await serviceRequest({ op: "status" }, { management })).services).toHaveLength(2);
  expect(os.inspect).toHaveBeenCalledTimes(2);
  vi.mocked(os.inspect).mockClear();
  os.observe = vi.fn(async () => ({ loaded: true, state: "waiting", runs: 4, lastExitCode: 7 }));
  const result = await serviceRequest({ op: "status", service: "fixture.b" }, { management });
  expect(result.services).toMatchObject([{ key: "fixture.b", state: "backoff", restarts: 3, kind: "service", system: false, lastExitCode: 7 }]);
  expect(os.observe).toHaveBeenCalledOnce(); expect(os.inspect).not.toHaveBeenCalled();
});
