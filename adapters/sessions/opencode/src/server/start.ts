import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
import { OPENCODE_REQUIREMENTS } from "../modes.js";
/**
 * The server a hosted opencode session runs on.
 *
 * Barry runs its own `serve` per session — the E6 fix for hosted — with the
 * environment `launch-env.ts` builds, and a password on the server's
 * environment. The session that drives it is `hosted/serve-session.ts`.
 */

import type { EngineSpec } from "@barry-rocks/sdk/adapters/harnesses";
import { serveArgs } from "./launch-env.js";

/**
 * The engine spec for one opencode session.
 *
 * TCP rather than a unix socket: no unix transport was observed on v2.
 * Exported so a test can assert what Barry would run without running it.
 */
export function openCodeEngineSpec(sessionId: string, cwd: string, env: Record<string, string>): EngineSpec {
  return {
    sessionId,
    kind: "opencode",
    transport: "tcp",
    cwd,
    // The server needs a per-session Basic password; the lifecycle service
    // generates it and sets it under the name below, in the environment and
    // never argv (any user can read another's command line via `ps`).
    needsPassword: true,
    passwordEnvVar: "OPENCODE_SERVER_PASSWORD",
    command: (address) => ({
      command: resolveHarnessCommand(OPENCODE_REQUIREMENTS, env),
      args: serveArgs(Number(address.split(":").pop())),
      // Config on the SERVER. An attaching client's copy is ignored — that
      // asymmetry is E6.
      env,
    }),
  };
}
