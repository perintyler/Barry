/**
 * Antigravity, as Barry's adapter contract sees it.
 *
 * Hosted is a live stateful `agy --input-format stream-json --output-format stream-json --print=""`
 * process holding the conversation across turns with real-time streaming deltas.
 * Instrumented is the interactive TUI with .agents/hooks.json for inbox delivery and tool gating.
 * Guest is the direct interactive TUI in an isolated workspace.
 */
import { defineAdapter, type LaunchMode } from "@barry-rocks/sdk/adapters/harnesses";
import { ANTIGRAVITY_REQUIREMENTS } from "./bin.js";
import { ANTIGRAVITY_CAPABILITIES } from "./capabilities.js";
import {
  EXPERIMENTAL,
  ANTIGRAVITY_GUEST,
  ANTIGRAVITY_HOSTED,
  ANTIGRAVITY_INSTRUMENTED,
} from "./modes.js";
import { NATIVE_TOOLS, NATIVE } from "./native-tools.js";
import { ANTIGRAVITY_OFFERED_MODELS, listAntigravityModels } from "./offered-models.js";
import { antigravityTranscript } from "./transcript.js";

const guest: LaunchMode = {
  ...ANTIGRAVITY_GUEST,
      native: { ...NATIVE, operatorOverride: "/hooks lets the operator turn Barry's native-tool gate off" },
  plan: async (config) => {
    const { planAntigravityLaunch } = await import("./launch.js");
    return planAntigravityLaunch(config, ANTIGRAVITY_GUEST.guarantees);
  },
};

export default defineAdapter({
  bag: ".",
  id: "antigravity",
  aliases: ["agy"],
  label: "Antigravity",
  experimental: EXPERIMENTAL,
  vendor: "google",
  requirements: ANTIGRAVITY_REQUIREMENTS,
  capabilities: ANTIGRAVITY_CAPABILITIES,
  tools: NATIVE_TOOLS,
  defaultMode: "hosted",
  offeredModels: ANTIGRAVITY_OFFERED_MODELS,
  listModels: listAntigravityModels,
  modes: {
    hosted: {
      ...ANTIGRAVITY_HOSTED,
      native: NATIVE,
      structuredOutput: "native",
      start: async (config) => {
        const { startAntigravityHosted } = await import("./hosted/stream-session.js");
        return startAntigravityHosted(config, {
          guarantees: ANTIGRAVITY_HOSTED.guarantees,
          releaseAfterMs: 10 * 60_000,
        });
      },
      adopt: (harnessSessionId, config) => {
        if (!harnessSessionId) {
          throw new Error("adopt requires the conversation id to resume; none was given");
        }
        return import("./hosted/stream-session.js").then(({ startAntigravityHosted }) =>
          startAntigravityHosted(
            { ...config, resume: { harnessSessionId } },
            { guarantees: ANTIGRAVITY_HOSTED.guarantees },
          ),
        );
      },
    },
    instrumented: {
      ...ANTIGRAVITY_INSTRUMENTED,
      native: { ...NATIVE, operatorOverride: "/hooks lets the operator turn Barry's native-tool gate off" },
      plan: async (config) => {
        const { planInstrumented } = await import("./instrumented.js");
        return planInstrumented(config, guest, ANTIGRAVITY_INSTRUMENTED.guarantees);
      },
    },
    guest,
  },
  transcript: antigravityTranscript,
});
