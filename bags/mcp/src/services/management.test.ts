import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, statSync, utimesSync, symlinkSync, mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement, ServiceRefusal, type ServiceDefinition } from "./management.js";
import type { JobState, ServiceOS } from "./launchd.js";
const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "barry-management-"));
  homes.push(home);
  const instance = openInstance(home);
  const definition: ServiceDefinition = {
    name: "fixture.api",
    directory: home,
    command: ["/usr/bin/true"],
    domain: "gui/501",
    plistDirectory: join(home, "plists"),
    logDirectory: join(home, "logs"),
  };
  let state: JobState = { loaded: false },
    fail = false;
  const calls: string[] = [];
  const os: ServiceOS = {
    inspect: () => ({ ...state }),
    load: (_domain, path) => {
      calls.push("load");
      if (fail) throw new Error("permission denied");
      expect(readFileSync(path, "utf8")).toContain(
        "<key>RunAtLoad</key><true/>",
      );
      state = { loaded: true, pid: 123 };
    },
    unload: async () => {
      calls.push("unload");
      state = { loaded: false };
    },
    enable: (_domain, _label, enabled) => {
      calls.push(`enable:${enabled}`);
    },
    start: () => {
      calls.push("start");
      state = { loaded: true, pid: 123 };
    },
  };
  return {
    home,
    definition,
    instance,
    calls,
    os,
    manager: new ServiceManagement(instance, [definition], os),
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}
describe("service registration, policy, and execution", () => {
  it("reports accumulated output without rotating an active job", async () => {
    const f = fixture();
    await f.manager.apply("fixture.api", "add");
    const path = join(f.definition.logDirectory, "fixture.api.out.log");
    writeFileSync(path, "x".repeat(10 * 1024 * 1024));
    expect((await f.manager.status("fixture.api")).logs).toEqual({ stdoutBytes: 10 * 1024 * 1024, stderrBytes: 0, rotationRecommended: true });
    expect(readFileSync(path).length).toBe(10 * 1024 * 1024);
  });
  it("add and enable are inert; manual execution preserves disabled policy", async () => {
    const f = fixture();
    await f.manager.apply("fixture.api", "add");
    expect(await f.manager.status("fixture.api")).toMatchObject({
      registered: true,
      enabled: false,
      loaded: false,
    });
    await f.manager.apply("fixture.api", "enable");
    expect(f.calls).not.toContain("load");
    await f.manager.apply("fixture.api", "disable");
    await f.manager.apply("fixture.api", "start");
    expect(await f.manager.status("fixture.api")).toMatchObject({
      enabled: false,
      pid: 123,
    });
    expect(f.calls.at(-1)).toBe("enable:false");
    expect(
      readFileSync(
        join(
          f.definition.plistDirectory,
          `${f.manager.label("fixture.api")}.plist`,
        ),
        "utf8",
      ),
    ).toContain("<key>RunAtLoad</key><false/>");
  });
  it("disable is policy-only; --now unloads; stop retains the next-login policy", async () => {
    const f = fixture();
    await f.manager.apply("fixture.api", "add");
    await f.manager.apply("fixture.api", "enable", { now: true });
    await f.manager.apply("fixture.api", "disable");
    expect((await f.manager.status("fixture.api")).pid).toBe(123);
    await f.manager.apply("fixture.api", "disable", { now: true });
    expect((await f.manager.status("fixture.api")).loaded).toBe(false);
    await f.manager.apply("fixture.api", "enable", { now: true });
    await f.manager.apply("fixture.api", "stop");
    expect(await f.manager.status("fixture.api")).toMatchObject({
      enabled: true,
      loaded: false,
    });
  });
  it("records incomplete intent, retries, and persists a removed choice across reopen", async () => {
    const f = fixture();
    await f.manager.apply("fixture.api", "add");
    f.fail();
    await expect(f.manager.apply("fixture.api", "start")).rejects.toThrow(
      "permission denied",
    );
    expect(f.manager.choice("fixture.api")).toMatchObject({
      pending: "start",
      enabled: false,
    });
    f.recover();
    await f.manager.apply("fixture.api", "start");
    await f.manager.apply("fixture.api", "remove");
    const reopened = new ServiceManagement(
      openInstance(f.home),
      [f.definition],
      f.os,
    );
    expect(reopened.hasChoice("fixture.api")).toBe(true);
    expect(reopened.choice("fixture.api")).toEqual({
      registered: false,
      enabled: false,
    });
    await expect(reopened.apply("fixture.api", "start")).rejects.toThrow(
      "not registered",
    );
  });
  it("isolates labels and validates declaration ownership", () => {
    const a = fixture(),
      b = fixture();
    expect(a.manager.label("fixture.api")).not.toBe(
      b.manager.label("fixture.api"),
    );
    expect(
      () =>
        new ServiceManagement(a.instance, [a.definition, a.definition], a.os),
    ).toThrow("duplicate");
  });
});

it("preserves the system domain, execution user and service-specific graceful stop budget", async () => {
  const f = fixture(),
    domains: string[] = [],
    budgets: number[] = [];
  const os: ServiceOS = {
    ...f.os,
    enable: (domain) => {
      domains.push(domain);
    },
    unload: async (domain, _label, budget) => {
      domains.push(domain);
      budgets.push(budget);
    },
  };
  const manager = new ServiceManagement(
    f.instance,
    [
      {
        ...f.definition,
        domain: "system",
        user: "daemon-fixture",
        shutdownMs: 40000,
      },
    ],
    os,
  );
  await manager.apply("fixture.api", "add");
  await manager.apply("fixture.api", "stop");
  expect(domains).toEqual(["system", "system"]);
  expect(budgets).toEqual([40000]);
  expect(
    readFileSync(
      join(
        f.definition.plistDirectory,
        `${manager.label("fixture.api")}.plist`,
      ),
      "utf8",
    ),
  ).toContain("<key>UserName</key><string>daemon-fixture</string>");
});

it("refuses every unprivileged system operation before recording intent or acquiring a lock", async () => {
  const f = fixture();
  const manager = new ServiceManagement(f.instance, [{ ...f.definition, domain: "system", user: "_fixture" }], { ...f.os, canControl: () => false });
  for (const op of ["add", "remove", "enable", "disable", "start", "stop", "restart"] as const)
    await expect(manager.apply("fixture.api", op)).rejects.toThrow("sudo barry setup --system");
  await expect(manager.apply("fixture.api", "restart")).rejects.toThrow("control it with `sudo barry service restart fixture.api`");
  await expect(manager.apply("fixture.api", "add")).rejects.not.toThrow("sudo barry service add");
  expect(existsSync(join(f.home, "services.json"))).toBe(false);
  expect(existsSync(join(f.home, "service-management.lock"))).toBe(false);
  expect(f.calls).toEqual([]);
});
it("observes system services whose logs cannot be read", async () => {
  const f = fixture(); mkdirSync(f.definition.logDirectory);
  writeFileSync(join(f.definition.logDirectory, "fixture.api.out.log"), "private output");
  chmodSync(f.definition.logDirectory, 0o000);
  try { expect((await f.manager.status("fixture.api")).logs).toEqual({ stdoutBytes: 0, stderrBytes: 0, rotationRecommended: false }); }
  finally { chmodSync(f.definition.logDirectory, 0o700); }
});

it("rotates small streams on restart and preserves their mode, while a cold start retains them", async () => {
  const f = fixture(); await f.manager.apply("fixture.api", "add");
  const paths = ["out", "err"].map(stream => join(f.definition.logDirectory, `fixture.api.${stream}.log`));
  for (const path of paths) { writeFileSync(path, "0123456789"); chmodSync(path, 0o640); }
  await f.manager.apply("fixture.api", "start");
  for (const path of paths) expect(existsSync(`${path}.1`)).toBe(false);
  await f.manager.apply("fixture.api", "restart");
  for (const path of paths) {
    expect(readFileSync(`${path}.1`, "utf8")).toBe("0123456789");
    expect(readFileSync(path, "utf8")).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o640);
  }
});

it("collects only old regular logs of undefined, unloaded services", async () => {
  const f = fixture(), root = join(f.home, "log-root"), dir = join(root, "fixture");
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const add = (name: string, recent = false) => {
    const path = join(dir, name); writeFileSync(path, "0123456789");
    if (!recent) utimesSync(path, old, old);
  };
  for (const name of ["removed.api.out.log", "removed.api.err.log.1", "api.out.log.2", "fixture.api.out.log", "loaded.api.err.log", "up.log", "app-watchdog.log"]) add(name);
  add("recent.api.out.log", true);
  mkdirSync(join(dir, "nested")); writeFileSync(join(dir, "nested", "removed.api.out.log"), "keep");
  symlinkSync(join(dir, "removed.api.out.log"), join(dir, "linked.api.out.log"));
  symlinkSync(dir, join(root, "linked-directory"));
  const inspect = vi.fn((_domain: string, label: string) => ({ loaded: label.endsWith(".loaded.api") }));
  const manager = new ServiceManagement(f.instance, [f.definition], { ...f.os, inspect });
  expect(await manager.collectLogs(root)).toEqual({ keys: ["api", "removed.api"], bytes: 30 });
  for (const name of ["fixture.api.out.log", "loaded.api.err.log", "recent.api.out.log", "up.log", "app-watchdog.log", "nested"]) expect(existsSync(join(dir, name))).toBe(true);
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(await manager.collectLogs(join(f.home, "missing"))).toEqual({ keys: [], bytes: 0 });
});

it("gives service-management refusals their domain reasons", async () => {
  const f = fixture();
  await expect(f.manager.apply("missing.api", "restart")).rejects.toMatchObject({ reason: "not_found" });
  await expect(f.manager.apply("fixture.api", "restart")).rejects.toMatchObject({ reason: "conflict" });
  const system = new ServiceManagement(f.instance, [{ ...f.definition, domain: "system" }], { ...f.os, canControl: () => false });
  await expect(system.apply("fixture.api", "restart")).rejects.toMatchObject({ reason: "forbidden" });
  writeFileSync(join(f.home, "service-fixture.api.lock"), String(process.pid));
  expect(() => f.manager.assertCanStart("fixture.api")).toThrow(ServiceRefusal);
  try { f.manager.assertCanStart("fixture.api"); } catch (error) { expect(error).toMatchObject({ reason: "conflict" }); }
});

it("observes at most six services concurrently", async () => {
  const f = fixture(); let active = 0, maximum = 0;
  const observe = vi.fn(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return { loaded: false };
  });
  const manager = new ServiceManagement(f.instance, Array.from({ length: 14 }, (_, i) => ({ ...f.definition, name: `fixture.worker${i}` })), { ...f.os, observe });
  expect(await manager.list()).toHaveLength(14);
  expect(observe).toHaveBeenCalledTimes(14); expect(maximum).toBe(6);
});
