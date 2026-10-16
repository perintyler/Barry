import type { NativeControl } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative as sdkAllowedNative, disallowedTools as sdkDisallowedTools } from "@barry-rocks/sdk/sessions";

/** Native names on the pinned build, including conditional tools. */
export const NATIVE_TOOLS: readonly string[] = [
  "Read", "Edit", "Write", "Glob", "Grep", "Shell", "Task", "WebFetch", "WebSearch", "Delete",
  "List", "Fetch", "WriteShellStdin", "SemanticSearch", "ReadLints", "GenerateImage",
  "ComputerUse", "RecordScreen", "ListMcpResources", "FetchMcpResource", "AskQuestion",
  "CreatePlan", "SwitchMode", "UpdateTodos", "ReadTodos", "ApplyAgentDiff",
];

export const HOSTED_NATIVE: NativeControl = {
  controllable: [
    "Shell", "Read", "Write", "Edit", "Delete", "WebFetch", "WebSearch",
  ],
  inseparable: [
    ["Write", "Edit", "Delete"],
  ],
  uncontrolled: {
    Grep: "cursor runs them with no permission request and no hook in ACP",
    List: "cursor runs them with no permission request and no hook in ACP",
    Glob: "cursor runs them with no permission request and no hook in ACP",
    SemanticSearch: "cursor runs them with no permission request and no hook in ACP",
    Fetch: "cursor runs Fetch with no permission check",
  },
};
export const TUI_NATIVE: NativeControl = {
  controllable: [
    "Shell", "WriteShellStdin", "Read", "Grep", "List", "Write", "Edit", "Delete", "Fetch",
  ],
  inseparable: [
    ["Write", "Edit"],
  ],
  uncontrolled: {
    WebFetch: "under --force cursor approves it; hook control is unverified",
    WebSearch: "under --force cursor approves it; hook control is unverified",
    Glob: "no hook name; unverified",
  },
};

export function allowedNative(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkAllowedNative(config, NATIVE_TOOLS);
}

export function disallowedTools(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkDisallowedTools(config, NATIVE_TOOLS);
}
