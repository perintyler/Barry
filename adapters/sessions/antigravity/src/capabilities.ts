/** What Antigravity itself can do, as Barry's adapter contract asks it. */
import type { HarnessCapabilities } from "@barry-rocks/sdk/adapters/harnesses";

export const ANTIGRAVITY_CAPABILITIES: HarnessCapabilities = {
  mcpTransports: ["stdio", "sse", "http"],
  toolDenial: "native",
  systemPromptFormat: "raw",
  skillsMount: "plugin",
  withoutKey: "unauthenticated",
  endpoint: "fixed",
};
