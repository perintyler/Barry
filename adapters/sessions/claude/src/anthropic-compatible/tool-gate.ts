import { allowedNative } from "../native-tools.js";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision, SessionConfig } from "@barry-rocks/sdk/sessions";

/** Rule once, before execution, without leaving the CLI's timeout to decide. */
export function toolGate(config: SessionConfig, outputFormat?: unknown, window = 600): HookCallbackMatcher {
  return {
    timeout: window,
    hooks: [async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const name = input.tool_name;
      const formatter = name === "StructuredOutput" && typeof outputFormat === "object" && outputFormat !== null;
      const scoped = allowedNative(config).includes(name) || (!config.deniedTools?.includes(name) && Object.keys(config.mcpServers).some(server => name.startsWith(`mcp__${server.replace(/-/g, "_")}__`)));
      let decision: PermissionDecision = { allow: formatter || scoped };
      if (scoped && !formatter && config.decide) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          decision = await Promise.race([
            Promise.resolve().then(() => config.decide!({ id: input.tool_use_id ?? "", tool: name, input: input.tool_input ?? {} })),
            new Promise<PermissionDecision>(resolve => {
              // Short windows keep a proportional margin; the default leaves three seconds.
              timer = setTimeout(() => resolve({ allow: false, reason: `no ruling within ${window}s` }), Math.max(0, window * 1000 - Math.min(3000, window * 1000 / 3)));
            }),
          ]);
        } catch {
          decision = { allow: false };
        } finally {
          clearTimeout(timer);
        }
      }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.allow ? "allow" : "deny", permissionDecisionReason: (!decision.allow ? decision.reason : undefined) ?? "Barry tools only" } };
    }],
  };
}
