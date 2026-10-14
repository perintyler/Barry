/** What cursor itself can do, as the adapter contract asks it. */
import type { HarnessCapabilities } from "@barry-rocks/sdk/adapters/harnesses";

export const CURSOR_CAPABILITIES: HarnessCapabilities = {
  mcpTransports: ["stdio", "http"],
  // Through the session workspace's `.cursor/cli.json` permission list, which
  // cursor enforces itself: a denied call returns permissionDenied.
  toolDenial: "native",
  // Written as given into the workspace's instruction file.
  systemPromptFormat: "raw",
  skillsMount: "plugin",
  // Verified: cursor-agent documents `CURSOR_API_KEY` beside `--api-key`, so
  // a missing key is a refusal, not a fall back onto the user's own login.
  withoutKey: "unauthenticated",
  // It serves only its own models and connects itself.
  endpoint: "fixed",
};
