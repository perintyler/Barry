/**
 * What opencode can do today, and what proved it.
 *
 * Hosted runs a Barry-owned `opencode serve` per session; guest hands the
 * terminal to opencode's own TUI, on a private server of its own
 * (`--standalone`). Both run in the session's environment
 * (`server/launch-env.ts`), which is where the reasons each guarantee holds
 * are written down.
 *
 * Every guarantee below was checked against the pinned build by
 * `src/live/opencode-live.test.ts`, which drives the real binary against a
 * fake model and MCP server that record what opencode sends.
 */
import type { Mode, Requirements } from "@barry-rocks/sdk/adapters/harnesses";

// The supported v2 CLI and the older package share a binary name; inspect the resolved build.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-008
const VERIFIED_ON = "2.0.26";

const LIVE_CHECK = "adapters/sessions/opencode/src/live/opencode-live.test.ts";

export const OPENCODE_HOSTED: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: ["2.0.24", VERIFIED_ON], supportedVersions: [{ min: "2.0.24", max: VERIFIED_ON }], incompatibleVersions: [{ range: { min: "0.0.0", before: "2.0.0" }, reason: "The v1 CLI does not provide the v2 standalone/server interface this adapter drives" }] },
  guarantees: {
    capture: "total",
    delivery: "wake",
    steer: true,
    interrupt: true,
    gating: "per-call",
    // A TUI can attach to Barry's server with `--server <url> --session <id>`,
    // but nothing Barry launches does so yet: hosted does not claim to keep
    // the vendor UI until a launch attaches one.
    keepsVendorUi: false,
    identity: "inherent",
  },
  evidence: {
    check: LIVE_CHECK,
    proves:
      "a hosted session on the real server puts each call of a Barry tool to Barry under Barry's name for it and runs it once allowed, offers the model no native tool, has Barry's tools on its first turn, steers a running turn, interrupts one, and authenticates with the identity's key. the live 2.0.24 and 2.0.26 servers loads its private per-process config file. hosted/serve-session.test.ts retains the 2.0.14 recorded stream for turn/permission mapping; current live checks establish these operations on 2.0.24 and 2.0.26 without claiming a newly recorded replay",
  },
  egressSandbox: false,
};

export const OPENCODE_GUEST: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: ["2.0.24", VERIFIED_ON], supportedVersions: [{ min: "2.0.24", max: VERIFIED_ON }], incompatibleVersions: [{ range: { min: "0.0.0", before: "2.0.0" }, reason: "The v1 CLI does not provide the v2 standalone/server interface this adapter drives" }] },
  guarantees: {
    // The conversation is opencode's own, in the session's data dir; Barry
    // does not read it while it runs.
    capture: "none",
    // Barry's MCP server hands queued messages over with its next tool call.
    delivery: "tool-call",
    steer: false,
    interrupt: false,
    // Fixed at launch: native tools denied, Barry's allowed.
    gating: "static",
    keepsVendorUi: true,
    // The session id rides in the MCP server's URL.
    identity: "mcp-url",
  },
  evidence: {
    check: LIVE_CHECK,
    proves:
      "a guest TUI launched from the plan, while a background service holding another session's config is running, reaches the MCP server with its own session id only, offers the model Barry's tools and no native one, authenticates with the identity's key, loads a private per-process config file, and leaves no process behind",
  },
  egressSandbox: false,
};

/** The version in `--version` output: its first capture group. Shared by doctor and the adapter. */
export const VERSION_PATTERN = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)";

export const OPENCODE_REQUIREMENTS: Requirements = {
  binary: {
    command: "opencode",
    overrideEnv: "OPENCODE_BIN",
    versionArgs: ["--version"],
    versionPattern: VERSION_PATTERN,
    install: {
      // Recommended: the guarantees above were tested on this build. Homebrew's formula
      // trails npm.
      darwin: `npm install -g @opencode/cli@${VERIFIED_ON}`,
      fallback: `npm install -g @opencode/cli@${VERIFIED_ON}`,
    },
    recommendedVersion: VERIFIED_ON,
  },
};
