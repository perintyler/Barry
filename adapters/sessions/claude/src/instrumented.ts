/**
 * claude instrumented: the guest TUI plus two ways in for Barry. An inbox
 * socket delivers messages and wakes an idle TUI, and OpenTelemetry carries
 * prompts, replies and tool calls to Barry as they happen.
 *
 * A way in that cannot be opened is left closed, and the plan reports the
 * guest guarantee for it instead of promising what it cannot deliver.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { planClaudeLaunch } from "./anthropic-compatible/launch.js";
import { deliverToInboxSocket } from "./inbox-socket.js";
import { planInboxSocket } from "./inbox-socket-launch.js";

export interface InstrumentedGuarantees {
  instrumented: Guarantees;
  guest: Guarantees;
}

export async function planInstrumented(config: SessionConfig, guarantees: InstrumentedGuarantees): Promise<LaunchPlan> {
  // claude refuses a socket in a directory others can write to.
  const runDir = mkdtempSync(join(tmpdir(), "barry-cc-"));
  const socket = await planInboxSocket(runDir, socketName(config.sessionId));
  const hasTelemetry = Boolean(config.telemetryEndpoint);

  const launch = await planClaudeLaunch(config, guarantees.instrumented, {
    mode: "instrumented",
    ...(socket ? { inboxSocketPath: socket.socketPath, settings: socket.settings } : {}),
  });

  return {
    ...launch,
    // Tells the session-tracker hooks that telemetry already records this
    // session's messages, so they don't store them twice.
    env: { ...launch.env, ...(hasTelemetry ? { BARRY_CAPTURE: "telemetry" } : {}) },
    tmpDirs: [...launch.tmpDirs, runDir],
    guarantees: {
      ...guarantees.instrumented,
      capture: hasTelemetry ? guarantees.instrumented.capture : guarantees.guest.capture,
      delivery: socket ? guarantees.instrumented.delivery : guarantees.guest.delivery,
    },
    ...(socket
      ? {
          inbox: {
            guarantee: guarantees.instrumented.delivery,
            deliver: ({ content, from }) =>
              deliverToInboxSocket({ socketPath: socket.socketPath }, { content, ...(from ? { fromSessionId: from } : {}) }),
          },
        }
      : {}),
    warnings: [
      ...launch.warnings,
      ...(socket ? [] : ["The inbox socket could not be placed, so messages reach this session only when it calls a Barry tool."]),
    ],
  };
}

/** The whole socket path must fit in about 104 bytes. */
function socketName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(-16) || "session";
}
