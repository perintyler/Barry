/**
 * cursor instrumented: the guest launch, plus one project hook: `stop`, which
 * cursor runs as a turn ends. The hook is Barry's relay (`barry hook cursor`);
 * it holds for a while, and a message that lands meanwhile comes back as a
 * `followup_message`, which cursor starts a new turn with, framed as the
 * user. A message that lands after the hold lets go waits for the next turn
 * to end, which is why the promise is `turn-end`, not `wake`.
 *
 * Only `stop` beside Barry's gate: a heavy hook set coincided with failed
 * turns.
 */
import { homedir } from "node:os";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { HOLD_SECONDS } from "./hooks.js";
import { planCursorLaunch, type CursorLaunchExtras } from "./launch.js";

export async function planInstrumented(
  config: SessionConfig,
  guarantees: Guarantees,
  extras: Pick<CursorLaunchExtras, "reserveChat"> = {},
): Promise<LaunchPlan> {
  return planCursorLaunch(config, guarantees, {
    ...extras,
    hooks: {
      version: 1,
      hooks: {
        // No cap on how often it may hold, and a timeout past the hold: a
        // capped or cut-short hold looks exactly like a session nobody is
        // messaging.
        stop: [{ command: relayWithBarryHome(relayCommand(config)), timeout: HOLD_SECONDS + 30, loop_limit: null }],
      },
    },
  });
}

/**
 * The relay finds Barry's services and stores through `$HOME`, and the TUI
 * runs in the session's own home, so the relay is given the user's back.
 */
export function relayWithBarryHome(relay: string, home = homedir()): string {
  return `HOME='${home.replace(/'/g, "'\\''")}' ${relay}`;
}

function relayCommand(config: SessionConfig): string {
  const options = config.options;
  const override = options !== null && typeof options === "object" ? (options as { relayCommand?: unknown }).relayCommand : undefined;
  if (typeof override !== "string" || !override.trim()) throw new Error("Cursor instrumented mode requires a Barry tracking relay");
  return override;
}
