import type { NativeControl } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative as sdkAllowedNative, disallowedTools as sdkDisallowedTools } from "@barry-rocks/sdk/sessions";

/** Native names on the pinned build, including conditional tools. */
export const NATIVE_TOOLS: readonly string[] = [
  "apply_patch", "update_plan", "view_image", "web_search", "exec_command", "write_stdin",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "request_user_input",
  "spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent", "imagegen",
  "tool_search", "get_goal", "create_goal", "update_goal", "web", "exec", "wait", "send_message",
  "followup_task", "interrupt_agent", "list_agents", "request_permissions", "sleep",
  "current_time", "get_context_remaining", "new_context", "wait_for_environment",
  "list_available_plugins_to_install", "request_plugin_install",
  "create_channel", "get_channels", "list_threads", "post", "read_post", "read_thread",
  "search_posts", "subscribe", "unsubscribe",
];

export const NATIVE: NativeControl = {
  controllable: [
    "exec_command", "write_stdin", "view_image", "apply_patch", "web_search",
  ],
};

export function allowedNative(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkAllowedNative(config, NATIVE_TOOLS);
}

export function disallowedTools(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkDisallowedTools(config, NATIVE_TOOLS);
}
