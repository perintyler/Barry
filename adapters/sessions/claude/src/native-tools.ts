import type { NativeControl } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative as sdkAllowedNative, disallowedTools as sdkDisallowedTools } from "@barry-rocks/sdk/sessions";

/** Native names on the pinned build, including conditional tools. */
export const NATIVE_TOOLS: readonly string[] = [
  "Read", "Write", "Edit", "Glob", "Grep", "Bash", "NotebookEdit", "TodoWrite", "WebFetch",
  "WebSearch", "AskUserQuestion", "Agent", "ToolSearch", "EnterWorktree", "ExitWorktree",
  "EnterPlanMode", "ExitPlanMode", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList",
  "TaskGet", "TaskStop", "Skill", "SendUserMessage", "CronCreate", "CronDelete", "CronList",
  "ListAgents", "ReportFindings", "ScheduleWakeup", "Workflow", "PowerShell", "Monitor", "LSP",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "WaitForMcpServers",
  "RefreshMcpTools",
];

export const NATIVE: NativeControl = {
  controllable: [
    "Bash", "Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch",
  ],
};

export function allowedNative(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkAllowedNative(config, NATIVE_TOOLS);
}

export function disallowedTools(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkDisallowedTools(config, NATIVE_TOOLS);
}
