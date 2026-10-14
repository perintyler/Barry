import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { copyRelease, pointCurrent } from "./current.js";
import { dispatchSkew } from "./skew.js";
import { fixtureRelease, repository, scratchEnvironment } from "./__tests__/release-home.js";
beforeEach(() => { scratchEnvironment(); vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { process.exitCode = 0; });
it("hands arguments and the child's exit code to current through the real wrapper", async () => {
  const a = fixtureRelease(), b = fixtureRelease("2.0.0", {}, "b".repeat(40)); pointCurrent(copyRelease(a.root, a.release));
  vi.stubEnv("FIXTURE_EXIT", "7");
  let output = "";
  const run: typeof spawnSync = vi.fn((program, args, options) => {
    const result = spawnSync(program, args, { ...options, stdio: "pipe" }); output = result.stdout.toString(); return result;
  });
  expect(await dispatchSkew({ root: b.root, args: ["service", "list", "space argument"], run })).toBe(true);
  expect(JSON.parse(output).args).toEqual(["service", "list", "space argument"]); expect(process.exitCode).toBe(7);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("this instance runs release 1.0.0"));
});
it.each([["upgrade"], ["upgrade", "--rollback"], ["uninstall"], ["--version"], ["-V"]])("keeps %j in the running release", async (...args) => {
  const a = fixtureRelease(), b = fixtureRelease("2.0.0", {}, "b".repeat(40)); pointCurrent(copyRelease(a.root, a.release));
  const run = vi.fn(); await dispatchSkew({ root: b.root, args, run }); expect(run).not.toHaveBeenCalled();
  if (["--version", "-V"].includes(args[0])) expect(console.log).toHaveBeenCalledWith("2.0.0");
});
it("keeps status JSON clean and reports skew structurally", async () => {
  const a = fixtureRelease(), b = fixtureRelease("2.0.0", {}, "b".repeat(40)); const activeRoot = copyRelease(a.root, a.release); pointCurrent(activeRoot);
  writeFileSync(join(activeRoot, "cli/bin/barry.js"), `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};register();const { releaseState } = await import(${JSON.stringify(join(repository, "cli/src/releases/state.ts"))});console.log(JSON.stringify({releases:releaseState()}));`);
  let output = "";
  const run: typeof spawnSync = (program, args, options) => { const result = spawnSync(program, args, { ...options, stdio: "pipe" }); output = result.stdout.toString(); return result; };
  await dispatchSkew({ root: b.root, args: ["status", "--json"], run });
  expect(console.log).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("barry upgrade switches"));
  expect(JSON.parse(output).releases.problems).toContainEqual(expect.stringContaining("this instance runs release 1.0.0"));
});
it("does not hand over checkout, missing-current or same-commit commands", async () => {
  const a = fixtureRelease(), run = vi.fn();
  expect(await dispatchSkew({ root: a.root, args: ["doctor"], run })).toBe(false);
  pointCurrent(copyRelease(a.root, a.release));
  expect(await dispatchSkew({ root: a.root, args: ["doctor"], run })).toBe(false);
  rmSync(join(a.root, "release.json"));
  expect(await dispatchSkew({ root: a.root, args: ["doctor"], run })).toBe(false); expect(run).not.toHaveBeenCalled();
});
it("passes the recorded linked Node to a checkout with no runtime", async () => {
  const a = fixtureRelease(), b = fixtureRelease("2.0.0", {}, "b".repeat(40));
  rmSync(join(a.root, "release.json")); rmSync(join(a.root, "runtime"), { recursive: true }); pointCurrent(a.root);
  vi.stubEnv("BARRY_NODE", process.execPath);
  let output = "";
  const run: typeof spawnSync = (program, args, options) => { const result = spawnSync(program, args, { ...options, stdio: "pipe" }); output = result.stdout.toString(); return result; };
  await dispatchSkew({ root: b.root, args: ["doctor"], run }); expect(JSON.parse(output).node).toBe(process.execPath);
});
it("forwards a child's signal", async () => {
  const a = fixtureRelease(), b = fixtureRelease("2.0.0", {}, "b".repeat(40)); pointCurrent(copyRelease(a.root, a.release));
  const run: typeof spawnSync = (program, args, options) => ({ ...spawnSync(program, args, { ...options, stdio: "pipe" }), status: null, signal: "SIGTERM" });
  const signal = vi.fn(); await dispatchSkew({ root: b.root, args: ["doctor"], run, signal }); expect(signal).toHaveBeenCalledWith("SIGTERM");
});
it("measures version startup through a fixture wrapper before main loads", async () => {
  const fixture = fixtureRelease(), cwd = fixture.root;
  const entry = join(cwd, "cli/bin/barry.js");
  writeFileSync(entry, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};register();const { dispatchSkew } = await import(${JSON.stringify(join(repository, "cli/src/releases/skew.ts"))});await dispatchSkew({root:${JSON.stringify(cwd)}});`);
  const invoke = () => {
    const start = performance.now();
    const result = spawnSync(join(cwd, "bin/barry"), ["--version"], { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, BARRY_HOME: process.env.BARRY_HOME } });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("1.0.0"); return performance.now() - start;
  };
  const without = invoke(); pointCurrent(copyRelease(cwd, fixture.release)); const withCurrent = invoke();
  process.stderr.write(`E3b fixture version startup: without current ${without.toFixed(1)} ms; with current ${withCurrent.toFixed(1)} ms\n`);
});
