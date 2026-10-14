/**
 * What pi itself can do, as the adapter contract asks it.
 *
 * Adapter-local knowledge of pi's own surface, pinned to the SDK build the
 * hosted mode runs (`@earendil-works/pi-coding-agent` 0.99.2) and verified
 * against its exported types.
 */
import type { HarnessCapabilities } from "@barry-rocks/sdk/adapters/harnesses";

export const PI_CAPABILITIES: HarnessCapabilities = {
  // pi's MCP support speaks stdio and streamable HTTP; the legacy SSE
  // transport is rejected outright (`sse` is an invalid entry in mcp.json),
  // so it is not declared.
  mcpTransports: ["stdio", "http"],
  // `--exclude-tools` on the CLI and `excludeTools` on
  // `createAgentSession()`: a named tool can be refused before the model
  // ever sees it.
  toolDenial: "native",
  // `--append-system-prompt` on the CLI and `appendSystemPromptOverride` on
  // the SDK: Barry's guidance is appended to pi's own coding prompt rather
  // than replacing it.
  systemPromptFormat: "preset-append",
  // pi implements the Agent Skills specification (`agentskills.io`): a
  // skill directory carrying SKILL.md mounts whole.
  skillsMount: "plugin",
  // With no declared key pi has no credential at all — it does not run. The
  // user's own `~/.pi/agent/auth.json` login is a path this adapter refuses
  // to take (see credentials.ts), so it is not declared as a fallback.
  withoutKey: "unauthenticated",
  // pi connects to providers itself, naming models `provider/model` in its
  // own catalog and settings. With configurable endpoints, custom or local
  // providers (e.g. llama.cpp or Ollama) can be registered into the runtime.
  endpoint: "configurable",
};
