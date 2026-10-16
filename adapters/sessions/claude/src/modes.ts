/**
 * What claude can do today, and what proved it.
 *
 * Claude is the one adapter where "the user keeps the vendor TUI" and "Barry
 * holds the handle" are mutually exclusive: the interactive TUI has no engine
 * Barry can attach to (— a direct-connect client exists in the
 * binary but is switched off in `main()`). So hosted runs without the vendor
 * TUI, and the TUI modes run without interrupt or per-call gating.
 */

import type { Mode, Requirements } from "@barry-rocks/sdk/adapters/harnesses";

/** The build every guarantee below was verified against. */
const VERIFIED_ON = "2.1.282";

/**
 * The build hosted sessions run: the CLI bundled in the pinned Agent SDK
 * (0.3.282), not the `claude` on PATH. A session reports it from the SDK's init.
 */
export const SDK_BUNDLED_BUILD = "2.1.282";

/** Hosted, live: one streaming query across turns, on a key or the barry's opt-in. */
export const CLAUDE_LIVE: Mode = {
  verifiedOn: SDK_BUNDLED_BUILD,
  versions: { recommendedVersion: SDK_BUNDLED_BUILD, testedVersions: [SDK_BUNDLED_BUILD], supportedVersions: [{ min: SDK_BUNDLED_BUILD, max: SDK_BUNDLED_BUILD }] },
  build: "bundled",
  guarantees: {
    capture: "total",
    delivery: "wake",
    steer: true,
    interrupt: true,
    gating: "per-call",
    keepsVendorUi: false,
    identity: "inherent",
  },
  evidence: {
    check: "adapters/sessions/claude/src/live/claude-hosted-live.test.ts; adapters/sessions/claude/src/hosted/live-session.replay.test.ts; adapters/sessions/qa/run.ts --adapter claude --offline",
    proves:
      "the bundled build remembers, steers and interrupts across turns; adopt resumes it; the shared hook refuses native calls, reviewed refusals and unanswered calls before its deadline; recorded messages replay with correlated tool results and one done per turn; offline QA checks tools and exact resume",
  },
  egressSandbox: true,
};

const LIVE_CHECK = "adapters/sessions/claude/src/live/claude-live.test.ts";

const PINNED_TO_KEY =
  "authenticates with the identity's key on every request without asking about it, is offered Barry's tools and no native one, and runs under the conversation id Barry reserved; with a bogus key and the user's own /login present, the real API refuses it rather than the login being used";

/** The guest TUI plus an inbox socket for delivery and OpenTelemetry for capture. */
export const CLAUDE_INSTRUMENTED: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: [VERIFIED_ON], supportedVersions: [{ min: VERIFIED_ON, max: VERIFIED_ON }] },
  guarantees: {
    // Not total: telemetry truncates bodies at 60 KB and redacts thinking.
    capture: "near-total",
    // claude presents an injected message as mail from another Claude session, not from the user.
    delivery: "wake-peer-framed",
    steer: false,
    interrupt: false,
    gating: "static",
    keepsVendorUi: true,
    identity: "mcp-url",
  },
  evidence: {
    check: LIVE_CHECK,
    proves: `an instrumented TUI ${PINNED_TO_KEY}, and is woken while idle by a message on its inbox socket. It shares the user's ~/.claude configuration and has no Barry PreToolUse policy hook: native inventory and denial settings are static restrictions, not per-call authorization`,
  },
  egressSandbox: false,
};

/** The unmodified TUI. Barry learns what happened from its transcript afterwards. */
export const CLAUDE_GUEST: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: [VERIFIED_ON], supportedVersions: [{ min: VERIFIED_ON, max: VERIFIED_ON }] },
  guarantees: {
    capture: "post-hoc",
    delivery: "tool-call",
    steer: false,
    interrupt: false,
    gating: "static",
    keepsVendorUi: true,
    identity: "mcp-url",
  },
  evidence: {
    check: LIVE_CHECK,
    proves: `a guest TUI ${PINNED_TO_KEY}, and writes its transcript there. It shares the user's ~/.claude configuration and has no Barry PreToolUse policy hook: native inventory and denial settings are static restrictions, not per-call authorization`,
  },
  egressSandbox: false,
};

/**
 * What an API session on claude actually gets today.
 *
 * `createSession` runs one Agent SDK `query()` per turn, resumed by id. Barry
 * reads every event of each turn and can abort it, and a message that arrives
 * mid-turn waits for the next one. The same PreToolUse hook rules each call
 * on this path.
 */
export const CLAUDE_PER_TURN: Mode = {
  verifiedOn: SDK_BUNDLED_BUILD,
  versions: { recommendedVersion: SDK_BUNDLED_BUILD, testedVersions: [SDK_BUNDLED_BUILD], supportedVersions: [{ min: SDK_BUNDLED_BUILD, max: SDK_BUNDLED_BUILD }] },
  build: "bundled",
  guarantees: {
    capture: "total",
    delivery: "wake",
    steer: false,
    interrupt: true,
    gating: "per-call",
    keepsVendorUi: false,
    identity: "inherent",
  },
  evidence: {
    check: "adapters/sessions/claude/src/session-golden.test.ts",
    proves:
      "each turn is one query() with the session's disallowedTools and a resume id, and every event of the turn reaches Barry",
  },
  egressSandbox: true,
};

/** The version in `--version` output: its first capture group. Shared by doctor and the new adapter. */
export const VERSION_PATTERN = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)";

export const CLAUDE_REQUIREMENTS: Requirements = {
  binary: {
    command: "claude",
    overrideEnv: "CLAUDE_CODE_BIN",
    versionArgs: ["--version"],
    // Parse the vendor version within the full CLI output rather than anchoring to a bare version string.
    // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-003
    versionPattern: VERSION_PATTERN,
    install: {
      darwin: "brew install --cask claude-code",
      fallback: "see https://code.claude.com/docs for your platform",
    },
    recommendedVersion: VERIFIED_ON,
  },
};
