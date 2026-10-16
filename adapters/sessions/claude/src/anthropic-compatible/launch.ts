import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
import { CLAUDE_REQUIREMENTS } from "../modes.js";
/**
 * The `claude` TUI launch, for guest and instrumented.
 *
 * The TUI must run on the identity's key and never on the user's own `/login`
 * (I10). An `ANTHROPIC_API_KEY` in its env is not enough: the TUI asks whether
 * to use it, and a "no" falls back to the login. A key helper is never asked
 * about and ranks above the login, so the key goes there and every competing
 * credential is removed (verified in src/live/claude-live.test.ts).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { resolveClaudeCredential } from "../credential.js";
import { allowedNative, disallowedTools } from "../native-tools.js";
import { assertRoutable, claudeModelId } from "../routing.js";
import { claudeTelemetryEnv } from "../telemetry-env.js";
import { acceptFolderTrust } from "../trust.js";
import { NONESSENTIAL_FEATURE_ENV_DEFAULTS, fillEnvDefaults } from "./env-defaults.js";

/** A name only Barry uses, so nothing else in the session mistakes it for a credential. */
export const KEY_HELPER_ENV = "BARRY_ANTHROPIC_API_KEY";

/** Printing nothing makes claude report the helper as failing; it does not fall back to the login. */
export const KEY_HELPER_COMMAND = `printf '%s' "$${KEY_HELPER_ENV}"`;

/** Credentials claude would use instead of, or ahead of, the key helper. */
export const COMPETING_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** What `barry start` passes in `SessionConfig.options`. */
interface LaunchOptions {
  mcpConfigPath?: string;
  settingsPath?: string;
  prompt?: string;
  /** Set by the directory-creating composition root, never inferred from cwd. */
  barryCreatedDirectory?: string;
}

/** The TUI launch being planned: plain guest, or instrumented with its inbox. */
export interface TuiLaunch {
  mode: "guest" | "instrumented";
  inboxSocketPath?: string;
  settings?: Record<string, unknown>;
}

function optionsOf(config: SessionConfig): LaunchOptions {
  const options = config.options;
  return options !== null && typeof options === "object" ? options : {};
}

export async function planClaudeLaunch(
  config: SessionConfig,
  guarantees: Guarantees,
  tui: TuiLaunch = { mode: "guest" },
): Promise<LaunchPlan> {
  assertRoutable(config);
  resolveClaudeCredential({ mode: tui.mode, env: config.env });
  const options = optionsOf(config);
  acceptFolderTrust(config.cwd, options.barryCreatedDirectory);
  const tmpDirs: string[] = [];
  const launchDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "barry-cc-launch-"));
    tmpDirs.push(dir);
    return dir;
  };

  let mcpConfigPath = options.mcpConfigPath;
  if (!mcpConfigPath) {
    mcpConfigPath = join(launchDir(), "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: config.mcpServers }));
  }
  const settingsPath = mergeSettings(options.settingsPath, launchDir, { ...tui.settings, apiKeyHelper: KEY_HELPER_COMMAND, permissions: { deny: disallowedTools(config).map(tool => `${tool}(*)`) } });

  const env = fillEnvDefaults({ ...config.env }, NONESSENTIAL_FEATURE_ENV_DEFAULTS);
  const key = config.endpoint?.apiKey ?? config.env.ANTHROPIC_API_KEY;
  for (const name of COMPETING_CREDENTIAL_ENV) delete env[name];
  env[KEY_HELPER_ENV] = key;
  if (config.endpoint) env.ANTHROPIC_BASE_URL = config.endpoint.baseUrl;
  // Launched from inside another Claude Code session, claude 2.1.282 saves no
  // transcript, and the transcript is what Barry captures and resumes from.
  env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = "1";
  if (config.telemetryEndpoint) {
    Object.assign(env, claudeTelemetryEnv(config.telemetryEndpoint, config.telemetryHeaders));
  }

  // Chosen here rather than by claude, so the session is linked before the
  // TUI starts and can be resumed even if it dies early.
  const harnessSessionId = config.resume?.harnessSessionId ?? randomUUID();

  const args: string[] = [
    "--dangerously-skip-permissions",
    "--tools", allowedNative(config).join(","),
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--settings",
    settingsPath,
    ...(config.systemPrompt ? ["--system-prompt", config.systemPrompt] : []),
    ...(config.model ? ["--model", claudeModelId(config.model)] : []),
  ];
  // The read-only settings rules also remove denied tools from context.
  for (const tool of disallowedTools(config)) {
    args.push("--disallowed-tools", tool);
  }
  for (const dir of config.pluginDirs ?? []) {
    args.push("--plugin-dir", dir);
  }
  // Commands in an added root keep their bare names; plugin commands get a namespace prefix.
  for (const root of config.projectRoots ?? []) {
    args.push("--add-dir", root);
  }
  if (tui.inboxSocketPath) {
    args.push("--messaging-socket-path", tui.inboxSocketPath);
  }
  if (config.resume?.harnessSessionId) {
    args.push("--resume", harnessSessionId);
  } else {
    args.push("--session-id", harnessSessionId);
  }
  if (options.prompt) {
    args.push("--", options.prompt);
  }

  return {
    command: resolveHarnessCommand(CLAUDE_REQUIREMENTS, config.env),
    args,
    env,
    tmpDirs,
    harnessSessionId,
    guarantees: { ...guarantees },
    warnings: [],
  };
}

/** Adds `settings` to the caller's settings file, creating it if needed, or to a file of this launch's own. Returns its path. */
function mergeSettings(callerPath: string | undefined, launchDir: () => string, settings: Record<string, unknown>): string {
  const path = callerPath ?? join(launchDir(), "settings.json");
  let existing: Record<string, unknown> = {};
  if (callerPath && existsSync(callerPath)) {
    const parsed = JSON.parse(readFileSync(callerPath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  }
  const permissions = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const previous = permissions(existing.permissions);
  const current = permissions(settings.permissions);
  const deny = [...new Set([...(Array.isArray(previous.deny) ? previous.deny : []), ...(Array.isArray(current.deny) ? current.deny : [])])];
  writeFileSync(path, JSON.stringify({ ...existing, ...settings, permissions: { ...previous, ...current, deny } }, null, 2));
  return path;
}
