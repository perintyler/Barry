import { loadModelProviders, shippedModelProviders } from "@barry-rocks/sdk/adapters/models";
import { adapterStore } from "../adapters/installed.js";
import { selectShippedSessionAdapters } from "../adapters/setup.js";
import { barryModelProvidersPath, readServiceRegistry, barryAppSupportDir, barryCacheDir, barryConfigDir, barryLogsDir, ensureInstanceSecret, barryCurrentDir, installationRoot } from "@barry-rocks/sdk/services";
import { isSystemService, setupSystem, systemNeeds, systemOS, type SystemOS } from "../services/system.js";
import { downloadRuntime, nodeRuntime, type Download } from "../services/runtime.js";
import type { ServiceSpec } from "../services/specs.js";
import { waitForServices } from "@barry-rocks/mcp-bag";

/** Install an instance using the same service operations as the CLI. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { installedCommand, installedProgramPath, shellWord, stableNodePath } from "@barry-rocks/sdk/internal/services";
import {
  buildBagApp,
  discoverBagApps,
  isValidAppBundle,
} from "../apps/app-build.js";

import { serviceOS, ServiceRefusal, type ServiceOS } from "@barry-rocks/mcp-bag";
import { installedServices } from "../services/barry.js";

import { currentInstallation, copyRelease, linkCheckout, pointCurrent } from "../releases/current.js";
import { readRelease, releaseRoot } from "../releases/release.js";
import { bold } from "../lib/ansi.js";
import { cliShimDir, isHomebrewBarry, legacyCliShimDirs, onPath, pathHint, removeShim } from "../lib/identity-shims.js";

function step(message: string): void {
  console.log(`\n${bold(message)}`);
}

function writeShim(root: string): string {
  const dir = cliShimDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "barry");
  if (isHomebrewBarry(target)) {
    console.log(`Homebrew's barry is in place at ${target}.`);
    return target;
  }
  const entry = join(root, "cli", "bin", "barry.js");
  const command = installedCommand("barry");
  writeFileSync(
    target,
    existsSync(barryCurrentDir()) ? `#!/bin/sh
# The barry CLI, installed by \`barry setup\`: it runs what ${barryCurrentDir()} points at.
${Object.entries(command.environment).map(([name, value]) => `export ${name}=${shellWord(value)}\n`).join("")}exec ${command.argv.map(shellWord).join(" ")} "$@"
` : `#!/bin/sh
# The barry CLI, installed by \`barry setup\` from ${root}.
# Pinned to the node that ran setup; rerun setup after moving the checkout.
export BARRY_DIR='${root.replace(/'/g, `'\\''`)}'
exec ${shellWord(stableNodePath())} ${shellWord(entry)} "$@"
`,
  );
  chmodSync(target, 0o755);
  // Migrate off an old location: a shim this instance wrote under a previous
  // release (e.g. the Homebrew prefix) is removed, and both paths are printed
  // so a stale copy earlier on PATH does not silently win.
  for (const old of legacyCliShimDirs()) {
    const oldShim = join(old, "barry");
    if (isHomebrewBarry(oldShim)) continue;
    if (removeShim("barry", old)) {
      console.log(`Moved the barry command: removed ${oldShim}, wrote ${target}.`);
    }
  }
  if (!onPath(dir)) console.warn(`\n${pathHint(dir)}`);
  return target;
}


/** A bundle's identity: its executable and Info.plist, which change with every build that matters. */
function bundleDigest(bundle: string, name: string): string | null {
  const hash = createHash("sha256");
  for (const part of [
    join("Contents", "MacOS", name),
    join("Contents", "Info.plist"),
  ]) {
    try {
      hash.update(readFileSync(join(bundle, part)));
    } catch {
      return null;
    }
  }
  return hash.digest("hex");
}

/**
 * Copy a built app bundle into the instance when it differs from the one
 * installed, staging beside it and swapping. The copy it replaces is kept as
 * the one previous version. Answers where it is and whether it was replaced.
 */
function installBundle(
  source: string,
  name: string,
): { path: string; replaced: boolean } {
  const dir = join(barryAppSupportDir(), "apps");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${name}.app`);
  if (
    existsSync(target) &&
    bundleDigest(target, name) === bundleDigest(source, name)
  ) {
    return { path: target, replaced: false };
  }
  const staged = join(dir, `.${name}.app.staging`);
  rmSync(staged, { recursive: true, force: true });
  cpSync(source, staged, { recursive: true });
  const previous = join(dir, `.${name}.app.previous`);
  if (existsSync(target)) {
    rmSync(previous, { recursive: true, force: true });
    renameSync(target, previous);
  }
  renameSync(staged, target);
  return { path: target, replaced: true };
}

export interface SetupOptions {
  link?: string;
  /** Release source directory; the running code tree by default. */
  releaseRoot?: string;
  uninstall?: boolean;
  purge?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  system?: boolean;
  start?: boolean;
  apps?: string[];
  owner?: string;
  launchd?: ServiceOS;
  systemOS?: SystemOS;
  /** How the system services' Node tarball is fetched; tests never reach the network. */
  download?: Download;
}
export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  if (options.link !== undefined && (options.system || options.uninstall || options.dryRun)) throw new Error("--link cannot be combined with --system, --uninstall or --dry-run");
  if (options.owner !== undefined && (!/^[1-9]\d*$/.test(options.owner) || !Number.isSafeInteger(Number(options.owner)))) throw new Error("Owner must be a positive user actor ID");
  if (options.uninstall) {
    if (options.owner !== undefined) throw new Error("Owner selection cannot be combined with uninstall");
    const { uninstallCommand } = await import("./uninstall.js");
    await uninstallCommand({
      purge: options.purge,
      dryRun: options.dryRun,
      yes: options.yes,
      system: options.system,
      launchd: options.launchd,
    });
    return;
  }
  const os = options.launchd ?? serviceOS();
  if (options.system) {
    if (options.start === false || options.owner !== undefined || options.apps?.length) throw new Error("--system cannot be combined with --no-start, --owner or --app");
    await setupSystem(barryAppSupportDir(), os, options.systemOS ?? systemOS(), { dryRun: options.dryRun });
    return;
  }
  if (process.getuid?.() === 0) throw new Error("run barry setup as the instance owner: services run as the login user and launchd registrations belong to that user's domain; use --system for the privileged pass. A container's default user is often root");
  // The normal pass starts services unless --no-start; without launchd it
  // cannot, so refuse up front with the one sentence rather than part-way
  // through. --no-start (and the read-only dry-run) stay usable on Linux. A
  // caller that passes its own service OS has chosen what controls services,
  // so the host's launchd is not the question: an inert one refuses startup
  // with its own `unsupported` reason, which is what the install verifier
  // asserts on Linux.
  if (options.start !== false && !options.dryRun && !options.launchd) {
    const { assertLaunchd } = await import("../lib/platform.js");
    assertLaunchd();
  }
  const before = currentInstallation();
  if (options.dryRun) {
    // The normal pass's dry-run is read-only: resolve nothing that would
    // write. Report the installation it would set up from and the steps it
    // would take, then change nothing.
    console.log("barry setup --dry-run (normal pass): nothing will change.");
    console.log(
      before.kind === "missing"
        ? `  current points at ${before.target}, which does not exist — setup would refuse without --link`
        : before.current
          ? `  would set up from ${before.target} (${before.kind === "release" ? `release ${before.version}` : before.kind})`
          : `  current is not set up — setup would copy the release at ${before.target} into place`,
    );
    console.log("  would: bind the installation owner, create app-support/cache/logs/config directories,");
    console.log("         select shipped model and session adapters, write the CLI shim, reconcile identities,");
    console.log("         and register (and start, unless --no-start) declared services.");
    return;
  }
  if (options.link !== undefined) {
    const checkout = linkCheckout(options.link);
    pointCurrent(checkout.root);
    process.env.BARRY_NODE = checkout.node;
  } else if (before.kind === "missing") {
    throw new Error(`current points at ${before.target}, which does not exist; run barry setup --link <checkout>, or remove current and run a release's barry setup`);
  } else if (!before.current) {
    const source = options.releaseRoot ?? releaseRoot();
    const release = readRelease(source);
    if (release) pointCurrent(copyRelease(source, release));
  }
  const installed = currentInstallation();
  if (installed.current) {
    process.env.BARRY_DIR = installed.root;
    process.env.BARRY_BUILTIN_DIR = join(installed.root, "bags");
    process.env.BARRY_HOOK_DISPATCHER = installedProgramPath("barry-hook");
    console.log(`current → ${installed.target} (${installed.kind === "release" ? `release ${installed.version}` : "linked checkout"})`);
    if (options.link !== undefined && before.target && before.target !== installed.target)
      console.log("Running services keep the code they started with until they restart.");
  }
  const { owner: installation } = await import("@barry-rocks/identities-bag");
  const owner = installation.installation().provision({
    actorId: options.owner === undefined ? undefined : Number(options.owner),
    username: userInfo().username,
  });
  console.log(`Installation owner: ${owner.actorId} ${JSON.stringify(owner.name)}`);
  const services = await installedServices({
    prepare: true,
    refresh: true,
    os,
  });
  const root = installationRoot();
  for (const dir of [
    barryAppSupportDir(),
    barryCacheDir(),
    barryLogsDir(),
    barryConfigDir(),
  ])
    mkdirSync(dir, { recursive: true });
  const providers = loadModelProviders({ file: barryModelProvidersPath() });
  for (const shipped of shippedModelProviders(root)) {
    const recorded = providers.installed().find(record => record.packageName === shipped.packageName);
    // A user selection elsewhere replaces the shipped package and stays the user's. One at the
    // shipped directory is the shipped package itself, adopted so a later move refreshes it.
    const isAdoption = recorded !== undefined && !recorded.shipped;
    if (isAdoption && recorded.path !== shipped.path) continue;
    const isCurrent = recorded?.path === shipped.path
      && recorded.version === shipped.version
      && recorded.contractVersion === shipped.contractVersion
      && recorded.factoryExport === shipped.factoryExport;
    if (!isAdoption && isCurrent) continue;
    try {
      const selected = await providers.add(shipped.path, { shipped: true });
      if (selected.shipped) console.log(`${isAdoption ? "Adopted" : "Selected"} ${shipped.packageName} from ${shipped.path}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Refused ${shipped.packageName}: ${message}; run pnpm build:packages, then barry setup.`);
    }
  }
  const { adapters } = await adapterStore();
  for (const id of await selectShippedSessionAdapters(root, adapters)) console.log(`Selected session adapter ${id}.`);
  if (adapters.installed().length === 0) console.log("No session adapter is installed. Install one, then run: barry adapter add adapters/sessions/<name>");
  ensureInstanceSecret();
  step("CLI");
  console.log(writeShim(root));
  if (installed.current) {
    const { reconcileAllIdentities, describeReconcile } = await import("../lib/identity-commands.js");
    for (const line of describeReconcile(await reconcileAllIdentities())) console.log(line);
  }
  const apps = await discoverBagApps();
  const rebuild = new Set(options.apps ?? []);
  for (const name of rebuild)
    if (!apps.some((app) => `${app.bag}.${app.name}` === name))
      throw new Error(`no bag declares app ${name}`);
  const updatedApps = new Set<string>();
  const started: string[] = [];
  for (const app of apps) {
    if (
      rebuild.has(`${app.bag}.${app.name}`) ||
      !isValidAppBundle(app.outputPath)
    ) {
      const result = await buildBagApp(app);
      if (!result.ok)
        throw new Error(`${app.bag}.${app.name}: ${result.error}`);
    }
    if (installBundle(app.outputPath, app.name).replaced)
      updatedApps.add(`${app.bag}.${app.name}`);
  }
  step("Services");
  const listed = await services.list();
  const system = options.systemOS ?? systemOS();
  // The privileged pass has no network, so the owner's setup fetches the runtime it installs.
  if (!listed.some(service => service.state === "unsupported") && listed.some((service) => {
    const definition = services.definition(service.name);
    return isSystemService(definition) && !system.exists(definition.command[0]);
  })) {
    try {
      if (await downloadRuntime(options.download)) console.log(`Downloaded node v${nodeRuntime().version} for system services.`);
    } catch (error) {
      console.warn(`warning: could not download node v${nodeRuntime().version} for system services: ${error instanceof Error ? error.message : String(error)}; rerun barry setup before \`sudo barry setup --system\``);
    }
  }
  let unsupported: ServiceRefusal | undefined;
  for (const service of listed) {
    if (isSystemService(services.definition(service.name))) {
      const specs = JSON.parse(readFileSync(join(services.instance.home, "service-definitions.json"), "utf8")) as Record<string, ServiceSpec>;
      console.log(specs[service.name]
        ? systemNeeds(services, specs[service.name], system, os)
        : `${service.name}: retained (system); remove it with \`sudo barry service remove ${service.name}\``);
      continue;
    }
    // A missing choice is a new declaration. A false choice is an intentional removal.
    if (!services.hasChoice(service.name)) {
      await services.apply(service.name, "add");
      const app = apps.find((app) => `${app.bag}.${app.name}` === service.name);
      const automatic = app
        ? app.app.loginItem === true
        : services.definition(service.name).automatic === true;
      if (automatic) await services.apply(service.name, "enable");
    }
    const choice = services.choice(service.name);
    if (choice.registered) {
      await services.apply(service.name, "add");
      if (options.start !== false && choice.enabled && !unsupported) {
        const running = (await services.status(service.name)).pid;
        try {
          await services.apply(service.name, running && updatedApps.has(service.name) ? "restart" : "start");
          started.push(service.name);
        } catch (error) {
          if (!(error instanceof ServiceRefusal) || error.reason !== "unsupported") throw error;
          unsupported = error;
        }
      }
    }
    console.log(
      `${service.name}: ${choice.registered ? (choice.enabled ? "enabled" : "disabled") : "removed"}`,
    );
  }
  const collected = await services.collectLogs(barryLogsDir());
  if (collected.keys.length)
    console.log(`Collected logs: ${collected.keys.join(", ")} (${collected.bytes} bytes)`);
  if (unsupported) throw unsupported;
  await waitForServices(services, started, readServiceRegistry().resources);
}
