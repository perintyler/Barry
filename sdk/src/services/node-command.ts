import { barryCurrentDir, installationRoot } from "./home.mjs";
import { homedir } from "node:os";
/**
 * How Barry runs one of its own TypeScript entry points in a fresh process:
 * the node that is running now, with tsx's loader named by absolute path.
 *
 * Neither the PATH's node (nvm's may shadow Homebrew's) nor a `tsx` on PATH
 * matters, which is what the hook dispatcher's old shell shim existed to paper
 * over on every firing.
 */
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The Node installed files name: a release `current` runs its own runtime and a
 * linked one the `BARRY_NODE` its wrappers carry, whatever Node runs this
 * process; without `current`, the running Node.
 */
export function stableNodePath(): string {
  const current = barryCurrentDir();
  if (existsSync(current)) {
    const runtime = join(current, "runtime", "bin", "node");
    if (existsSync(runtime)) return runtime;
    if (process.env.BARRY_NODE && existsSync(process.env.BARRY_NODE)) return process.env.BARRY_NODE;
  }
  return runningNodePath();
}

/**
 * This node, by the most stable name that reaches it: a PATH entry that links
 * to the running binary (Homebrew's `/opt/homebrew/bin/node`) rather than the
 * versioned directory it resolves to, which a `brew upgrade` deletes.
 */
export function runningNodePath(): string {
  const running = realpathSync(process.execPath);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "node");
    try {
      if (dir && existsSync(candidate) && realpathSync(candidate) === running) return candidate;
    } catch {
      // unreadable PATH entry
    }
  }
  return process.execPath;
}

/**
 * tsx's loader, as the file URL `node --import` takes, found from `fromDir`
 * upward. Through the nearest `node_modules/tsx` link rather than the
 * versioned store directory it points into, so updating tsx does not strand a
 * command baked into settings.
 *
 * `fromDir` is the ENTRY's directory, not this module's: this module is
 * bundled into places with no node_modules above them (a bag's tools in the
 * cache), and there the search found nothing and every bag load threw.
 */
export function tsxLoaderUrl(fromDir: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const linked = join(dir, "node_modules", "tsx", "dist", "loader.mjs");
    if (existsSync(linked)) return pathToFileURL(linked).href;
    if (dirname(dir) === dir) break;
  }
  const require = createRequire(join(fromDir, "noop.js"));
  return pathToFileURL(join(dirname(require.resolve("tsx/package.json")), "dist", "loader.mjs")).href;
}

/** `node --import <tsx> <entry>`, as an argv, with tsx from the entry's own checkout. */
export function nodeTsArgv(entry: string): string[] {
  return [stableNodePath(), "--import", tsxLoaderUrl(dirname(entry)), entry];
}

/** Quote one word for a POSIX shell. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The same command as one shell string, for a settings file that takes one. */
export function nodeTsCommand(entry: string): string {
  return nodeTsArgv(entry).map(shellWord).join(" ");
}

export function serviceLaunchPath(): string {
  return [...new Set([dirname(stableNodePath()), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

type InstalledProgram = "barry" | "barry-service" | "barry-hook";

export function installedProgramPath(program: InstalledProgram): string {
  const root = installationRoot();
  if (existsSync(barryCurrentDir()) && (program !== "barry-hook" || existsSync(join(root, "runtime", "bin", "node"))))
    return join(root, "bin", program);
  // Harnesses give hooks a fixed environment without a linked checkout's BARRY_NODE.
  return join(root, "cli", "bin", `${program}.js`);
}

export function installedCommand(program: InstalledProgram): { argv: string[]; environment: Record<string, string> } {
  const path = installedProgramPath(program);
  const wrapper = !path.endsWith(".js");
  return {
    argv: wrapper ? [path] : [stableNodePath(), path],
    environment: wrapper && !existsSync(join(installationRoot(), "runtime", "bin", "node"))
      ? { BARRY_NODE: stableNodePath() } : {},
  };
}
