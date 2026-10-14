/**
 * Platform guards for the mutating commands.
 *
 * `assertPlatform` is the release builder's requirement (darwin-arm64), moved
 * here from `releases/build.ts` so the one copy serves every caller.
 *
 * `assertLaunchd` guards the commands that cannot do their job without
 * launchd — `setup` (unless `--no-start`), `up`, `down`, the `service`
 * start/stop/restart/run verbs, and `uninstall`. Read-only commands
 * (`status`, `bag list`, `doctor`, …) stay unguarded so a Linux contributor
 * keeps them. "launchd absent" is `/bin/launchctl` not existing, the same test
 * `bags/mcp/src/services/launchd.ts` uses to select the inert ServiceOS.
 */
import { existsSync } from "node:fs";
import { CliError } from "./cli-error.js";

export function assertPlatform(platform: string = process.platform, arch: string = process.arch): void {
  if (platform !== "darwin" || arch !== "arm64") throw new Error("releases require darwin-arm64");
}

/** True when launchd is present: macOS with `/bin/launchctl` on disk. */
export function hasLaunchd(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): boolean {
  return platform === "darwin" && exists("/bin/launchctl");
}

/**
 * Throw the one-sentence guard when launchd is absent. A thrown `CliError`
 * unwinds to `main.ts` and sets the exit code (CLI-14); it does not call
 * `process.exit`.
 */
export function assertLaunchd(platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): void {
  if (!hasLaunchd(platform, exists))
    throw new CliError("this command needs launchd (macOS); on this host run barry setup --link . --no-start and see docs/support.md");
}
