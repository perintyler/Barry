/** What codex itself can do, as the adapter contract asks it. */
import type { HarnessCapabilities } from "@barry-rocks/sdk/adapters/harnesses";

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  mcpTransports: ["stdio", "http"],
  // The CLI has no flag that refuses a named tool. A hosted session gates
  // each call instead: the app-server asks, and Barry answers.
  toolDenial: "native",
  // It takes no system prompt, so the content rides on the prompt instead.
  systemPromptFormat: "raw",
  skillsMount: "none",
  withoutKey: "unauthenticated",
  // Configurable URLs must serve Responses; chat-only endpoints are unsupported
  // by the pinned vendor. A provider block alone does not prove backend compatibility.
  endpoint: "configurable",
};
