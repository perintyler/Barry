import type { NativeControl } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative as sdkAllowedNative, disallowedTools as sdkDisallowedTools } from "@barry-rocks/sdk/sessions";

/** Native names on the pinned build, including conditional tools. */
export const NATIVE_TOOLS: readonly string[] = [
  // PowerShell registers on every platform.
  "read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "tool_search",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
];

export const NATIVE: NativeControl = {
  controllable: [
    "bash", "powershell", "read", "grep", "find", "ls", "edit", "write",
  ],
};

export function allowedNative(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkAllowedNative(config, NATIVE_TOOLS, NATIVE);
}

export function disallowedTools(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkDisallowedTools(config, NATIVE_TOOLS, NATIVE);
}
