import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceStatus } from "@barry-rocks/mcp-bag";
import { Barry, type Service } from "@barry-rocks/sdk";
import { fakeServices } from "@barry-rocks/sdk/testing";
import { reconcileServices, resolveServiceNames, startCommand, stopCommand, serviceRestartCommand, restartManagedService } from "./service.js";

const controller = vi.hoisted(() => ({ refreshInstalledServices: vi.fn(), moveServicePort: vi.fn() }));
vi.mock("../services/barry.js", () => controller);
// These tests drive a mocked controller, so the host's launchd is irrelevant;
// the guard itself is covered by lib/platform.test.ts. Without this, every
// start/stop/restart case failed on Linux at the guard, before selecting.
vi.mock("../lib/platform.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/platform.js")>(),
  assertLaunchd: () => {},
}));

const local = vi.hoisted(() => ({ pool: [] as ServiceStatus[], request: vi.fn(), wait: vi.fn(), management: vi.fn() }));
vi.mock("@barry-rocks/mcp-bag", async importOriginal => {
  const actual = await importOriginal<typeof import("@barry-rocks/mcp-bag")>();
  local.request.mockImplementation(async (request: { op: string; service?: string }, options: unknown) => {
    if (request.op === "status") return { instance: { id: "fixture" }, services: local.pool };
    if (request.op === "start" || request.op === "stop") return { service: local.pool.find(s => s.key === request.service) };
    return actual.serviceRequest(request as Parameters<typeof actual.serviceRequest>[0], options as Parameters<typeof actual.serviceRequest>[1]);
  });
  return { ...actual, serviceRequest: local.request, managedServices: local.management, waitForServices: local.wait };
});
vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  readServiceRegistry: () => ({ resources: {} }),
  serviceAddress: vi.fn(),
}));

const status = (key: string): ServiceStatus => {
  const [bag, name] = key.split(".");
  return { key, bag, name, state: "running", registered: true, enabled: true, system: false, kind: "service", autostart: "login", restarts: 0, health: "ok", workingDirectory: "/x", argv: ["node"] };
};
const services = ["lists.web", "point-guard.web", "point-guard.point-guard", "sessions.api"].map(status);

describe("naming services on the command line", () => {
  it("takes a full name, a whole bag, or everything", () => {
    expect(resolveServiceNames(["lists.web"], services)).toEqual(["lists.web"]);
    expect(resolveServiceNames(["point-guard"], services)).toEqual(["point-guard.web", "point-guard.point-guard"]);
    expect(resolveServiceNames(["all"], services)).toHaveLength(4);
    expect(resolveServiceNames([], services)).toHaveLength(4);
  });

  it("names what matched nothing instead of quietly doing nothing", () => {
    expect(() => resolveServiceNames(["mcp.barry"], services)).toThrow(/no service or bag named "mcp.barry"/);
  });

  it("accepts the MCP server's old name for one release, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveServiceNames(["barry.mcp"], [...services, status("mcp.server")])).toEqual(["mcp.server"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"barry.mcp" is now "mcp.server"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("means the old service by its old name while it still exists", () => {
    expect(resolveServiceNames(["barry.mcp"], [...services, status("barry.mcp"), status("mcp.server")])).toEqual(["barry.mcp"]);
  });

  it("does not repeat a service named twice", () => {
    expect(resolveServiceNames(["lists", "lists.web"], services)).toEqual(["lists.web"]);
  });
});

describe("reconciling services after a bag change", () => {
  it("refreshes the installed declarations rather than reporting registration unavailable", async () => {
    controller.refreshInstalledServices.mockResolvedValue({ started: [], stopped: ["old.api"] });
    await expect(reconcileServices()).resolves.toEqual({ started: [], stopped: ["old.api"] });
    expect(controller.refreshInstalledServices).toHaveBeenCalledOnce();
  });
});

function domain(key: string): Service {
  const s = status(key);
  return { key, bag: s.bag, name: s.name, kind: "service", state: "running", registered: true, enabled: true, system: false, pid: null, port: null, address: null, health: "ok", restarts: 0, startedAt: null, lastExitCode: null, workingDirectory: "/x", loopbackOnly: null, conflict: null, problem: null };
}

describe("controlling selected services locally", () => {
  const restart = vi.fn(async (key: string) => domain(key));
  beforeEach(() => {
    vi.clearAllMocks(); local.wait.mockReset().mockResolvedValue(undefined);
    local.management.mockReturnValue({}); local.pool = services;
    restart.mockReset().mockImplementation(async key => domain(key));
    Barry.use(fakeServices({ start: restart, stop: restart, restart }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("CLI service control sent HTTP"); }));
    process.exitCode = 0;
  });
  afterEach(() => { Barry.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = 0; });

  it("refuses bare start, stop and restart before observing", async () => {
    for (const command of [startCommand, stopCommand, serviceRestartCommand])
      await expect(command([])).rejects.toThrow("name services or bags, or `all`");
    expect(local.request).not.toHaveBeenCalled();
  });

  it.each([
    ["start", startCommand, ["a.stopped"]],
    ["stop", stopCommand, ["a.running", "z.app", "mcp.server"]],
    ["restart", serviceRestartCommand, ["a.running", "mcp.server"]],
  ] as const)("%s all selects only safe services and puts MCP last", async (op, command, expected) => {
    local.pool = [status("mcp.server"), { ...status("z.app"), kind: "app" }, status("a.running"),
      { ...status("a.stopped"), state: "stopped" }, { ...status("system.api"), system: true },
      { ...status("disabled.api"), enabled: false }, { ...status("removed.api"), registered: false }];
    await command(["all"]);
    const keys = restart.mock.calls.map(([key]) => key);
    expect(keys).toEqual(expected);
    expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining(expected.join(", ")));
    if (op === "restart") expect(local.wait).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prints a dry-run expansion without restart or health calls", async () => {
    await serviceRestartCommand(["all"], { dryRun: true });
    expect(restart).not.toHaveBeenCalled(); expect(local.wait).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("  would restart lists.web");
  });

  it("stops restart all at the first unhealthy service and names the remaining ones", async () => {
    local.pool = [status("b.api"), status("mcp.server"), status("a.api")];
    local.wait.mockRejectedValueOnce(new Error("services did not become ready: a.api"));
    await serviceRestartCommand(["all"]);
    expect(restart.mock.calls.map(([key]) => key)).toEqual(["a.api"]);
    expect(local.wait).toHaveBeenCalledWith({}, ["a.api"], {}, 60_000);
    expect(console.log).toHaveBeenCalledWith("  not restarted: b.api, mcp.server");
    expect(process.exitCode).toBe(1);
  });

  it("restarts named services and install-triggered restarts through Barry without HTTP", async () => {
    await serviceRestartCommand(["lists"]);
    expect(await restartManagedService("mcp.server")).toBe(true);
    expect(restart.mock.calls.map(([key]) => key)).toEqual(["lists.web", "mcp.server"]);
    expect(local.request.mock.calls.every(([request]) => request.op === "status")).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(local.wait).not.toHaveBeenCalled();
  });
});
