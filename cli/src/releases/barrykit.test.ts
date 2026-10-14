import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { barryKitCheckout, cloneBarryKit, barryKitPatch, checkSwift, barryKitTag, o5Commands } from "./barrykit.js";
import { main } from "./build.js";

const roots: string[] = [];
function scratch() { const root = realpathSync(mkdtempSync(join(tmpdir(), "barry-kit-test-"))); roots.push(root); return root; }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = scratch();
  const home = scratch();
  vi.stubEnv("HOME", home); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1"); vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["--no-optional-locks", "-c", "user.name=Release Test", "-c", "user.email=release@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  function file(path: string, content: string) { const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, content); }
  git("init", "-q");
  file("Package.swift", 'let package = Package(name: "BarryKit")');
  file("Sources/openapi.yaml", "old spec\n"); file("Tests/Fixtures/ag-ui.json", "[]\n"); file(".gitignore", ".build/\n");
  git("add", "Package.swift", "Sources/openapi.yaml", "Tests/Fixtures/ag-ui.json", ".gitignore"); git("commit", "-qm", "fixture");
  for (const path of ["checkouts/a/README", "repositories/r", "artifacts/a", "workspace-state.json", "plugins/cache/x"]) file(`.build/${path}`, path);
  return { root, git, file };
}
function hashes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else result[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex"); } }
  walk(root); return result;
}
function clone(root: string) { const kit = cloneBarryKit(barryKitCheckout(root)); roots.push(join(kit, "..")); return kit; }

it("accepts a clean checkout, including untracked files", () => {
  const repo = fixture();
  expect(barryKitCheckout(repo.root)).toEqual({ root: repo.root, head: repo.git("rev-parse", "HEAD") });
  repo.file("untracked", "ignored input"); expect(barryKitCheckout(repo.root).root).toBe(repo.root);
});
for (const staged of [false, true]) it(`refuses ${staged ? "staged" : "unstaged"} changes`, () => {
  const repo = fixture(); repo.file("Sources/openapi.yaml", "changed"); if (staged) repo.git("add", "Sources/openapi.yaml");
  expect(() => barryKitCheckout(repo.root)).toThrow("checkout is dirty");
});
it("refuses a nonrepository and a repository subfolder", () => {
  expect(() => barryKitCheckout(scratch())).toThrow(); const repo = fixture();
  expect(() => barryKitCheckout(join(repo.root, "Sources"))).toThrow("top of a git work tree");
});
it("refuses another Swift package or a missing spec", () => {
  const repo = fixture(); repo.file("Package.swift", 'let package = Package(name: "Other")');
  expect(() => barryKitCheckout(repo.root)).toThrow('name: "BarryKit"');
  repo.git("checkout", "--", "Package.swift"); repo.git("mv", "Sources/openapi.yaml", "Sources/old.yaml");
  expect(() => barryKitCheckout(repo.root)).toThrow("missing Sources/openapi.yaml");
});
it("clones HEAD and only portable dependency state without changing any source bytes", () => {
  const repo = fixture(); repo.file("untracked", "not cloned");
  // A stale index is what a plain `git status` would refresh and rewrite.
  utimesSync(join(repo.root, "Sources/openapi.yaml"), new Date(0), new Date(0));
  const status = repo.git("status", "--porcelain=v1", "--untracked-files=all"); const before = hashes(repo.root);
  const kit = clone(repo.root);
  expect(repo.git("-C", kit, "rev-parse", "HEAD")).toBe(repo.git("rev-parse", "HEAD"));
  for (const path of ["checkouts/a/README", "repositories/r", "artifacts/a", "workspace-state.json"]) expect(readFileSync(join(kit, ".build", path), "utf8")).toBe(path);
  expect(existsSync(join(kit, ".build/plugins"))).toBe(false); expect(existsSync(join(kit, "untracked"))).toBe(false);
  expect(repo.git("status", "--porcelain=v1", "--untracked-files=all")).toBe(status); expect(hashes(repo.root)).toEqual(before);
  expect(Object.keys(before).filter(path => path.startsWith(".git/objects/") && statSync(join(repo.root, path)).nlink > 1)).toEqual([]);
});
it("produces an applicable patch for precisely the generated files", () => {
  const repo = fixture(); const kit = clone(repo.root); expect(barryKitPatch(kit)).toBe("");
  writeFileSync(join(kit, "Sources/openapi.yaml"), "new spec\n"); writeFileSync(join(kit, "Tests/Fixtures/ag-ui.json"), "[1]\n");
  const patch = join(scratch(), "kit.patch"); writeFileSync(patch, barryKitPatch(kit));
  expect(() => repo.git("-C", clone(repo.root), "apply", "--check", patch)).not.toThrow();
  writeFileSync(join(kit, "Package.swift"), "unexpected"); expect(() => barryKitPatch(kit)).toThrow("outside BarryKit's two generated files");
});
it("refuses an untracked generator output outside the allowed files", () => {
  const kit = clone(fixture().root); writeFileSync(join(kit, "unexpected"), "output"); expect(() => barryKitPatch(kit)).toThrow("outside BarryKit's two generated files");
});
for (const failure of [undefined, "build", "test"]) it(`checks Swift with ${failure ?? "no"} failure`, () => {
  const kit = scratch(); const log = join(scratch(), "swift.log"); vi.stubEnv("BARRY_HOME", "must-not-inherit");
  const runner = vi.fn(spawnSync).mockImplementation((command, args, options) => {
    expect(command).toBe("swift"); expect(options?.cwd).toBe(kit); expect(options?.env?.BARRY_HOME).toBeUndefined();
    const fail = args?.[0] === failure;
    if (fail) appendFileSync(log, `${kit}/Sources/BarryKitTransport.swift:92:16: error: wrong type\n`.repeat(2));
    return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signal: null, status: fail ? 1 : 0 };
  });
  expect(checkSwift(kit, log, runner)).toEqual({ ok: failure === undefined, errors: failure ? ["Sources/BarryKitTransport.swift:92:16: error: wrong type"] : [] });
  expect(runner).toHaveBeenCalledTimes(failure === "build" ? 1 : 2);
});
it("prints tags only for release versions and quotes O5 paths", () => {
  expect(barryKitTag("0.10.0-beta.1")).toBe("v0.10.0-beta.1");
  for (const version of ["0.10.0-beta.1-4-g1a2b3c4d5e6f", "0.0.0-g1a2b3c4d5e6f", "0.10.0-dirty", "0.10.0-dev"]) expect(barryKitTag(version)).toBeUndefined();
  const checkout = { root: "/tmp/kit's path", head: "a".repeat(40) };
  const commands = o5Commands(checkout, "/tmp/kit.patch", "0.10.0-beta.1", "b".repeat(40));
  expect(commands).toHaveLength(3); expect(commands[0]).toContain("'\\''"); expect(commands[1]).toContain("bbbbbbbbbbbb");
  expect(o5Commands(checkout, "patch", "0.0.0-g1a2b3c4d5e6f", checkout.head)).toHaveLength(2);
});
it("rejects --check with --barrykit and a BarryKit without --ref", async () => {
  await expect(main(["--check", "tarball", "--barrykit", "kit"])).rejects.toThrow("usage:");
  await expect(main(["--barrykit", "kit"])).rejects.toThrow("usage:");
});
it("rejects dirty BarryKit before platform selection or starting an export", async () => {
  const repo = fixture(); repo.file("Sources/openapi.yaml", "dirty");
  const out = scratch();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    await expect(main(["--ref", "HEAD", "--out", out, "--barrykit", repo.root])).rejects.toThrow("checkout is dirty");
    expect(readdirSync(out)).toEqual([]);
    expect(readFileSync(join(repo.root, "Sources/openapi.yaml"), "utf8")).toBe("dirty");
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
