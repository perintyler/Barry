/** Build bag-owned GUI bundles with declared package scripts or Xcode projects. */

import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, resolve, sep, dirname } from "path";
import { spawn } from "child_process";
import { z } from "zod";
import { hostEnvironment } from "@barry-rocks/sdk/services";
import { loadAllBags, loadRegistry } from "@barry-rocks/sdk/internal/bags";

import type { BagApp } from "@barry-rocks/sdk/bags";

/** An app resolved against the bag that declares it. */
export interface DiscoveredBagApp {
  bag: string;
  name: string;
  app: BagApp;
  /** Absolute path to the bag directory. */
  bagDir: string;
  /** Absolute path to the bundle the build should produce. */
  outputPath: string;
}

export interface BagAppBuildResult {
  bag: string;
  name: string;
  ok: boolean;
  /** Populated when ok is false. */
  error?: string;
}

function isInside(dir: string, target: string): boolean {
  return target === dir || target.startsWith(dir + sep);
}

/**
 * Resolve an app's output path, refusing anything outside the bag.
 *
 * Unlike a launchd command — where an absolute path names a host binary on
 * purpose — an absolute output has no legitimate use: the bundle is a build
 * artifact of this bag. Allowing one would let a manifest point the installer
 * at an arbitrary .app and have it installed, and with `login-item` set, run at
 * every login.
 */
export function resolveAppOutput(bagDir: string, output: string): string | null {
  if (isAbsolute(output)) return null;
  const dir = resolve(bagDir);
  const abs = resolve(dir, output);
  if (!isInside(dir, abs)) return null;
  if (existsSync(dir)) {
    let ancestor = abs;
    while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
    if (!isInside(realpathSync(dir), realpathSync(ancestor))) return null;
  }
  return abs;
}

/**
 * Every app declared by a local bag.
 *
 * Remote bags are skipped: there is no directory to build in, and running a
 * build command on behalf of a bag fetched over the network would execute
 * arbitrary code at install time.
 */
export async function discoverBagApps(): Promise<DiscoveredBagApp[]> {
  const registry = loadRegistry();
  const bags = await loadAllBags();
  const discovered: DiscoveredBagApp[] = [];

  for (const bag of bags) {
    const source = registry[bag.name];
    if (!source || source.type !== "local") continue;
    const bagDir = resolve(source.path.replace(/^~/, process.env.HOME || ""));

    for (const app of bag.apps ?? []) {
      // ios apps are built by `barry ios build`, not by the installer: there
      // is no bundle for this host to copy anywhere.
      if (app.platform !== "macos" || !app.build) continue;
      const outputPath = resolveAppOutput(bagDir, app.output);
      if (!outputPath) continue;
      discovered.push({ bag: bag.name, name: app.name, app, bagDir, outputPath });
    }
  }

  return discovered;
}

/** Discover iOS builds separately from the host installer. */
export async function discoverIosBagApps(): Promise<Omit<DiscoveredBagApp, "outputPath">[]> {
  const registry = loadRegistry();
  const bags = await loadAllBags();
  const discovered: Omit<DiscoveredBagApp, "outputPath">[] = [];

  for (const bag of bags) {
    const source = registry[bag.name];
    if (!source || source.type !== "local") continue;
    const bagDir = resolve(source.path.replace(/^~/, process.env.HOME || ""));

    for (const app of bag.apps ?? []) {
      if (app.platform !== "ios") continue;
      discovered.push({ bag: bag.name, name: app.name, app, bagDir });
    }
  }

  return discovered;
}

/**
 * Whether a path is a bundle of the shape the declared platform produces.
 *
 * The two layouts are different, not merely similar: a macOS bundle nests its
 * Info.plist under Contents/, an iOS one keeps it at the root. Checking only
 * for "an Info.plist somewhere" would accept each platform's bundle as the
 * other's, which is exactly the confusion this function exists to catch — an
 * iOS build copied into /Applications is not a launchable app.
 */
export function isValidAppBundle(bundlePath: string, platform: BagApp["platform"] = "macos"): boolean {
  if (!existsSync(bundlePath) || !statSync(bundlePath).isDirectory()) return false;
  const nested = existsSync(join(bundlePath, "Contents", "Info.plist"));
  return platform === "ios" ? !nested && existsSync(join(bundlePath, "Info.plist")) : nested;
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(command, args, { cwd, env: hostEnvironment(), stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });
    proc.on("error", (err) => resolvePromise({ code: 1, stderr: err.message }));
    proc.on("close", (code) => resolvePromise({ code: code ?? 1, stderr }));
  });
}

/** A declared package manager executes an existing script as argv, never a shell command. */
export function resolveAppBuild(app: BagApp, bagDir: string, outputPath: string): { command: string; args: string[] } {
  if (typeof app.build === "string") {
    let contents: unknown;
    try {
      contents = JSON.parse(readFileSync(join(bagDir, "package.json"), "utf8"));
    } catch {
      throw new Error("app build package.json is unreadable or invalid");
    }
    const metadata = z.object({ packageManager: z.string().regex(/^(npm|pnpm|yarn|bun)@[^\s]+$/),
      scripts: z.record(z.string(), z.string()),
    }).safeParse(contents);
    if (!metadata.success) throw new Error("app build requires supported packageManager and scripts declarations in package.json");
    const manifest = metadata.data;
    const manager = manifest.packageManager.slice(0, manifest.packageManager.indexOf("@"));
    if (!Object.hasOwn(manifest.scripts ?? {}, app.build) || typeof manifest.scripts?.[app.build] !== "string") {
      throw new Error(`app build script ${app.build} is not declared in package.json`);
    }
    return { command: manager, args: ["run", app.build] };
  }
  const project = resolveAppOutput(bagDir, app.build.project);
  if (!project || !existsSync(project)) throw new Error("app build project is unavailable inside the bag");
  return { command: "xcodebuild", args: ["-project", project, "-scheme", app.build.scheme,
    "-configuration", app.build.configuration, "-derivedDataPath", join(bagDir, ".build-barry-app", createHash("sha256").update(app.output).digest("hex").slice(0, 16)),
    `CONFIGURATION_BUILD_DIR=${dirname(outputPath)}`, "build",
  ] };
}

/**
 * Build an app and verify its declared bundle exists, even after a zero exit.
 * See docs/decisions/0036-cli-launch-and-persistence-rationale.md.
 */
export async function buildBagApp(target: DiscoveredBagApp): Promise<BagAppBuildResult> {
  const { bag, name, app, bagDir, outputPath } = target;
  const base = { bag, name };

  if (resolveAppOutput(bagDir, app.output) !== outputPath) return { ...base, ok: false, error: "app output is not the declared bag-owned path" };

  let invocation: { command: string; args: string[] };
  try {
    invocation = resolveAppBuild(app, bagDir, outputPath);
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const { code, stderr } = await run(invocation.command, invocation.args, bagDir);
  if (code !== 0) {
    return { ...base, ok: false, error: `build exited ${code}${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}` };
  }

  if (!existsSync(outputPath)) {
    return { ...base, ok: false, error: `build succeeded but produced no bundle at ${app.output}` };
  }
  if (!isValidAppBundle(outputPath, app.platform)) {
    const expected = app.platform === "ios" ? "Info.plist" : "Contents/Info.plist";
    return { ...base, ok: false, error: `${app.output} is not a ${app.platform} app bundle (no ${expected})` };
  }

  return { ...base, ok: true };
}

/** Build every declared app, or the named subset. */
export async function buildBagApps(opts: { only?: string[] } = {}): Promise<BagAppBuildResult[]> {
  const apps = await discoverBagApps();
  const selected = opts.only?.length
    ? apps.filter((a) => opts.only!.includes(a.bag) || opts.only!.includes(a.name))
    : apps;

  const results: BagAppBuildResult[] = [];
  for (const app of selected) {
    results.push(await buildBagApp(app));
  }
  return results;
}
