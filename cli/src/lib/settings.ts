import { join } from "path";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { CLAUDE_HOOK_EVENTS } from "@barry-rocks/sdk/internal/hooks";
import type { ResolvedBagHook } from "@barry-rocks/sdk/bags";

/**
 * Build merged settings including hooks for session/change tracking.
 * Returns the path to the temporary settings file.
 */
export function buildMergedSettings(options?: {
  deniedTools?: readonly string[];
  path?: string;
  /** Hooks contributed by the session's bags, already resolved to commands. */
  bagHooks?: ResolvedBagHook[];
}): string {
  const settings = {
    alwaysThinkingEnabled: false,
    permissions: {
      deny: (options?.deniedTools ?? []).map((tool) => `${tool}(*)`),
    },
    // Session/change tracking is no longer hardcoded here: it moved into
    // bags/sessions's manifest (hooks:) and arrives via options.bagHooks —
    // bags/sessions is in ALWAYS_ON_BAGS, so every session still gets it.
    // No built-in hooks. File locking lives in the MCP edit tools themselves
    // (wrapEditIntent) and the native editors are denied above, so every edit
    // already routes through it. Everything else arrives via options.bagHooks.
    hooks: {} as Record<
      string,
      Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>
    >,
  };

  // Bag-declared hooks append after the built-ins, mapped from the neutral
  // event vocabulary. Lifecycle events keep matcher: "" to match the literals
  // above; tool events carry the hook's own matcher when it declares one.
  const hookMap: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>> =
    settings.hooks;
  for (const hook of options?.bagHooks ?? []) {
    const event = CLAUDE_HOOK_EVENTS[hook.event];
    (hookMap[event] ??= []).push({
      matcher: hook.matcher ?? "",
      hooks: [{ type: "command", command: hook.command, ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}) }],
    });
  }

  const settingsPath = options?.path ?? join(mkdtempSync(join(tmpdir(), "barry-")), "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return settingsPath;
}
