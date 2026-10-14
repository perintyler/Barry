import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { barryAppSupportDir, barryCurrentDir, installationPath, installationRoot } from "./home.mjs";
import { installedCommand, installedProgramPath, stableNodePath } from "./node-command.js";
import { hostEnvironment } from "./host-env.js";
let scratch: string;
const repo = resolve(import.meta.dirname, "../../..");
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "barry-installation-"));
  vi.stubEnv("BARRY_HOME", scratch);
  vi.stubEnv("BARRY_DIR", undefined);
  vi.stubEnv("BARRY_NODE", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });
function current(release = false): string {
  const target = join(scratch, "target");
  mkdirSync(target);
  if (release) {
    mkdirSync(join(target, "runtime/bin"), { recursive: true });
    symlinkSync(process.execPath, join(target, "runtime/bin/node"));
  }
  mkdirSync(barryAppSupportDir(), { recursive: true });
  symlinkSync(target, barryCurrentDir());
  return target;
}
it("ignores inherited roots, preserves its own alias and gives current precedence", () => {
  expect(installationRoot()).toBe(repo);
  vi.stubEnv("BARRY_DIR", scratch);
  expect(installationRoot()).toBe(repo);
  const alias = join(scratch, "alias");
  symlinkSync(repo, alias);
  vi.stubEnv("BARRY_DIR", alias);
  expect(installationRoot()).toBe(alias);
  current();
  expect(installationRoot()).toBe(barryCurrentDir());
  rmSync(join(scratch, "target"), { recursive: true });
  expect(installationRoot()).toBe(alias);
});
it("rewrites only paths inside the current target", () => {
  expect(installationPath(join(repo, "node_modules/x"))).toBe(join(repo, "node_modules/x"));
  const target = realpathSync(current());
  expect(installationPath(join(target, "node_modules/x"))).toBe(join(barryCurrentDir(), "node_modules/x"));
  expect(installationPath(join(scratch, "elsewhere"))).toBe(join(scratch, "elsewhere"));
  expect(installationPath(`${target}-other/x`)).toBe(`${target}-other/x`);
});
it("keeps today's node and commands without current", () => {
  const running = realpathSync(process.execPath);
  const candidate = (process.env.PATH ?? "").split(":").filter(Boolean).map(dir => join(dir, "node")).find(path => {
    try { return realpathSync(path) === running; } catch { return false; }
  });
  expect(stableNodePath()).toBe(candidate ?? process.execPath);
  for (const program of ["barry", "barry-service", "barry-hook"] as const) {
    const path = join(repo, "cli/bin", `${program}.js`);
    expect(installedProgramPath(program)).toBe(path);
    expect(installedCommand(program)).toEqual({ argv: [stableNodePath(), path], environment: {} });
  }
});
it("names the release runtime and all wrappers through current", () => {
  current(true);
  expect(stableNodePath()).toBe(join(barryCurrentDir(), "runtime/bin/node"));
  for (const program of ["barry", "barry-service", "barry-hook"] as const) {
    const path = join(barryCurrentDir(), "bin", program);
    expect(installedProgramPath(program)).toBe(path);
    expect(installedCommand(program)).toEqual({ argv: [path], environment: {} });
  }
});
it("carries a linked node to wrappers and names it in hook commands", () => {
  current();
  const node = join(scratch, "node");
  writeFileSync(node, "node");
  vi.stubEnv("BARRY_NODE", node);
  expect(stableNodePath()).toBe(node);
  for (const program of ["barry", "barry-service"] as const)
    expect(installedCommand(program)).toEqual({ argv: [join(barryCurrentDir(), "bin", program)], environment: { BARRY_NODE: node } });
  expect(installedCommand("barry-hook")).toEqual({ argv: [node, join(barryCurrentDir(), "cli/bin/barry-hook.js")], environment: {} });
  expect(hostEnvironment({ BARRY_NODE: node, BARRY_SECRET: "secret" })).toEqual({ BARRY_NODE: node });
});
