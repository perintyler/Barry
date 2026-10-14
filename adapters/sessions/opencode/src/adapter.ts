/**
 * OpenCode, as Barry's adapter contract sees it.
 *
 * Hosted is a Barry-owned `opencode serve` per session; guest hands the
 * terminal to the OpenCode TUI, on a private server of its own. OpenCode
 * connects to its vendors itself and names models `vendor/model`, so it has
 * no vendor of its own and Barry routes nothing.
 */
import { defineAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { OPENCODE_CAPABILITIES } from "./capabilities.js";
import { OPENCODE_GUEST, OPENCODE_HOSTED, OPENCODE_REQUIREMENTS } from "./modes.js";
import { NATIVE_TOOLS, NATIVE } from "./native-tools.js";
import { OPENCODE_OFFERED_MODELS } from "./offered-models.js";

/**
 * How long an idle session keeps its server. Starting one again costs about a
 * second on the next message; keeping every quiet session's process costs
 * memory for as long as the API runs.
 */
const RELEASE_IDLE_SERVER_MS = 10 * 60_000;

export default defineAdapter({
  bag: ".",
  id: "opencode",
  label: "OpenCode",
  offeredModels: OPENCODE_OFFERED_MODELS,
  requirements: OPENCODE_REQUIREMENTS,
  capabilities: OPENCODE_CAPABILITIES,
  nativeTools: NATIVE_TOOLS,
  defaultMode: "hosted",
  modes: {
    hosted: {
      ...OPENCODE_HOSTED,
      native: NATIVE,
      structuredOutput: "prompted",
      // Deferred so reading the declaration never loads the server client.
      start: async (config, startEngine) => {
        const { startOpenCodeHosted } = await import("./hosted/serve-session.js");
        return startOpenCodeHosted(config, startEngine, {
          guarantees: OPENCODE_HOSTED.guarantees,
          releaseAfterMs: RELEASE_IDLE_SERVER_MS,
        });
      },
    },
    instrumented: null,
    guest: {
      ...OPENCODE_GUEST,
      native: NATIVE,
      plan: async (config) => {
        const { planOpenCodeLaunch } = await import("./launch.js");
        return planOpenCodeLaunch(config, OPENCODE_GUEST.guarantees);
      },
    },
  },
});
