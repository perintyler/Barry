import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseRoot } from "./release.js";

const names = ["barry", "barry-service", "barry-hook"];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "barry wrapper ")); roots.push(scratch);
  const root = join(scratch, "release");
  for (const path of ["bin", "cli/bin", "runtime/bin"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "identity.yaml"), "name: barry");
  for (const name of names) {
    copyFileSync(join(releaseRoot(), "bin", name), join(root, "bin", name));
    writeFileSync(join(root, "cli/bin", `${name}.js`), 'console.log(JSON.stringify({ root: process.env.BARRY_DIR, builtin: process.env.BARRY_BUILTIN_DIR, args: process.argv.slice(2) }));');
  }
  symlinkSync(process.execPath, join(root, "runtime/bin/node"));
  const invoke = (path = join(root, "bin/barry"), node?: string) => spawnSync(path, ["hello world", "a'b", "$literal"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", BARRY_DIR: "/wrong", BARRY_BUILTIN_DIR: "/wrong", ...(node ? { BARRY_NODE: node } : {}) } });
  return { root, scratch, invoke };
}
it("runs each wrapper directly with intact arguments and its own environment", () => {
  const { root, invoke } = fixture();
  for (const name of names) {
    const result = invoke(join(root, "bin", name));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ root, builtin: join(root, "bags"), args: ["hello world", "a'b", "$literal"] });
  }
});
it("keeps the logical current root", () => {
  const { root, scratch, invoke } = fixture();
  const current = join(scratch, "current"); symlinkSync(root, current);
  expect(JSON.parse(invoke(join(current, "bin/barry")).stdout).root).toBe(current);
});
it("follows Homebrew's two relative links to libexec", () => {
  const { root, scratch, invoke } = fixture();
  const keg = join(scratch, "Cellar/barry/0.10.0");
  mkdirSync(join(keg, "bin"), { recursive: true });
  symlinkSync(root, join(keg, "libexec"));
  symlinkSync("../libexec/bin/barry", join(keg, "bin/barry"));
  mkdirSync(join(scratch, "bin"));
  symlinkSync("../Cellar/barry/0.10.0/bin/barry", join(scratch, "bin/barry"));
  expect(JSON.parse(invoke(join(scratch, "bin/barry")).stdout).root).toBe(join(keg, "libexec"));
});
it("uses BARRY_NODE for a checkout and refuses when neither Node exists", () => {
  const { root, invoke } = fixture(); rmSync(join(root, "runtime"), { recursive: true });
  expect(invoke(undefined, process.execPath).status).toBe(0);
  expect(invoke().status).toBe(1);
  expect(invoke().stderr).toContain("no shipped runtime or BARRY_NODE");
});
it("refuses outside any Barry root", () => {
  const { root, scratch, invoke } = fixture();
  const outside = join(scratch, "outside/bin/barry"); mkdirSync(dirname(outside), { recursive: true });
  copyFileSync(join(root, "bin/barry"), outside);
  expect(invoke(outside).status).toBe(1);
  expect(invoke(outside).stderr).toBe("barry: cannot find a root with identity.yaml\n");
});
it("wrappers differ only in their entry", () => {
  const contents = names.map(name => readFileSync(join(releaseRoot(), "bin", name), "utf8").replace(`${name}.js`, "ENTRY.js"));
  expect(new Set(contents).size).toBe(1);
});
