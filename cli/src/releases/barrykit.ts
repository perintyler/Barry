import { spawnSync } from "node:child_process";
import { closeSync, constants, cpSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { run } from "./build.js";

export function barryKitCheckout(dir: string): { root: string; head: string } {
  const root = realpathSync(dir);
  if (run("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], root).trim() !== root) throw new Error("--barrykit must be the top of a git work tree");
  if (!/\bPackage\s*\(\s*name\s*:\s*"BarryKit"/.test(readFileSync(join(root, "Package.swift"), "utf8"))) throw new Error("--barrykit Package.swift must declare name: \"BarryKit\"");
  if (!existsSync(join(root, "Sources/openapi.yaml"))) throw new Error("--barrykit is missing Sources/openapi.yaml");
  if (run("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], root).trim()) throw new Error("--barrykit checkout is dirty; commit or revert its tracked changes first");
  return { root, head: run("git", ["--no-optional-locks", "rev-parse", "HEAD"], root).trim() };
}

export function cloneBarryKit(checkout: { root: string; head: string }): string {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "barry-barrykit-")));
  const kit = join(scratch, "BarryKit");
  try {
    run("git", ["clone", "--quiet", "--no-hardlinks", checkout.root, kit], scratch);
    run("git", ["checkout", "--quiet", "--detach", checkout.head], kit);
    // Build products hold absolute module-cache paths; only dependency state can move.
    for (const name of ["checkouts", "repositories", "artifacts", "workspace-state.json"]) {
      const source = join(checkout.root, ".build", name);
      if (existsSync(source)) cpSync(source, join(kit, ".build", name), { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    }
    return kit;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; BarryKit scratch kept at ${scratch}`);
  }
}

export function barryKitPatch(kit: string): string {
  const changes = run("git", ["status", "--porcelain", "--untracked-files=all"], kit).trimEnd().split("\n").filter(Boolean);
  const unexpected = changes.filter(line => !["Sources/openapi.yaml", "Tests/Fixtures/ag-ui.json"].includes(line.slice(3)));
  if (unexpected.length) throw new Error(`the generators wrote outside BarryKit's two generated files: ${unexpected.join("; ")}`);
  return run("git", ["diff", "--binary", "HEAD"], kit);
}

export function checkSwift(kit: string, log: string, runner = spawnSync): { ok: boolean; errors: string[] } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BARRY_")));
  const fd = openSync(log, "a");
  let ok = true;
  try {
    for (const command of ["build", "test"]) {
      console.log(`BarryKit: swift ${command}`);
      const result = runner("swift", [command, "--disable-automatic-resolution", "-j", "2"], { cwd: kit, env, stdio: ["ignore", fd, fd] });
      if (result.error || result.status !== 0) {
        if (result.error) writeFileSync(fd, `${result.error.message}\n`);
        ok = false;
        break;
      }
    }
  } finally { closeSync(fd); }
  const errors = [...new Set(readFileSync(log, "utf8").split("\n").filter(line => /^.+:\d+:\d+: error: /.test(line)).map(line => {
    const match = /^(.+?)(:\d+:\d+: error: .*)$/.exec(line)!;
    return `${isAbsolute(match[1]) ? relative(kit, match[1]) : match[1]}${match[2]}`;
  }))];
  return { ok, errors };
}

export function barryKitTag(version: string): string | undefined {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) && !/(?:-g[0-9a-f]{12}|-dirty|-dev)(?:$|-)/.test(version) ? `v${version}` : undefined;
}

export function o5Commands(checkout: { root: string; head: string }, patch: string, version: string, commit: string): string[] {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const git = `git -C ${quote(checkout.root)}`;
  const tag = barryKitTag(version);
  return [
    `${git} apply ${quote(patch)}`,
    `${git} commit -m ${quote(`Regenerate the spec for Barry ${version} (${commit.slice(0, 12)})`)} -- Sources/openapi.yaml Tests/Fixtures/ag-ui.json`,
    ...(tag ? [`${git} tag ${tag}`] : []),
  ];
}
