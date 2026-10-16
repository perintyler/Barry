/**
 * What pi can do today, and what proved it.
 *
 * One mode: hosted. Barry runs the pi SDK (`@earendil-works/pi-coding-agent`)
 * in-process — the claude live pattern, on pi's own package — with Barry as the
 * only client of the session. The TUI tiers are refused: a pi TUI
 * authenticates with the user's own `~/.pi/agent/auth.json` login
 * (`pi` then `/login`), which is outside the identity's declared sources, and
 * nothing Barry can launch changes that.
 *
 * Hosted keeps the user's own pi conventions where they are not credentials:
 * sessions persist in the user's own pi session directory (resumable from
 * `pi --resume` exactly like a TUI conversation), and the agent dir is never
 * redirected (— no `PI_CODING_AGENT_DIR` games). What is never
 * read is the credential store: the runtime Barry builds resolves keys from
 * the identity's environment alone (see credentials.ts).
 */
import type { Mode, Requirements } from "@barry-rocks/sdk/adapters/harnesses";

/**
 * The build hosted sessions run: the pinned SDK package, in-process — not the
 * `pi` binary on PATH. The binary requirement still names `pi` because
 * `barry doctor` and `listModels` run it, but a hosted session's guarantees
 * were verified against this package.
 */
export const VERIFIED_ON = "0.99.2";

export const PI_HOSTED: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: [VERIFIED_ON], supportedVersions: [{ min: VERIFIED_ON, max: VERIFIED_ON }] },
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
    check:
      "adapters/sessions/pi/src/hosted/sdk-session.test.ts; adapters/sessions/pi/src/event-mapping.test.ts; adapters/sessions/pi/src/credentials.test.ts",
    proves:
      "over a fake of the SDK surface the pinned package exports (subscribe events, prompt/steer/abort, the tool_call veto): plain, tool-calling and interrupted turns each end with exactly one done after a result carrying its usage; a message steered into a running turn is answered in it, which still ends once; every tool call — a nested one included — is put to the session's ruling and a refused one does not run; a ruling that fails refuses; the credential floor names the env var to declare and never reads auth.json or models.json",
  },
  egressSandbox: false,
};

/** The version in `--version` output: its first capture group. Shared by doctor and the adapter. */
export const VERSION_PATTERN = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)";

export const PI_REQUIREMENTS: Requirements = {
  binary: {
    command: "pi",
    overrideEnv: "PI_BIN",
    versionArgs: ["--version"],
    versionPattern: VERSION_PATTERN,
    install: {
      darwin: "curl -fsSL https://pi.dev/install.sh | sh",
      fallback: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    },
    // A hosted session runs the adapter's pinned SDK dependency in-process,
    // not the binary — the dependency in this package's package.json is the
    // mechanism that holds the pin, and the binary cannot replace it. The
    // binary itself only updates when someone runs the manual `pi update`.
    recommendedVersion: VERIFIED_ON,
  },
};
