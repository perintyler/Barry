import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
import { CODEX_REQUIREMENTS } from "../modes.js";
/**
 * The engine a hosted codex session runs on.
 *
 * `codex app-server` directly, in the `CODEX_HOME` Barry prepared with the
 * project pre-trusted (otherwise an attached TUI opens a trust dialog and
 * swallows what is typed into it). The session that drives it is
 * `hosted/app-server-session.ts`.
 */

import { toolGateConfig } from "../tool-gate.js";
import type { EngineSpec } from "@barry-rocks/sdk/adapters/harnesses";

/**
 * The engine spec for one codex session.
 *
 * Exported so a test can assert what Barry would run WITHOUT running it — the
 * "never the shared daemon" check is about the command line, and asserting it
 * by spawning a real engine would need a vendor login.
 */
export function codexEngineSpec(sessionId: string, codexHome: string, cwd: string, config: Parameters<typeof toolGateConfig>[0] = {}, env: Readonly<Record<string, string | undefined>> = process.env): EngineSpec {
  return {
    sessionId,
    kind: "codex",
    // `unix://` is a WebSocket upgrade over a unix socket; codex puts the real
    // socket under /private/tmp/codex-daemon-<uid>/ with this path as a symlink.
    transport: "unix",
    cwd,
    command: (address) => ({
      // `codex app-server` DIRECTLY. Never `codex agents` or `remote-control`:
      // those reach a managed, self-updating package, so Barry would hold a
      // handle to a process able to replace its own build.
      command: resolveHarnessCommand(CODEX_REQUIREMENTS, env),
      args: ["app-server", ...Object.entries(toolGateConfig(config)).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]), "--listen", `unix://${address}`],
      env: { CODEX_HOME: codexHome },
    }),
  };
}
