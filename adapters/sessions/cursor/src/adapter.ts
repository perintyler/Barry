/**
 * Cursor, as Barry's adapter contract sees it.
 *
 * Hosted is `cursor-agent acp`; guest hands the terminal to the cursor TUI;
 * instrumented is that TUI with a held `stop` hook that delivers Barry's
 * inbox. Every mode runs in the session's own home on the identity's
 * `CURSOR_API_KEY` (`runtime.ts`). Cursor serves only its own models and
 * connects itself, so no model is ever routed elsewhere.
 */
import { listCursorModels, resolveCursorBin } from "./bin.js";
import { defineAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { CURSOR_CAPABILITIES } from "./capabilities.js";
import { CURSOR_GUEST, CURSOR_HOSTED, CURSOR_INSTRUMENTED, CURSOR_REQUIREMENTS } from "./modes.js";
import { NATIVE_TOOLS, HOSTED_NATIVE, TUI_NATIVE } from "./native-tools.js";
import { cursorTranscript } from "./transcript.js";

export default defineAdapter({
  bag: ".",
  id: "cursor",
  label: "Cursor",
  vendor: "cursor",
  requirements: CURSOR_REQUIREMENTS,
  capabilities: CURSOR_CAPABILITIES,
  tools: NATIVE_TOOLS,
  defaultMode: "hosted",
  modes: {
    hosted: {
      ...CURSOR_HOSTED,
      native: HOSTED_NATIVE,
      structuredOutput: "prompted",
      start: async (config) => {
        const { startCursorHosted } = await import("./hosted/acp.js");
        return startCursorHosted(config, CURSOR_HOSTED);
      },
    },
    instrumented: {
      ...CURSOR_INSTRUMENTED,
      native: TUI_NATIVE,
      plan: async (config) => {
        const { planInstrumented } = await import("./instrumented.js");
        return planInstrumented(config, CURSOR_INSTRUMENTED.guarantees);
      },
    },
    guest: {
      ...CURSOR_GUEST,
      native: TUI_NATIVE,
      plan: async (config) => {
        const { planCursorLaunch } = await import("./launch.js");
        return planCursorLaunch(config, CURSOR_GUEST.guarantees);
      },
    },
  },
  transcript: cursorTranscript,
  resolveBinary: resolveCursorBin,
  listModels: async ({ env }) => listCursorModels(env),
});
