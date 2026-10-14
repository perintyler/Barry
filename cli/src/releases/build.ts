import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { barryCacheDir } from "@barry-rocks/sdk/services";
import { downloadRuntime, nodeRuntime, NodePinSchema, runtimeTarball, sha256 } from "../services/runtime.js";
import { ReleaseSchema, releaseRoot, versionAt } from "./release.js";
import { checkRelease } from "./check.js";
import type { Probe } from "./probe.js";
import { barryKitCheckout, cloneBarryKit, barryKitPatch, checkSwift, o5Commands } from "./barrykit.js";

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`)}`);
  return result.stdout;
}

export function releaseEnvironment(root: string, home: string, check = false): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BARRY_")));
  return { ...env, BARRY_HOME: home, ...(check ? { HOME: home, BARRY_DIR: root, BARRY_BUILTIN_DIR: join(root, "bags") } : {}), PATH: check ? "/usr/bin:/bin" : `${join(root, "runtime/bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, npm_config_offline: "true" };
}

import { assertPlatform } from "../lib/platform.js";
export { assertPlatform };
export function assertOutputOutsideCheckout(out: string): void {
  let existing = resolve(out);
  while (!existsSync(existing)) existing = dirname(existing);
  existing = realpathSync(existing);
  if (!statSync(existing).isDirectory()) existing = dirname(existing);
  if (spawnSync("git", ["-C", existing, "rev-parse", "--show-toplevel"], { stdio: "ignore" }).status === 0) {
    throw new Error("--out must be outside every git work tree");
  }
}

function walk(root: string, visit: (path: string, directory: boolean) => boolean | void): void {
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (visit(path, item.isDirectory()) !== false && item.isDirectory()) walk(path, visit);
  }
}
// Pinned third-party bytes: dependency trees (the lockfile's integrity hashes) and the root's
// runtime/ (nodejs.org's, by digest). Only the root's: a package may name a folder runtime.
function thirdParty(root: string, path: string): boolean {
  return basename(path) === "node_modules" || path === join(root, "runtime");
}
export function removeDevelopmentFiles(root: string): void {
  for (const name of [".github", ".changeset", "vitest.base.config.ts", "vitest.instance-home.setup.ts", "eslint.config.js", "node_modules/.cache"]) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
  walk(root, (path, directory) => {
    const name = basename(path);
    if (thirdParty(root, path)) return false;
    const remove = directory
      ? ["__tests__", "__fixtures__", "__golden__", "fixtures"].includes(name) || (name === "test" && existsSync(join(dirname(path), "package.json")))
      : /(?:\.test\.(?:ts|mts|js|mjs)|\.test-d\.ts|\.spec\.ts)$/.test(name) || /^vitest(?:\..+)?\.ts$/.test(name);
    if (remove) { rmSync(path, { recursive: true, force: true }); return false; }
  });
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
export function checkLinks(root: string): void {
  walk(root, (path) => {
    if (!lstatSync(path).isSymbolicLink()) return;
    const target = readlinkSync(path);
    if (isAbsolute(target) || !inside(root, resolve(dirname(path), target)) || !inside(realpathSync(root), realpathSync(path))) {
      throw new Error(`release link escapes its root: ${relative(root, path)}`);
    }
  });
}

// Patterns from barry-devops/checks/credential-audit.mjs. Findings never print key material.
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?[A-Za-z0-9+/]{40}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
];
export function scanSecrets(root: string): string[] {
  const findings: string[] = [];
  walk(root, (path, directory) => {
    if (directory && thirdParty(root, path)) return false;
    if (!lstatSync(path).isFile()) return;
    const content = readFileSync(path, "utf8");
    for (const pattern of SECRET_PATTERNS) if (pattern.test(content)) findings.push(`${relative(root, path)}: matches ${pattern.source}`);
  });
  return findings;
}
export function renderFormula(template: string, tarball: string, digest: string, version: string): string {
  const formula = template.replaceAll("@@URL@@", pathToFileURL(tarball).href).replaceAll("@@SHA256@@", digest).replaceAll("@@VERSION@@", version);
  if (formula.includes("@@")) throw new Error("formula has an unfilled placeholder");
  return formula;
}
export function runProbe(root: string, home: string): Probe {
  mkdirSync(home, { recursive: true });
  const report = JSON.parse(run(join(root, "runtime/bin/node"), ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "cli/scripts/release-check.ts")], root, releaseEnvironment(root, home, true))) as Probe;
  if (!Array.isArray(report.problems) || report.problems.length) throw new Error(`release probe: ${report.problems?.join("; ") ?? "invalid report"}`);
  return report;
}
async function exportCommit(repo: string, commit: string, root: string): Promise<void> {
  await new Promise<void>((done, fail) => {
    const archive = spawn("git", ["-C", repo, "archive", "--format=tar", commit], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", root], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(tar.stdin);
    let errors = "";
    archive.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    tar.stderr.on("data", (data: Buffer) => { errors += data.toString(); });
    archive.on("error", fail); tar.on("error", fail);
    tar.stdin.on("error", fail);
    const closed = (child: ChildProcess) => new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
    void Promise.all([closed(archive), closed(tar)]).then((codes) => codes.every(code => code === 0) ? done() : fail(new Error(`git archive: ${errors.trim()}`)));
  });
}
async function buildRelease(ref: string, out: string, checkout?: ReturnType<typeof barryKitCheckout>): Promise<void> {
  assertOutputOutsideCheckout(out);
  const kit = checkout === undefined ? undefined : cloneBarryKit(checkout);
  let patch = "";
  let scratch: string | undefined;
  let cleaned = false;
  try {
    const repo = releaseRoot();
    const commit = run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("ref did not resolve to one commit");
    const version = versionAt(repo, commit, ref);
    const name = `barry-${version}-darwin-arm64`;
    scratch = mkdtempSync(join(tmpdir(), "barry-build-"));
    const root = join(scratch, name);
    const started = performance.now();
    mkdirSync(root);
    await exportCommit(repo, commit, root);
    for (const file of ["identity.yaml", "bin/barry", "cli/scripts/release-check.ts", "cli/src/services/node-runtime.json"]) {
      if (!existsSync(join(root, file))) throw new Error(`${ref} predates releases: missing ${file}`);
    }
    const pin = NodePinSchema.parse(JSON.parse(readFileSync(join(root, "cli/src/services/node-runtime.json"), "utf8")));
    const runtime = nodeRuntime("arm64", pin);
    await downloadRuntime(undefined, runtime);
    mkdirSync(join(root, "runtime"));
    const tarball = join(root, "runtime", `${runtime.name}.tar.gz`);
    copyFileSync(runtimeTarball(runtime), tarball);
    if (sha256(readFileSync(tarball)) !== runtime.sha256) throw new Error("copied runtime does not match its pinned SHA-256");
    run("tar", ["-xzf", tarball, "--strip-components=1", "-C", join(root, "runtime"), `${runtime.name}/bin/node`, `${runtime.name}/LICENSE`], root);
    if (run(join(root, "runtime/bin/node"), ["--version"], root).trim() !== `v${runtime.version}`) throw new Error("shipped Node version differs from its pin");
    const home = join(scratch, "home");
    mkdirSync(home);
    const env = releaseEnvironment(root, home);
    const pnpm = (args: string[], extra: NodeJS.ProcessEnv = {}) => { console.log(`pnpm ${args.join(" ")}`); return run("/usr/bin/sandbox-exec", ["-p", '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))(allow network-outbound (remote ip "localhost:*"))', "pnpm", ...args], root, { ...env, ...extra }); };
    try {
      pnpm(["install", "--frozen-lockfile", "--offline"]);
      pnpm(["build:packages"]);
      pnpm(["--filter", "@barry-rocks/vault-bag", "build"]);
      pnpm(["stores:check"]);
      if (kit) {
        try { pnpm(["contracts:check"], { BARRY_KIT_DIR: join(scratch, "no-barrykit") }); }
        catch { throw new Error(`${ref}'s generated contracts are stale; run \`pnpm contracts:generate\` at ${ref}`); }
        pnpm(["contracts:generate"], { BARRY_KIT_DIR: kit });
        patch = barryKitPatch(kit);
      }
      pnpm(["install", "--prod", "--frozen-lockfile", "--offline"]);
    } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; run pnpm install in a checkout at ${ref}`); }
    if (!existsSync(join(root, "node_modules/tsx")) || existsSync(join(root, "node_modules/typescript")) || existsSync(join(root, "node_modules/vitest"))) throw new Error("production install did not prune development dependencies");
    removeDevelopmentFiles(root);
    checkLinks(root);
    const findings = scanSecrets(root);
    if (findings.length) throw new Error(`secret scan: ${findings.join("; ")}`);
    const probe = runProbe(root, join(scratch, "probe-home"));
    const release = ReleaseSchema.parse({ version, commit, platform: "darwin-arm64", node: { version: runtime.version, sha256: runtime.sha256 }, stores: probe.stores, built: new Date().toISOString() });
    if (!isDeepStrictEqual(release.node, probe.node)) throw new Error("probe Node differs from release pin");
    writeFileSync(join(root, "cli/version.json"), `${JSON.stringify({ version: release.version })}\n`);
    writeFileSync(join(root, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const output = join(out, `${name}.tar.gz`);
    if (existsSync(output)) throw new Error(`immutable release already exists: ${output}`);
    const temporary = `${output}.${process.pid}.tmp`;
    run("tar", ["--no-mac-metadata", "--no-xattrs", "-czf", temporary, "-C", scratch, name], root, { ...env, COPYFILE_DISABLE: "1" });
    const digest = sha256(readFileSync(temporary));
    renameSync(temporary, output);
    writeFileSync(`${output}.sha256`, `${digest}  ${name}.tar.gz\n`);
    const formula = join(out, "barry.rb");
    writeFileSync(formula, renderFormula(readFileSync(join(root, "cli/scripts/homebrew/barry.rb"), "utf8"), output, digest, version));
    rmSync(scratch, { recursive: true, force: true });
    cleaned = true;
    await checkRelease(output);
    console.log(`${output}\n${statSync(output).size} bytes; SHA-256 ${digest}\nversion ${version}; commit ${commit}\nformula ${formula}\nbuild and check ${((performance.now() - started) / 1000).toFixed(1)}s`);
    if (kit && checkout) {
      if (!patch) {
        rmSync(dirname(kit), { recursive: true, force: true });
        console.log(`BarryKit at ${checkout.head.slice(0, 12)} already matches release ${version}.`);
      } else {
        const patchPath = join(out, `barrykit-${version}.patch`);
        writeFileSync(patchPath, patch);
        const log = join(dirname(kit), "swift.log");
        const swift = checkSwift(kit, log);
        if (!swift.ok) {
          for (const error of swift.errors) console.error(error);
          throw new Error(`Release ${version} is built at ${output}; BarryKit does not build against it. Patch: ${patchPath}; kit kept at ${kit}; log ${log}. Its Swift needs changes before the patch lands (O5).`);
        }
        rmSync(dirname(kit), { recursive: true, force: true });
        console.log(`${patchPath}\nBarryKit builds and passes its tests against release ${version}.\n${o5Commands(checkout, patchPath, version, commit).join("\n")}`);
      }
    }
  } catch (error) {
    if (scratch && !cleaned) console.error(`build scratch kept at ${scratch}`);
    if (kit && existsSync(kit)) console.error(`BarryKit scratch kept at ${kit}`);
    throw error;
  }
}
export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { ref: { type: "string" }, out: { type: "string" }, check: { type: "string" }, barrykit: { type: "string" } } });
  if (values.check && !values.ref && !values.out && !values.barrykit) { await checkRelease(resolve(values.check)); return; }
  if (!values.ref || values.check) throw new Error("usage: release.mjs --ref <tag|commit> [--out <dir>] [--barrykit <BarryKit checkout>] | --check <tarball>");
  // Validate requested input without mutating it, even on a host that cannot
  // build releases. Cloning/exporting still requires the supported platform.
  const checkout = values.barrykit === undefined ? undefined : barryKitCheckout(values.barrykit);
  assertPlatform();
  await buildRelease(values.ref, resolve(values.out ?? join(barryCacheDir(), "release-builds")), checkout);
}
