import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "../services/runtime.js";
import { readRelease } from "./release.js";
import { checkLinks, releaseEnvironment, run, runProbe } from "./build.js";
import type { Probe } from "./probe.js";
import { linkCheckout } from "./current.js";

/** The pre-metadata build probe and the finished release use the same verdict. */
export function checkReleaseDirectory(root: string, probe: Probe): string[] {
  const problems: string[] = [];
  const check = (name: string, action: () => void) => {
    try { action(); } catch (error) { problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  check("links", () => checkLinks(root));
  for (const file of ["bin/barry", "runtime/bin/node"]) check(file, () => {
    if (!(statSync(join(root, file)).mode & 0o111)) throw new Error("must be executable");
  });
  for (const file of ["cli/dist/barry.js", "cli/dist/identity.js", "cli/dist/barry-hook.js", "cli/dist/build.json"]) check(file, () => { statSync(join(root, file)); });
  // buildRelease probes before writing metadata; validate it whenever present.
  if (existsSync(join(root, "release.json"))) check("release.json", () => {
    const release = readRelease(root)!;
    const bundle = JSON.parse(readFileSync(join(root, "cli/dist/build.json"), "utf8")) as { commit?: string };
    if (bundle.commit !== release.commit) throw new Error("CLI bundle commit differs from release metadata");
    if (!isDeepStrictEqual(release.node, probe.node)) throw new Error("runtime differs from release metadata");
    if (!isDeepStrictEqual(release.stores, probe.stores)) throw new Error("stores catalog differs from shipped migrations");
  });
  if (existsSync(join(root, "release.json"))) check("setup --link", () => {
    try { linkCheckout(root); } catch (error) {
      if (error instanceof Error && error.message.includes("is a release; barry upgrade installs releases")) return;
      throw error;
    }
    throw new Error("release was accepted as a linked checkout");
  });
  if (existsSync(join(root, "release.json"))) check("CLI version", () => {
    const release = readRelease(root)!;
    const home = mkdtempSync(join(tmpdir(), "barry-version-check-"));
    try {
      const options = { cwd: root, env: releaseEnvironment(root, home, true), encoding: "utf8" as const, timeout: 30_000 };
      const direct = execFileSync(join(root, "runtime/bin/node"), [join(root, "cli/bin/barry.js"), "--version"], options).trim();
      if (direct !== release.version) throw new Error("cli/bin/barry.js --version differs from release.json");
      const timed = spawnSync(join(root, "runtime/bin/node"), [join(root, "cli/bin/barry.js"), "--version"], { ...options, env: { ...options.env, BARRY_TIMING: "1" } });
      if (timed.status !== 0 || !timed.stderr.includes("entry: bundle")) throw new Error("CLI did not use its bundled entry");
      const wrapped = execFileSync(join(root, "bin/barry"), ["--version"], options).trim();
      if (wrapped !== release.version) throw new Error("bin/barry --version differs from release.json");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  return problems;
}

export async function checkRelease(tarball: string): Promise<void> {
  const started = performance.now();
  if (existsSync(`${tarball}.sha256`)) {
    const expected = readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256(readFileSync(tarball)) !== expected) throw new Error("tarball SHA-256 does not match sidecar");
  }
  const scratch = mkdtempSync(join(tmpdir(), "barry check "));
  try {
    const unpack = join(scratch, "unpack");
    mkdirSync(unpack);
    const paths = run("tar", ["-tzf", tarball], scratch).trim().split("\n");
    if (paths.some(path => path.startsWith("/") || path.split("/").includes(".."))) throw new Error("tarball has unsafe paths");
    if (new Set(paths.map(path => path.split("/")[0])).size !== 1) throw new Error("tarball must have one top-level directory");
    run("tar", ["-xzf", tarball, "-C", unpack], scratch);
    const roots = readdirSync(unpack, { withFileTypes: true });
    if (roots.length !== 1 || !roots[0].isDirectory()) throw new Error("tarball must have one top-level directory");
    const root = join(unpack, roots[0].name);
    checkLinks(root);
    const release = readRelease(root);
    if (!release) throw new Error("release.json is missing");
    console.log("release.json: ok (darwin-arm64)");
    const home = join(scratch, "home");
    mkdirSync(home);
    const env = releaseEnvironment(root, home, true);
    run("/usr/bin/codesign", ["--verify", "--strict", join(root, "runtime/bin/node")], scratch, env);
    console.log("Node signature: ok");
    const barry = (...args: string[]) => run(join(root, "bin/barry"), args, scratch, env);
    if (barry("--version").trim() !== release.version) throw new Error("barry --version differs from release.json");
    console.log("barry --version: ok");
    barry("--help");
    console.log("barry --help: ok");
    // A fresh home has no generated registry; prepare only its builtin view, without setup.
    run(join(root, "runtime/bin/node"), ["--input-type=module", "--eval", `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { loadBuiltinRegistry } from "@barry-rocks/sdk/internal/bags";
      import { getRegistrySnapshotPath } from "@barry-rocks/sdk/internal/bags";
      const path = getRegistrySnapshotPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ bags: loadBuiltinRegistry() }), { mode: 0o600 });
    `], join(root, "cli"), env);
    const bags = barry("bag", "list");
    const locals = bags.split("\n").filter(line => line.includes("local:"));
    for (const line of locals) {
      const path = line.slice(line.indexOf("local:") + 6).trim().replace(/ \([^)]+\)$/, "");
      if (!resolve(path).startsWith(`${join(root, "bags")}/`)) throw new Error("bag list has a local path outside release bags");
    }
    for (const name of ["mcp", "identities", "sessions"]) if (!locals.some(line => new RegExp(`\\b${name}\\b`).test(line))) throw new Error(`bag list is missing ${name}`);
    console.log("barry bag list: ok");
    const probe = runProbe(root, join(scratch, "probe-home"));
    if (!isDeepStrictEqual(probe.node, release.node) || !isDeepStrictEqual(probe.stores, release.stores)) throw new Error("probe metadata differs from release.json");
    console.log(`probe: ok (${Object.keys(probe.stores).length} stores)`);
    const versionTimes: number[] = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      if (barry("--version").trim() !== release.version) throw new Error("barry --version differs from release.json");
      versionTimes.push(performance.now() - start);
    }
    versionTimes.sort((a, b) => a - b);
    console.log(`CLI version median: ${versionTimes[2].toFixed(1)}ms`);
    if (versionTimes[2] > 1000) throw new Error("CLI version median exceeds 1 second");
    if (versionTimes[2] > 400) console.warn("CLI version median exceeds 400ms");
    const times: number[] = [];
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      if (run(join(root, "bin/barry-hook"), ["release-check", "PreToolUse"], scratch, env).trim() !== "{}") throw new Error("hook dispatcher did not return {}");
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    console.log(`hook dispatcher median: ${times[2].toFixed(1)}ms (${times.map(time => time.toFixed(1)).join(", ")})`);
    console.log(`check: ${((performance.now() - started) / 1000).toFixed(1)}s`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
