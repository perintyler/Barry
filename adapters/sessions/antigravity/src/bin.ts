import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Requirements } from "@barry-rocks/sdk/adapters/harnesses";

import { VERIFIED_ON } from "./modes.js";

const LOCAL_SHIM = join(homedir(), ".local", "bin", "agy");

/**
 * Keeps agy on the build its modes were verified on. Without it, a launch
 * such as a hosted session or `agy models` spawns `agy --bg-updater`, which
 * asks Google's release server for a newer build. 1.3.1 honours exactly
 * "true": with "1" or "TRUE" the updater still starts. `--version` exits before
 * the updater, so doctor and the version guard, which run it without this, start none.
 */
export const PIN_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } as const;

/**
 * Resolve the Antigravity CLI binary path.
 */
export function resolveAntigravityBin(): string {
  if (process.env.ANTIGRAVITY_BIN && existsSync(process.env.ANTIGRAVITY_BIN)) {
    return process.env.ANTIGRAVITY_BIN;
  }

  if (existsSync(LOCAL_SHIM)) return LOCAL_SHIM;

  for (const cmd of ["agy", "antigravity"]) {
    try {
      const found = execFileSync("which", [cmd], { encoding: "utf-8", stdio: "pipe" }).trim();
      if (found && existsSync(found)) return found;
    } catch {
      /* not on PATH */
    }
  }

  return "agy";
}

export const ANTIGRAVITY_REQUIREMENTS: Requirements = {
  binary: {
    command: "agy",
    paths: [LOCAL_SHIM],
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+)",
    install: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      fallback: "https://antigravity.google/docs/cli/install/",
    },
    pin: {
      version: VERIFIED_ON,
      enforcedBy: "AGY_CLI_DISABLE_AUTO_UPDATE=true in the env of every session and model listing, which stops agy's background updater; running agy update by hand still replaces the build",
    },
  },
};
