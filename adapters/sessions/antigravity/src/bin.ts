import { resolveHarnessCommand, type Requirements } from "@barry-rocks/sdk/adapters/harnesses";

import { HOSTED_RECOMMENDED_VERSION } from "./modes.js";

/**
 * Prevents agy from replacing its executable during a session. Without it, a launch
 * such as a hosted session or `agy models` spawns `agy --bg-updater`, which
 * asks Google's release server for a newer build. 1.3.1 honours exactly
 * "true": with "1" or "TRUE" the updater still starts. `--version` exits before
 * the updater, so doctor and the version guard, which run it without this, start none.
 */
export const PIN_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } as const;

/**
 * Resolve the Antigravity CLI binary path.
 */
export function resolveAntigravityBin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return resolveHarnessCommand(ANTIGRAVITY_REQUIREMENTS, env);
}

export const ANTIGRAVITY_REQUIREMENTS: Requirements = {
  binary: {
    command: "agy",
    overrideEnv: "ANTIGRAVITY_BIN",
    versionArgs: ["--version"],
    versionPattern: "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)",
    install: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      fallback: "https://antigravity.google/docs/cli/install/",
    },
    recommendedVersion: HOSTED_RECOMMENDED_VERSION,
  },
};
