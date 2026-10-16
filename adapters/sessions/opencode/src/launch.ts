import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
import { OPENCODE_REQUIREMENTS } from "./modes.js";
import { allowedNative } from "./native-tools.js";
/**
 * OpenCode's guest launch: the human drives opencode's own TUI.
 *
 * `--standalone`, so the TUI runs a private server that takes this launch's
 * config and exits with it. A bare TUI joins the per-user background service
 * instead, which keeps the FIRST launcher's config: verified on 2.0.24, a
 * second TUI given another session's MCP servers reached the first one's
 * (E6). Everything else the TUI runs in — the session's own data dir, the
 * identity's keys, the rules — is the hosted server's too
 * (`server/launch-env.ts`).
 *
 * Barry's MCP tools run unasked and every native tool is denied, by rules
 * fixed at launch. The human can still choose a model in the TUI, from the
 * providers the identity holds keys for.
 *
 * A one-shot is refused, and the launcher runs it hosted instead: `opencode
 * run` sends its only request before the MCP servers have listed their tools,
 * so it would run without Barry's, and it blocks until stdin closes.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import { toOpenCodeMcpConfig } from "./mcp-config.js";
import {
  enabledProviders,
  openCodeEnv,
  openCodeHome,
  permissionRules,
  prepareRuntimeDir,
  sessionConfig,
} from "./server/launch-env.js";

export async function planOpenCodeLaunch(config: SessionConfig, guarantees: Guarantees, homesRoot?: string): Promise<LaunchPlan> {
  if (oneShotPrompt(config)) throw new NotSupportedInMode("prompt", "guest");

  const identityEnv = definedEnv(config.env);
  const servers = Object.keys(config.mcpServers);
  const home = openCodeHome(config.sessionId, homesRoot);
  const resumed = config.resume?.harnessSessionId;
  // `--session` creates a conversation it cannot find, so a resume whose
  // data is gone would start an empty one under the old id, silently.
  if (resumed && !existsSync(join(home.data, "opencode", "opencode.db"))) {
    throw new Error(`opencode conversation ${resumed} is not in this session's opencode data, so it cannot be resumed`);
  }
  // Chosen here rather than by opencode, so it is recorded before the TUI
  // starts and the session can be resumed even if it dies early.
  const harnessSessionId = resumed ?? openCodeSessionId(config.sessionId);

  const runtimeDir = prepareRuntimeDir();
  const env = openCodeEnv({
    home,
    runtimeDir,
    identityEnv,
    config: sessionConfig({
      mcp: toOpenCodeMcpConfig(config.mcpServers),
      permissions: permissionRules(servers, config.deniedTools ?? [], allowedNative(config), "allow"),
      providers: enabledProviders(identityEnv, config.model),
      ...(config.model ? { model: config.model } : {}),
    }),
  });

  return {
    command: resolveHarnessCommand(OPENCODE_REQUIREMENTS, config.env),
    args: ["--standalone", "--session", harnessSessionId],
    env: { ...identityEnv, ...env },
    cwd: config.cwd,
    // The runtime dir only: the home holds the conversation.
    tmpDirs: [runtimeDir],
    harnessSessionId,
    guarantees: { ...guarantees },
    warnings: [],
  };
}

/** A new conversation's id: opencode's `ses_` form, from the Barry session it belongs to. */
function openCodeSessionId(barrySessionId: string): string {
  return `ses_${createHash("sha256").update(barrySessionId).digest("hex").slice(0, 26)}`;
}

/** `barry start -p`: a one-shot, which this mode refuses. */
function oneShotPrompt(config: SessionConfig): string | undefined {
  const options = config.options;
  if (options === null || typeof options !== "object" || !("prompt" in options)) return undefined;
  return typeof options.prompt === "string" && options.prompt ? options.prompt : undefined;
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
