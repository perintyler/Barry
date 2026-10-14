/** What opencode itself can do, as the adapter contract asks it. */
import type { HarnessCapabilities } from "@barry-rocks/sdk/adapters/harnesses";

export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  mcpTransports: ["stdio", "http", "sse"],
  // Its config's permission rules deny a tool by name, and a denied tool is
  // not offered to the model at all (verified on 2.0.24). Both modes set them.
  toolDenial: "native",
  systemPromptFormat: "unsupported",
  skillsMount: "none",
  withoutKey: "unauthenticated",
  // It connects itself: its models are named vendor/model in its own config,
  // so there is no endpoint for Barry to point it at.
  endpoint: "fixed",
};
