import {
  existsSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { openInstance, shellWord, stableNodePath } from "@barry-rocks/sdk/internal/services";
import { isSystemService, systemPaths } from "../services/system.js";
import type { ServiceDefinition } from "@barry-rocks/mcp-bag";
import {
  barryAppSupportDir,
  barryCurrentDir,
  barryReleasesDir,
  barryCacheDir,
  barryConfigDir,
  barryLogsDir,
  barryRunDir,
} from "@barry-rocks/sdk/services";
import { serviceOS, type ServiceOS } from "@barry-rocks/mcp-bag";
import { installedServices } from "../services/barry.js";
import { bold, dim, green, red, yellow } from "../lib/ansi.js";
import { currentInstallation } from "../releases/current.js";
import { cliShimDir, instanceBinDir, isHomebrewBarry, legacyCliShimDirs } from "../lib/identity-shims.js";

export interface UninstallOptions {
  /** Permanently delete all Barry databases, session histories, and configurations */
  purge?: boolean;
  /** Preview all actions and files without modifying disk or launchd */
  dryRun?: boolean;
  /** Skip interactive confirmation prompts */
  yes?: boolean;
  /** Also unload system-level LaunchDaemons (requires sudo) */
  system?: boolean;
  /** Output structured JSON of discovered and removed items */
  json?: boolean;
  /** Injected Launchd OS boundary for testing */
  launchd?: ServiceOS;
  /** Custom directory for LaunchAgents (defaults to ~/Library/LaunchAgents) */
  launchAgentsDir?: string;
  systemDaemonsDir?: string;
  systemCodeDir?: string;
  /** Where this instance's system services keep state (defaults to the machine's paths) */
  systemPaths?: typeof systemPaths;
  /** Custom directories to check for CLI shims */
  shimDirs?: string[];
  /** Custom stdout writer for tests */
  log?: (message: string) => void;
}

export interface UninstallSummary {
  dryRun: boolean;
  purged: boolean;
  servicesUnloaded: string[];
  plistsRemoved: string[];
  shimsRemoved: string[];
  appsRemoved: string[];
  cachesRemoved: string[];
  runtimeRemoved: string[];
  installationRemoved: string[];
  dataRetained: string[];
  dataPurged: string[];
  systemDaemonsDetected: string[];
  systemDaemonsRemoved: string[];
}

function candidateShimDirs(): string[] {
  const instanceBin = instanceBinDir();
  if (instanceBin) return [instanceBin];
  // The same single resolver setup writes with, plus the locations a previous
  // release wrote into, so uninstall still finds an old shim for one release.
  return [...new Set([cliShimDir(), ...legacyCliShimDirs()])];
}

/**
 * An isolated instance owns only its recorded labels; an unreadable id grants
 * no ownership. Machine-instance removal includes legacy Barry labels.
 * See docs/decisions/0036-cli-launch-and-persistence-rationale.md.
 */
export function ownsAgent(barryHome: string | null = process.env.BARRY_HOME ?? null, appSupport = barryAppSupportDir()): (label: string) => boolean {
  if (!barryHome) return (label) => label.startsWith("rocks.barry.") || label.startsWith("com.barry.");
  let id: unknown;
  try {
    const record: unknown = JSON.parse(readFileSync(join(appSupport, "instance.json"), "utf8"));
    id = record && typeof record === "object" && "id" in record ? record.id : undefined;
  } catch {
    id = undefined;
  }
  return typeof id === "string" && id ? (label) => label.startsWith(`rocks.barry.${id}.`) : () => false;
}

/** Extracts the <key>Label</key><string>...</string> from a plist, falling back to filename without .plist */
function extractPlistLabel(plistPath: string): string {
  try {
    const content = readFileSync(plistPath, "utf8");
    const match = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/i.exec(content);
    if (match?.[1]) return match[1].trim();
  } catch {
    /* ignore unreadable plist */
  }
  return basename(plistPath, ".plist");
}

export async function uninstallCommand(options: UninstallOptions = {}): Promise<UninstallSummary> {
  // Guard only what needs the host's launchd: not a caller's own service OS
  // (the tests and the install verifier pass a stand-in), and not a dry run,
  // which only lists what would go, as `setup --dry-run` does.
  if (!options.launchd && !options.dryRun) {
    const { assertLaunchd } = await import("../lib/platform.js");
    assertLaunchd();
  }
  const os = options.launchd ?? serviceOS();
  const dryRun = Boolean(options.dryRun);
  if (options.system && !dryRun && os.canControl?.("system") === false) throw new Error("system uninstall needs sudo");
  const purge = Boolean(options.purge);
  const log = options.log ?? ((msg: string) => console.log(msg));

  const summary: UninstallSummary = {
    dryRun,
    purged: purge,
    servicesUnloaded: [],
    plistsRemoved: [],
    shimsRemoved: [],
    appsRemoved: [],
    cachesRemoved: [],
    runtimeRemoved: [],
    installationRemoved: [],
    dataRetained: [],
    dataPurged: [],
    systemDaemonsDetected: [],
    systemDaemonsRemoved: [],
  };

  const domain = `gui/${process.getuid?.() ?? 501}`;

  // 1. Scan and unload User LaunchAgents
  const agentsDir = options.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const owned = ownsAgent();
  if (existsSync(agentsDir)) {
    try {
      const entries = readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isFile() &&
          entry.name.endsWith(".plist") &&
          (entry.name.startsWith("rocks.barry.") || entry.name.startsWith("com.barry."))
        ) {
          const plistPath = join(agentsDir, entry.name);
          const label = extractPlistLabel(plistPath);
          if (!owned(label)) continue;

          const job = os.inspect(domain, label);
          if (job.loaded) {
            summary.servicesUnloaded.push(label);
            if (!dryRun) {
              try {
                await os.unload(domain, label, 10000);
              } catch {
                /* ignore unload failure */
              }
              try {
                os.enable(domain, label, false);
              } catch {
                /* ignore disable failure */
              }
            }
          }

          summary.plistsRemoved.push(plistPath);
          if (!dryRun) {
            try {
              rmSync(plistPath, { force: true });
            } catch {
              /* ignore removal failure */
            }
          }
        }
      }
    } catch {
      /* ignore directory read failure */
    }
  }

  // 2. Clear service management registrations if instance is accessible
  try {
    const services = await installedServices({ prepare: false, refresh: false, os });
    for (const service of await services.list()) {
      if (isSystemService(services.definition(service.name)) && !options.system) continue;
      if (service.registered) {
        if (!summary.servicesUnloaded.includes(service.label)) {
          summary.servicesUnloaded.push(service.label);
        }
        if (!dryRun) {
          try {
            await services.apply(service.name, "remove");
          } catch {
            /* ignore service remove failure */
          }
        }
      }
    }
  } catch {
    // If instance is absent or corrupted, the direct plist & launchd sweep above already handled it.
  }

  // 3. Remove CLI Shims
  let homebrew = false;
  const checkDirs = options.shimDirs ?? candidateShimDirs();
  for (const dir of checkDirs) {
    const shim = join(dir, "barry");
    if (isHomebrewBarry(shim)) { homebrew = true; continue; }
    if (existsSync(shim)) {
      summary.shimsRemoved.push(shim);
      if (!dryRun) {
        try {
          rmSync(shim, { force: true });
        } catch {
          /* ignore unlink failure */
        }
      }
    }
  }

  // 4. Remove Built App Bundles
  const appsDir = join(barryAppSupportDir(), "apps");
  if (existsSync(appsDir)) {
    summary.appsRemoved.push(appsDir);
    if (!dryRun) {
      try {
        rmSync(appsDir, { recursive: true, force: true });
      } catch {
        /* ignore directory removal failure */
      }
    }
  }

  // 5. Remove Build Caches
  const cacheDir = barryCacheDir();
  if (existsSync(cacheDir)) {
    summary.cachesRemoved.push(cacheDir);
    if (!dryRun) {
      try {
        rmSync(cacheDir, { recursive: true, force: true });
      } catch {
        /* ignore cache removal failure */
      }
    }
  }

  // 6. Remove Runtime Sockets / PIDs
  const runDir = barryRunDir();
  if (existsSync(runDir)) {
    summary.runtimeRemoved.push(runDir);
    if (!dryRun) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore run dir removal failure */
      }
    }
  }

  // System registrations follow the same instance ownership boundary as agents.
  const systemDaemonsDir = options.systemDaemonsDir ?? "/Library/LaunchDaemons";
  const systemOwns = ownsAgent();
  if (existsSync(systemDaemonsDir)) {
    for (const entry of readdirSync(systemDaemonsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".plist")) continue;
      const plistPath = join(systemDaemonsDir, entry.name);
      const label = extractPlistLabel(plistPath);
      if (!systemOwns(label) || !(label.startsWith("rocks.barry.") || label.startsWith("com.barry.bag."))) continue;
      summary.systemDaemonsDetected.push(label);
      if (options.system) {
        if (!dryRun) {
          await os.unload("system", label, 40000);
          os.enable("system", label, false);
          rmSync(plistPath);
        }
        summary.systemDaemonsRemoved.push(plistPath);
      }
    }
  }
  const systemState: string[] = [];
  if (options.system && existsSync(join(barryAppSupportDir(), "instance.json"))) {
    const instance = openInstance(barryAppSupportDir());
    const code = options.systemCodeDir ?? join("/usr/local/libexec/barry", instance.id);
    if (existsSync(code)) {
      summary.systemDaemonsRemoved.push(code);
      if (!dryRun) rmSync(code, { recursive: true, force: true });
    }
    const definitionsPath = join(instance.home, "managed-definitions.json");
    const definitions = existsSync(definitionsPath) ? JSON.parse(readFileSync(definitionsPath, "utf8")) as ServiceDefinition[] : [];
    const specsPath = join(instance.home, "service-definitions.json");
    const specs = existsSync(specsPath) ? JSON.parse(readFileSync(specsPath, "utf8")) as Record<string, { bag?: string }> : {};
    for (const definition of definitions.filter(isSystemService)) {
      // Computed from the instance, never read from the definition: a record copied from
      // another instance must not lead a purge here to that instance's data.
      const bag = specs[definition.name]?.bag ?? definition.name.split(".")[0];
      const state = (options.systemPaths ?? systemPaths)(instance, bag, definition.name).state;
      if (!systemState.includes(state) && existsSync(state)) systemState.push(state);
    }
  }

  const keepInstallation = summary.systemDaemonsDetected.length > 0 && summary.systemDaemonsRemoved.length === 0;
  if (keepInstallation) {
    const installed = currentInstallation();
    if (installed.current && installed.kind !== "missing") {
      const argv = installed.kind === "release"
        ? [join(installed.root, "bin/barry")]
        : [stableNodePath(), join(installed.root, "cli/bin/barry.js")];
      log(`Kept current and releases for system daemons; run sudo ${argv.map(shellWord).join(" ")} uninstall --system.`);
    }
  } else {
    const current = barryCurrentDir();
    let selector = false;
    try { selector = lstatSync(current).isSymbolicLink(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (selector) {
      summary.installationRemoved.push(current);
      if (!dryRun) unlinkSync(current);
    }
    const releases = barryReleasesDir();
    if (existsSync(releases)) {
      summary.installationRemoved.push(releases);
      if (!dryRun) rmSync(releases, { recursive: true, force: true });
    }
  }
  if (homebrew && !options.json) log("Homebrew installed barry: run `brew uninstall barry`.");

  // 8. Data Purge vs Retention
  const durableDirs = [
    ...systemState.map((path) => ({ label: "System service state", path })),
    { label: "Application Support", path: barryAppSupportDir() },
    { label: "Logs", path: barryLogsDir() },
    { label: "Configuration", path: barryConfigDir() },
  ];

  if (purge) {
    if (!options.yes && !dryRun && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      log(red(bold("\n⚠️  WARNING: Data Purge Requested")));
      log("The following directories will be permanently removed:");
      for (const d of durableDirs) {
        if (existsSync(d.path)) log(`  - ${d.label}: ${d.path}`);
      }
      const answer = await rl.question(yellow("\nAre you sure you want to permanently delete all data? [y/N]: "));
      rl.close();
      if (!/^(y|yes)$/i.test(answer.trim())) {
        log(dim("Purge aborted by user. Only services, shims, apps, and caches were removed."));
        for (const d of durableDirs) {
          if (existsSync(d.path)) summary.dataRetained.push(d.path);
        }
        return outputResult(summary, log, options.json);
      }
    }

    for (const d of durableDirs) {
      if (keepInstallation && d.path === barryAppSupportDir()) {
        summary.dataRetained.push(d.path);
        log("Application Support retained until the system daemons are removed.");
        continue;
      }
      if (existsSync(d.path)) {
        summary.dataPurged.push(d.path);
        if (!dryRun) {
          try {
            rmSync(d.path, { recursive: true, force: true });
          } catch {
            /* ignore purge failure */
          }
        }
      }
    }
  } else {
    for (const d of durableDirs) {
      if (existsSync(d.path)) summary.dataRetained.push(d.path);
    }
  }

  return outputResult(summary, log, options.json);
}

function outputResult(
  summary: UninstallSummary,
  log: (msg: string) => void,
  json?: boolean,
): UninstallSummary {
  if (json) {
    log(JSON.stringify(summary, null, 2));
    return summary;
  }

  if (summary.dryRun) {
    log(bold("\n[Dry Run] Barry Uninstallation Preview"));
    log(dim("No changes have been made to disk or system services.\n"));
  } else {
    log(green(bold("\n✓ Barry Uninstalled Successfully\n")));
  }

  if (summary.servicesUnloaded.length > 0) {
    log(bold("LaunchAgent Services Unloaded:"));
    for (const s of summary.servicesUnloaded) log(`  - ${s}`);
  }

  if (summary.plistsRemoved.length > 0) {
    log(bold("LaunchAgent Plists Removed:"));
    for (const p of summary.plistsRemoved) log(`  - ${p}`);
  }

  if (summary.shimsRemoved.length > 0) {
    log(bold("CLI Shims Removed:"));
    for (const s of summary.shimsRemoved) log(`  - ${s}`);
  }

  if (summary.installationRemoved.length > 0) {
    log(bold("Installation Removed:"));
    for (const path of summary.installationRemoved) log(`  - ${path}`);
  }

  if (summary.appsRemoved.length > 0) {
    log(bold("App Bundles Cleaned:"));
    for (const a of summary.appsRemoved) log(`  - ${a}`);
  }

  if (summary.cachesRemoved.length > 0) {
    log(bold("Caches Cleared:"));
    for (const c of summary.cachesRemoved) log(`  - ${c}`);
  }

  if (summary.dataPurged.length > 0) {
    log(red(bold("Data Purged:")));
    for (const p of summary.dataPurged) log(`  - ${p}`);
  } else if (summary.dataRetained.length > 0) {
    log(bold("User Data Retained (use --purge to delete):"));
    for (const r of summary.dataRetained) log(`  - ${r}`);
  }

  if (summary.systemDaemonsDetected.length > 0 && summary.systemDaemonsRemoved.length === 0) {
    log(yellow(bold("\nSystem LaunchDaemons Detected (require sudo to remove):")));
    for (const d of summary.systemDaemonsDetected) log(`  - ${d}`);
    log(dim("Run 'sudo barry uninstall --system' to remove them."));
  }

  return summary;
}
