/**
 * Claude Code, as Barry's adapter contract sees it.
 *
 * Hosted runs one streaming Agent SDK query across turns when it can and one
 * query per turn otherwise. Guest hands the terminal to the `claude` TUI, and
 * instrumented is that TUI with an inbox socket and telemetry. Every mode runs
 * on the identity's ANTHROPIC_API_KEY or does not start.
 *
 * "claude" was this harness's id until 2026-09; sessions, identities, flags
 * and the API's provider field still carry it, and it resolves here.
 */
import { defineAdapter, type StartEngine } from "@barry-rocks/sdk/adapters/harnesses";
import { envMs } from "@barry-rocks/sdk/sessions";
import type { Session, SessionConfig } from "@barry-rocks/sdk/sessions";
import { CLAUDE_CAPABILITIES } from "./capabilities.js";
import { resolveClaudeCredential } from "./credential.js";
import { CLAUDE_GUEST, CLAUDE_INSTRUMENTED, CLAUDE_LIVE, CLAUDE_PER_TURN, CLAUDE_REQUIREMENTS } from "./modes.js";
import { NATIVE_TOOLS, NATIVE } from "./native-tools.js";
import { assertRoutable } from "./routing.js";
import { claudeTranscript } from "./transcript.js";

/** How long an idle live session keeps its process; the next delivery resumes the conversation. */
const RELEASE_IDLE_PROCESS_MS = envMs("BARRY_CLAUDE_IDLE_RELEASE_MS",30*60_000);

/**
 * Live where the session may, per turn where it may not. A one-turn session
 * gains nothing from a live query, so it stays on the per-turn path.
 */
async function startHosted(config: SessionConfig, _startEngine: StartEngine): Promise<Session> {
  assertRoutable(config);
  // The adapter-side floor. The session gate has already refused a session
  // whose ANTHROPIC_API_KEY has no definition; this catch is for a session
  // that reached the adapter with the key stripped from its env — stripped
  // means undeclared, and undeclared means no session.
  resolveClaudeCredential({ mode: "hosted", env: config.env });
  if (config.ephemeral) {
    const { startClaudePerTurn } = await import("./anthropic-compatible/sdk-impl.js");
    return startClaudePerTurn(config, CLAUDE_PER_TURN.guarantees);
  }
  const { startClaudeLive } = await import("./hosted/start.js");
  return startClaudeLive(config, { guarantees: { ...CLAUDE_LIVE.guarantees }, releaseAfterMs: RELEASE_IDLE_PROCESS_MS });
}

/** Claude runs no engine process; an adopted session is started without one. */
function noEngine(): never {
  throw new Error("claude hosted runs no engine process");
}

export default defineAdapter({
  bag: ".",
  id: "claude-code",
  aliases: ["claude"],
  label: "Claude Code",
  vendor: "anthropic",
  requirements: CLAUDE_REQUIREMENTS,
  capabilities: CLAUDE_CAPABILITIES,
  tools: NATIVE_TOOLS,
  defaultMode: "hosted",
  modes: {
    // Declared as the floor, what every session gets; a live one reports the
    // stronger guarantees it has, and the record keeps what ran.
    hosted: {
      ...CLAUDE_PER_TURN,
      native: NATIVE,
      structuredOutput: "native",
      approvalContinuation: "live",
      evidence: {
        check: "adapters/sessions/claude/src/live/claude-hosted-live.test.ts; adapters/sessions/claude/src/hosted/live-session.replay.test.ts; adapters/sessions/qa/run.ts --adapter claude --offline",
        proves:
          "the bundled build uses one shared fail-closed hook in live and per-turn sessions; live remembers, steers, interrupts and adopts; recorded messages replay with correlated results; offline QA checks authorized tools, native refusals and exact resume",
      },
      start: startHosted,
      // The SDK resumes a conversation Barry did not start: the TUI's becomes this session's.
      adopt: (harnessSessionId, config) => {
        if (!harnessSessionId) throw new Error("adopt needs the claude conversation id to continue; none was given");
        return startHosted({ ...config, resume: { harnessSessionId } }, noEngine);
      },
    },
    instrumented: {
      ...CLAUDE_INSTRUMENTED,
      native: NATIVE,
      plan: async (config) => {
        const { planInstrumented } = await import("./instrumented.js");
        return planInstrumented(config, { instrumented: CLAUDE_INSTRUMENTED.guarantees, guest: CLAUDE_GUEST.guarantees });
      },
    },
    guest: {
      ...CLAUDE_GUEST,
      native: NATIVE,
      plan: async (config) => {
        const { planClaudeLaunch } = await import("./anthropic-compatible/launch.js");
        return planClaudeLaunch(config, CLAUDE_GUEST.guarantees);
      },
    },
  },
  transcript: claudeTranscript,
});
