import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative } from "../native-tools.js";

/** Extensions cannot widen the native allowance, including nested calls. */
export function createPiToolGate(config: SessionConfig): ExtensionFactory {
  const prefixes = Object.keys(config.mcpServers).map(server => `mcp__${server.replace(/-/g, "_")}__`);
  return pi => {
    pi.on("tool_call", async event => {
      if ((!allowedNative(config).includes(event.toolName) && !prefixes.some(prefix => event.toolName.startsWith(prefix) && event.toolName.length > prefix.length)) || config.deniedTools?.includes(event.toolName)) return { block: true, reason: `${event.toolName} is a native or denied tool` };
      try {
        const decision = await config.decide?.({ id: event.toolCallId, tool: event.toolName, input: event.input ?? {} });
        return decision && !decision.allow ? { block: true, reason: decision.reason ?? "Denied by Barry policy" } : undefined;
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    });
  };
}
