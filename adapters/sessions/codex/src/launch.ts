/**
 * Codex's guest launch: the human drives the `codex` TUI in a private
 * `CODEX_HOME` Barry prepares, on the identity's key.
 *
 * The TUI ignores a key in its environment and reads only a login, so the
 * home declares a provider that takes `OPENAI_API_KEY` from the environment,
 * and no login is ever there to fall back to (`runtime.ts`). Barry's
 * PreToolUse hook in that home is the gate; the TUI only runs it with hook
 * trust bypassed, because Barry generated it.
 *
 * Codex can't be told a conversation id up front, so the plan finds it
 * afterwards: the one rollout the TUI writes in this session's own home.
 *
 * A one-shot is refused, and the launcher runs it hosted instead.
 */
import { readdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import { requireIdentityKey } from "./credential.js";
import { ephemeralCodexHome, prepareCodexRuntime, userCodexConfigPath } from "./runtime.js";

const ROLLOUT_THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;

export async function planCodexLaunch(config: SessionConfig, guarantees: Guarantees): Promise<LaunchPlan> {
  requireIdentityKey(config.env);
  if (oneShotPrompt(config)) throw new NotSupportedInMode("prompt", "guest");

  // Not a temp dir: `codex resume` reads the conversation from it on a later run.
  const throwawayHome = config.ephemeral ? ephemeralCodexHome() : undefined;
  let runtime: ReturnType<typeof prepareCodexRuntime>;
  try { runtime = prepareCodexRuntime({
    barrySessionId: config.sessionId,
    ...(throwawayHome ? { codexHome: throwawayHome } : {}),
    mcpServers: config.mcpServers,
    deniedTools: config.deniedTools,
    allowedNativeTools: config.allowedNativeTools,
    env: config.env,
    projectDir: config.cwd,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.systemPrompt ? { instructions: config.systemPrompt } : {}),
    userConfigPath: userCodexConfigPath(config.env),
  }); } catch (error) {
    if (throwawayHome) rmSync(throwawayHome, { recursive: true, force: true });
    throw error;
  }

  const args = [
    "--cd", config.cwd,
    "--sandbox", "danger-full-access",
    "--ask-for-approval", "never",
    "--dangerously-bypass-hook-trust",
  ];
  const resumed = config.resume?.harnessSessionId;
  if (resumed) args.push("resume", resumed);

  return {
    command: "codex",
    args,
    env: runtime.env,
    tmpDirs: config.ephemeral ? [runtime.codexHome] : [],
    ...(resumed ? { harnessSessionId: resumed } : { discoverHarnessSessionId: () => onlyThreadIn(runtime.codexHome) }),
    guarantees: { ...guarantees },
    warnings: [],
  };
}

/** The thread id of the one rollout in a session's home. None, or several, is no answer. */
export async function onlyThreadIn(codexHome: string): Promise<string | undefined> {
  const threads = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const threadId = ROLLOUT_THREAD_ID.exec(entry.name)?.[1];
        if (threadId) threads.add(threadId);
      }
    }
  };
  await walk(join(codexHome, "sessions"));
  return threads.size === 1 ? [...threads][0] : undefined;
}

/** `barry start -p`: a one-shot, which this mode refuses. */
function oneShotPrompt(config: SessionConfig): string | undefined {
  const options = config.options;
  if (options === null || typeof options !== "object" || !("prompt" in options)) return undefined;
  return typeof options.prompt === "string" && options.prompt ? options.prompt : undefined;
}
