/**
 * Codex, as Barry's adapter contract sees it.
 *
 * Hosted is a live `codex app-server` engine per session, and instrumented
 * attaches the `codex` TUI to it. Guest hands the terminal to the TUI on its
 * own engine in a private home. All of them run on the identity's
 * OPENAI_API_KEY or do not start.
 */
import { defineAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { CODEX_CAPABILITIES } from "./capabilities.js";
import { CODEX_GUEST, CODEX_HOSTED, CODEX_INSTRUMENTED, CODEX_REQUIREMENTS } from "./modes.js";
import { NATIVE_TOOLS, NATIVE } from "./native-tools.js";
import { codexTranscript } from "./transcript.js";

/**
 * How long an idle session keeps its engine. Starting one again costs a couple
 * of seconds on the next message; keeping every quiet session's process costs
 * memory for as long as the API runs.
 */
const RELEASE_IDLE_ENGINE_MS = 10 * 60_000;

export default defineAdapter({
  bag: ".",
  id: "codex",
  label: "Codex",
  vendor: "openai",
  requirements: CODEX_REQUIREMENTS,
  capabilities: CODEX_CAPABILITIES,
  tools: NATIVE_TOOLS,
  defaultMode: "hosted",
  modes: {
    hosted: {
      ...CODEX_HOSTED,
      native: NATIVE,
      structuredOutput: "native",
      approvalContinuation: "live",
      // Deferred so reading the declaration never loads the engine client.
      start: async (config, startEngine) => {
        const { startCodexHosted } = await import("./hosted/app-server-session.js");
        return startCodexHosted(config, startEngine, {
          guarantees: CODEX_HOSTED.guarantees,
          releaseAfterMs: RELEASE_IDLE_ENGINE_MS,
        });
      },
    },
    instrumented: {
      ...CODEX_INSTRUMENTED,
      native: { ...NATIVE, operatorOverride: "/hooks turns Barry's native-tool gate off until the next turn starts" },
      plan: async (config) => {
        const { planCodexAttach } = await import("./instrumented.js");
        return planCodexAttach(config, CODEX_INSTRUMENTED.guarantees);
      },
    },
    guest: {
      ...CODEX_GUEST,
      native: { ...NATIVE, operatorOverride: "/hooks turns Barry's native-tool gate off for the rest of the session" },
      plan: async (config) => {
        const { planCodexLaunch } = await import("./launch.js");
        return planCodexLaunch(config, CODEX_GUEST.guarantees);
      },
    },
  },
  transcript: codexTranscript,
});
