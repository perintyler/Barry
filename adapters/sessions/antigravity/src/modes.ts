import type { Mode } from "@barry-rocks/sdk/adapters/harnesses";

export const VERIFIED_ON = "1.3.1";
export const HOSTED_RECOMMENDED_VERSION = "1.3.6";

export const EXPERIMENTAL = "hosted evidence uses a scripted Gemini endpoint; V02–V04 have not been checked against Gemini’s real API";

export const ANTIGRAVITY_HOSTED: Mode = {
  verifiedOn: HOSTED_RECOMMENDED_VERSION,
  versions: { recommendedVersion: HOSTED_RECOMMENDED_VERSION, testedVersions: [VERIFIED_ON, HOSTED_RECOMMENDED_VERSION], supportedVersions: [{ min: VERIFIED_ON, max: HOSTED_RECOMMENDED_VERSION }] },
  guarantees: {
    capture: "total",
    delivery: "wake",
    steer: false,
    interrupt: true,
    gating: "hooks",
    keepsVendorUi: false,
    identity: "inherent",
  },
  evidence: {
    check: "adapters/sessions/antigravity/src/live/antigravity-hosted-live.test.ts; adapters/sessions/antigravity/src/hosted/stream-session.replay.test.ts; adapters/sessions/qa/run.ts --adapter antigravity --offline",
    proves:
      "the real 1.3.1 and 1.3.6 processes uses the identity key, runs a scoped MCP tool and refuses a forced shell call; a persistent home resumes its earlier history after close; schema output is parsed and interrupt ends a held turn; recorded streams replay with correlated tools; offline QA checks exact resume. Hosted checks on 1.3.1 and 1.3.6: a granted shell command executes with a valid gate, but policy-script deletion, throw and timeout each refuse the forced sentinel write; these failure injections use a local fake endpoint, not Gemini real API or a TUI",
  },
  egressSandbox: false,
};

export const ANTIGRAVITY_INSTRUMENTED: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: [VERIFIED_ON], supportedVersions: [{ min: VERIFIED_ON, max: VERIFIED_ON }] },
  guarantees: {
    capture: "post-hoc",
    delivery: "turn-end",
    steer: false,
    interrupt: false,
    gating: "hooks",
    keepsVendorUi: true,
    identity: "mcp-url",
  },
  evidence: {
    check: "adapters/sessions/antigravity/src/live/antigravity-live.test.ts",
    proves:
      "launches agy TUI with .agents/hooks.json; PreInvocation hook injects queued inbox messages with sender attribution; PreToolUse gates denied tools; barry-tracking links conversationId and transcriptPath. Pinned 1.3.1 instrumented TUI: a valid gate executes a granted shell command; deleted, throwing and timed-out policy scripts each refuse the same forced sentinel write, using the local fake model",
  },
  egressSandbox: false,
};

export const ANTIGRAVITY_GUEST: Mode = {
  verifiedOn: VERIFIED_ON,
  versions: { recommendedVersion: VERIFIED_ON, testedVersions: [VERIFIED_ON], supportedVersions: [{ min: VERIFIED_ON, max: VERIFIED_ON }] },
  guarantees: {
    capture: "post-hoc",
    delivery: "none",
    steer: false,
    interrupt: false,
    gating: "hooks",
    keepsVendorUi: true,
    identity: "mcp-url",
  },
  evidence: {
    check: "adapters/sessions/antigravity/src/live/antigravity-live.test.ts",
    proves:
      "launches agy TUI in isolated workspace with .gemini/antigravity-cli/settings.json (modelProvider: gemini), GEMINI.md/AGENTS.md instructions, .agents/mcp_config.json, tool_gate.cjs gating, and barry-tracking hooks linking conversationId and transcriptPath to Barry. Pinned 1.3.1 guest TUI: a valid gate executes a granted shell command; deleted, throwing and timed-out policy scripts each refuse the same forced sentinel write, using the local fake model",
  },
  egressSandbox: false,
};
