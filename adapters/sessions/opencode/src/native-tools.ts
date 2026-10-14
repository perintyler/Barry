import type { NativeControl } from "@barry-rocks/sdk/adapters/harnesses";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { allowedNative as sdkAllowedNative } from "@barry-rocks/sdk/sessions";

/** Native names on the pinned build, including conditional tools. */
export const NATIVE_TOOLS: readonly string[] = [
  "shell", "edit", "write", "patch", "read", "grep", "glob", "webfetch", "websearch", "subagent",
  "skill", "question", "execute",
];

export const NATIVE: NativeControl = {
  grantable: [
    "shell", "read", "grep", "glob", "edit", "write", "patch", "webfetch", "websearch",
  ],
  inseparable: [
    ["edit", "write", "patch"],
  ],
};

export function allowedNative(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools">): string[] {
  return sdkAllowedNative(config, NATIVE_TOOLS);
}
