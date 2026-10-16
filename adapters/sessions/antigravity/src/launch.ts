import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";
import { parseModelRef } from "@barry-rocks/sdk/ids";

import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import { EXPERIMENTAL } from "./modes.js";
import { PIN_ENV, resolveAntigravityBin } from "./bin.js";
import { antigravityAuth, requireIdentityKey } from "./credential.js";
import { setupTrackingHooks } from "./hooks.js";
import { writeAntigravityWorkspace } from "./workspace.js";

export function oneShotPrompt(config: SessionConfig): string | undefined {
  const options = config.options;
  if (options === null || typeof options !== "object" || !("prompt" in options)) return undefined;
  return typeof options.prompt === "string" && options.prompt ? options.prompt : undefined;
}

export function antigravityConversationIds(workspaceDir: string): string[] {
  const brainDir = join(workspaceDir, ".gemini", "antigravity-cli", "brain");
  if (!existsSync(brainDir)) return [];
  try { return readdirSync(brainDir).filter(e => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e)); }
  catch { return []; }
}

export function discoverAntigravityConversationId(workspaceDir: string, before: readonly string[] = []): string | undefined {
  const created = antigravityConversationIds(workspaceDir).filter(id => !before.includes(id));
  return created.length === 1 ? created[0] : undefined;
}

export interface LaunchOptions {
  /** Where agy's cached sign-in lives on this Mac; tests point it at a file of their own. */
  signInPath?: string;
}

export function planAntigravityLaunch(
  config: SessionConfig,
  guarantees: Guarantees,
  options: LaunchOptions = {},
): LaunchPlan {
  if (oneShotPrompt(config)) throw new NotSupportedInMode("prompt", "guest");
  requireIdentityKey(config.env, options.signInPath);

  if (config.resume && !config.resume.harnessSessionId && (config.resume.last || config.resume.picker)) {
    throw new Error("Antigravity resume requires an exact harness session ID");
  }

  const warnings: string[] = [`Antigravity is experimental: ${EXPERIMENTAL}`];
  const bin = resolveAntigravityBin(config.env);
  const { workspaceDir } = writeAntigravityWorkspace(config, false, options.signInPath);
  const before = antigravityConversationIds(workspaceDir);

  const relayCommand = (config.options as { relayCommand?: string } | undefined)?.relayCommand;
  if (relayCommand) {
    setupTrackingHooks(workspaceDir, relayCommand);
  }

  const args: string[] = ["--dangerously-skip-permissions"];

  if (config.model) {
    const parsed = parseModelRef(config.model);
    args.push("--model", parsed?.model ?? config.model);
  }

  // Working directory as add-dir so the agent accesses the target repository
  args.push("--add-dir", config.cwd);
  if (config.projectRoots) {
    for (const root of config.projectRoots) {
      if (root !== config.cwd) {
        args.push("--add-dir", root);
      }
    }
  }

  const resumed = config.resume?.harnessSessionId;
  if (resumed) {
    args.push("--conversation", resumed);
  }

  if (config.egressSandbox) {
    args.push("--sandbox");
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.HOME = workspaceDir;
  // On the account path the key must not reach agy: a key in the env wins
  // over the sign-in, and the key's project quota is what the opt-in avoids.
  if (antigravityAuth(config.env) === "google-account") delete env.GEMINI_API_KEY;
  Object.assign(env, PIN_ENV);
  if (config.endpoint?.baseUrl) {
    env.GOOGLE_GEMINI_BASE_URL = config.endpoint.baseUrl;
  }
  if (config.endpoint?.apiKey) {
    env.GEMINI_API_KEY = config.endpoint.apiKey;
  }

  return {
    command: bin,
    args,
    env,
    cwd: workspaceDir,
    tmpDirs: [],
    ...(resumed ? { harnessSessionId: resumed } : { discoverHarnessSessionId: async () => discoverAntigravityConversationId(workspaceDir, before) }),
    guarantees: { ...guarantees },
    warnings,
  };
}
