import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
import { CODEX_REQUIREMENTS } from "./modes.js";
/**
 * Codex instrumented: the codex TUI attached to the engine Barry runs for the
 * hosted session, as `codex resume <thread> --remote`. The session itself is
 * hosted, and the TUI is one place it shows. The launcher opens the hosted
 * session and passes its attachment in.
 *
 * The TUI is only a client of that engine, so it needs no credential: the
 * engine holds the identity's key. It runs in the session's own codex home,
 * where its config and Barry's gate are.
 */
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import type { SessionAttachment, SessionConfig } from "@barry-rocks/sdk/sessions";
import { defaultCodexHome, ensureCodexHome } from "./runtime.js";

/** Names the TUI's own environment has no use for: the engine authenticates. */
const ENGINE_ONLY_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"];

export async function planCodexAttach(config: SessionConfig, guarantees: Guarantees): Promise<LaunchPlan> {
  const attachment = attachmentOf(config.options);
  if (!attachment) {
    throw new Error("codex instrumented shows a hosted session; start it with `barry start`, which opens that session first");
  }
  const env = Object.fromEntries(Object.entries(config.env).filter(([name, value]) => value !== undefined && !ENGINE_ONLY_ENV.includes(name)));
  const codexHome = defaultCodexHome(config.sessionId);
  ensureCodexHome(codexHome);
  return {
    command: resolveHarnessCommand(CODEX_REQUIREMENTS, config.env),
    args: ["resume", attachment.harnessSessionId, "--remote", `unix://${attachment.address}`, "--cd", config.cwd],
    env: { ...env, CODEX_HOME: codexHome },
    tmpDirs: [],
    harnessSessionId: attachment.harnessSessionId,
    guarantees: { ...guarantees },
    warnings: [],
  };
}

function attachmentOf(options: unknown): SessionAttachment | undefined {
  if (options === null || typeof options !== "object" || !("attachment" in options)) return undefined;
  const attachment = (options as { attachment?: Partial<SessionAttachment> }).attachment;
  return typeof attachment?.address === "string" && typeof attachment.harnessSessionId === "string"
    ? { address: attachment.address, harnessSessionId: attachment.harnessSessionId }
    : undefined;
}
