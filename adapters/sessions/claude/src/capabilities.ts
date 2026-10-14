/** What claude itself can do, as the adapter contract asks it. */
import type { HarnessCapabilities } from "@barry-rocks/sdk/adapters/harnesses";

export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  mcpTransports: ["stdio", "http", "sse"],
  // `--disallowed-tools` on the TUI and `disallowedTools` on the SDK.
  toolDenial: "native",
  // Appended to Claude Code's own prompt rather than replacing it.
  systemPromptFormat: "preset-append",
  skillsMount: "plugin",
  // claude itself would fall back to the user's own login. Barry never lets
  // it: a session without the identity's key does not start, in any mode.
  withoutKey: "unauthenticated",
  // ANTHROPIC_BASE_URL: how a z.ai or Ollama model runs on it.
  endpoint: "configurable",
};
