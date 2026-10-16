import type { NativeControl } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative as sdkAllowedNative, disallowedTools as sdkDisallowedTools } from "@barry-rocks/sdk/sessions";

/** Native names on the pinned build, including conditional tools. */
export const NATIVE_TOOLS: readonly string[] = [
  "ask_custom_permission", "ask_permission", "ask_question", "browser_click_element",
  "browser_drag_pixel_to_pixel", "browser_get_dom", "browser_get_network_request", "browser_input",
  "browser_list_network_requests", "browser_mouse_down", "browser_mouse_up", "browser_move_mouse",
  "browser_press_key", "browser_refresh_page", "browser_resize_window", "browser_scroll",
  "browser_scroll_dom", "browser_select_option", "browser_subagent",
  "capture_browser_console_logs", "capture_browser_screenshot", "click_browser_pixel",
  "command_status", "define_subagent", "delete_knowledge", "execute_browser_javascript",
  "find_by_name", "finish", "generate_image", "grep_search", "invoke_subagent",
  "list_browser_pages", "list_dir", "list_permissions", "list_resources", "manage_inbox",
  "manage_subagents", "manage_task", "multi_replace_file_content", "notebook_edit",
  "notebook_execution", "open_browser_url", "read_browser_page", "read_resource",
  "read_url_content", "replace_file_content", "run_command", "run_workflow", "schedule",
  "search_web", "sed_file", "send_command_input", "send_message", "view_file", "wait",
  "wait_5_seconds", "write_to_file", "list_plugin_accounts", "search_marketplace",
];

export const NATIVE: NativeControl = {
  controllable: [
    "run_command", "send_command_input", "command_status", "view_file", "grep_search",
    "find_by_name", "list_dir", "write_to_file", "replace_file_content",
    "multi_replace_file_content", "sed_file", "read_url_content", "search_web",
  ],
};

export function allowedNative(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkAllowedNative(config, NATIVE_TOOLS);
}

export function disallowedTools(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkDisallowedTools(config, NATIVE_TOOLS);
}
