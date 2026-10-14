/**
 * What cursor can do today, and what proved it.
 *
 * Every mode runs in the session's own home (`runtime.ts`) on the identity's
 * `CURSOR_API_KEY`, with the token held in memory: cursor never sees the
 * user's login, config, hooks or MCP servers, and never writes the key's
 * token over the user's login in the keychain.
 *
 * Hosted is `cursor-agent acp` (`hosted/acp.ts`). Cursor's TUI cannot attach
 * to an engine Barry holds, so guest and instrumented are the
 * TUI itself, gated by Barry's project hooks; instrumented adds a held `stop`
 * hook that delivers Barry's inbox.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mode, Requirements } from "@barry-rocks/sdk/adapters/harnesses";

export const VERIFIED_ON = "2026.10.01";

/** The exact build Barry verified, then the current local installation. */
export function cursorAgentPaths(home = homedir()): string[] {
  return [join(home, ".local", "share", "cursor-agent", "versions", `${VERIFIED_ON}-14929f9`, "cursor-agent"), join(home, ".local", "bin", "cursor-agent")];
}

const LIVE_CHECK = "adapters/sessions/cursor/src/live/cursor-live.test.ts";

/**
 * Hosted over ACP. Every tool call the workspace's denylist lets through asks
 * Barry first; a native call is refused by that list before it asks. Capture
 * is near-total: cursor's ACP reports no token usage, and an MCP call's output
 * arrives only as `{success: true}`, though the agent itself sees the output.
 * A message arriving mid-turn waits: a second ACP prompt cancels the running
 * turn.
 */
export const CURSOR_HOSTED: Mode = {
  verifiedOn: VERIFIED_ON,
  guarantees: {
    capture: "near-total",
    delivery: "wake",
    steer: false,
    interrupt: true,
    gating: "per-call",
    keepsVendorUi: false,
    identity: "inherent",
  },
  evidence: {
    check: LIVE_CHECK,
    proves:
      "a hosted session in its own home answers on the identity's key and runs Barry's MCP tool from session/new, named for Barry's policy; a native shell call is refused by the workspace's denylist before cursor asks Barry, and never runs; the ACP session is kept in the session's home",
  },
  egressSandbox: false,
};

/**
 * The unmodified TUI. Barry learns what happened from the transcript, which
 * has no tool results, and reaches the agent when it calls a Barry tool. The
 * gate is Barry's project hooks; the person at the TUI is trusted with them.
 */
export const CURSOR_GUEST: Mode = {
  verifiedOn: VERIFIED_ON,
  guarantees: {
    capture: "post-hoc",
    delivery: "tool-call",
    steer: false,
    interrupt: false,
    gating: "hooks",
    keepsVendorUi: true,
    identity: "mcp-url",
  },
  evidence: {
    check: LIVE_CHECK,
    proves:
      "the TUI in its own home runs on the identity's key with no sign-in, runs Barry's MCP tool, has a forced native call refused, resumes the chat it reserved, and leaves its transcript where Barry finds it",
  },
  egressSandbox: false,
};

/**
 * The TUI with a held `stop` hook long-polling Barry's inbox. While it holds
 * (90 s after a turn ends), a message starts a turn as the user; later, a
 * message waits for the next turn to end, so `turn-end` is the promise. A
 * live hold tells senders `wake` itself, through its listener.
 */
export const CURSOR_INSTRUMENTED: Mode = {
  verifiedOn: VERIFIED_ON,
  // Hooks are verified to fire on macOS; on Linux nobody has seen them fire.
  platforms: ["darwin"],
  guarantees: {
    capture: "post-hoc",
    delivery: "turn-end",
    steer: false,
    interrupt: false,
    gating: "hooks",
    keepsVendorUi: true,
    identity: "hooks",
  },
  evidence: {
    check: LIVE_CHECK,
    proves:
      "the stop hook runs with the user's home, and a message that lands while it holds starts a turn in the quiet TUI, which answers it",
  },
  egressSandbox: false,
};

/** The version in `--version` output: its first capture group. Shared by doctor and the adapter. */
export const VERSION_PATTERN = "(\\d{4}\\.\\d{2}\\.\\d{2})";

export const CURSOR_REQUIREMENTS: Requirements = {
  binary: {
    command: "cursor-agent",
    paths: cursorAgentPaths(),
    versionArgs: ["--version"],
    // Cursor uses calendar versions with build suffixes rather than semantic versions.
    // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-005
    versionPattern: VERSION_PATTERN,
    install: {
      fallback: "curl https://cursor.com/install -fsS | bash",
    },
    pin: {
      version: VERIFIED_ON,
      enforcedBy: 'running the pinned build from cursor-agent\'s versions directory, with --disable-auto-update and channel "static" in the session\'s home',
    },
  },
  // Instrumented is darwin-verified; the adapter itself runs elsewhere, but
  // its declared modes do not claim to.
  platforms: ["darwin"],
};
