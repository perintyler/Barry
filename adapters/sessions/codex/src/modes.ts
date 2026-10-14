/** Hosted owns the app-server engine; instrumented attaches, while guest launches its own engine.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
import type { Mode, Requirements } from "@barry-rocks/sdk/adapters/harnesses";

const VERIFIED_ON = "0.160.1";

const LIVE_CHECK = "adapters/sessions/codex/src/live/codex-live.test.ts";

export const CODEX_HOSTED: Mode = {
  verifiedOn: VERIFIED_ON,
  guarantees: {
    capture: "total",
    delivery: "wake",
    steer: true,
    interrupt: true,
    gating: "hooks",
    keepsVendorUi: false,
    identity: "inherent",
  },
  evidence: {
    check: `adapters/sessions/codex/src/hosted/app-server-session.test.ts; ${LIVE_CHECK}`,
    proves:
      "a stream recorded from a real engine (__fixtures__/app-server-0.158.0.jsonl) — plain, shell-approval, MCP-approval, structured, interrupted, steered and failed turns — ends each turn with one done after a result carrying its usage, and every request the engine made gets an answer it accepts; steer and interrupt target the running turn by its id. Live on 0.160.1: the engine sends the identity's key and never an ambient one, a session without the key is refused before an engine starts, and a bogus key is refused by the real API rather than replaced by a login. Pinned 0.160.1 hosted-engine failure injections: missing, throwing and nonterminating policy scripts deny a forced native write through the launcher while an ordinary granted write executes. Codex itself permits vendor hook errors; a missing launcher, missing Node or outer deadline remains a guard gap",
  },
  egressSandbox: false,
};

/**
 * The codex TUI on the hosted session's own engine. The session is hosted, so
 * its guarantees are, plus the vendor UI. The person at the TUI can switch
 * Barry's gate off with `/hooks`; Barry turns it back on at each turn's start,
 * so a tool called before that lands is not covered.
 */
export const CODEX_INSTRUMENTED: Mode = {
  verifiedOn: VERIFIED_ON,
  attachesTo: "hosted",
  guarantees: {
    capture: "total",
    delivery: "wake",
    steer: true,
    interrupt: true,
    gating: "hooks",
    keepsVendorUi: true,
    identity: "inherent",
  },
  evidence: {
    check: LIVE_CHECK,
    proves:
      "a codex TUI attached to a hosted session's engine resumes its thread with no turn run first, renders a turn Barry delivers, has a turn the person types reach Barry with what they typed, keeps its engine past the idle release while attached, has a forced native call refused, has Barry's gate turned back on after it is switched off, and sends the identity's key on every request. Pinned 0.160.1 instrumented TUI probes allow a granted write with a valid policy and refuse that effect with a deleted, throwing or nonterminating policy script; launcher/Node/deadline gaps remain as documented for hosted mode",
  },
  egressSandbox: false,
};

/**
 * The unmodified TUI on its own engine. Barry learns what happened from the
 * rollout afterwards. The gate is Barry's PreToolUse hook; the person at the
 * TUI can switch it off with `/hooks`, and nothing turns it back on in this
 * mode.
 */
export const CODEX_GUEST: Mode = {
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
      "a guest TUI planned by this adapter shows no sign-in, sends the identity's key on every request, carries Barry's guidance, calls Barry's tools under its own session id while a second guest uses its own, has a forced native call refused by Barry's hook, and writes the one rollout its conversation is found by; with a bogus key and the user's own codex login present, the real API refuses it rather than the login being used. Pinned 0.160.1 guest TUI probes allow a granted write with a valid policy and refuse that effect with a deleted, throwing or nonterminating policy script; a person can still disable the hook and launcher/Node/deadline gaps remain",
  },
  egressSandbox: false,
};

/** The version in `--version` output: its first capture group. Shared by doctor and the adapter. */
export const VERSION_PATTERN = "(\\d+\\.\\d+\\.\\d+)";

export const CODEX_REQUIREMENTS: Requirements = {
  binary: {
    command: "codex",
    versionArgs: ["--version"],
    // `codex --version` prints e.g. "codex-cli 0.156.1".
    versionPattern: VERSION_PATTERN,
    install: {
      darwin: "brew install codex",
      fallback: "npm install -g @openai/codex",
    },
    pin: { version: VERIFIED_ON, enforcedBy: "package-manager install; never the self-updating shared daemon (R8)" },
  },
};
