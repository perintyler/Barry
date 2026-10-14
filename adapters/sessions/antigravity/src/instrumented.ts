import type { Guarantees, LaunchMode, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative, disallowedTools } from "./native-tools.js";
import { createInstrumentedHooks } from "./hooks.js";
import { oneShotPrompt, planAntigravityLaunch } from "./launch.js";

export async function planInstrumented(
  config: SessionConfig,
  _guest: LaunchMode,
  guarantees: Guarantees,
): Promise<LaunchPlan> {
  if (oneShotPrompt(config)) throw new NotSupportedInMode("prompt", "instrumented");
  const relay = (config.options as { relayCommand?: string } | undefined)?.relayCommand;
  if (!relay) throw new Error("Antigravity instrumented mode requires a Barry tracking relay");

  const plan = planAntigravityLaunch(config, guarantees);
  const hooks = createInstrumentedHooks();

  if (plan.cwd) {
    hooks.setup(plan.cwd, disallowedTools(config), Object.keys(config.mcpServers ?? {}), allowedNative(config));
  }

  return {
    ...plan,
    guarantees: { ...guarantees },
    inbox: hooks.inbox,
  };
}
