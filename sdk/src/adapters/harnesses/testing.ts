/**
 * A complete, conforming adapter for tests that need one and have no opinion
 * about most of it.
 *
 * The fiction lives here, once, and says it is fiction — rather than each test
 * inventing plausible guarantees that nothing ever checks.
 */
import type { Adapter, Guarantees, LaunchMode, SessionMode } from "./index.js";

const GUEST_GUARANTEES: Guarantees = {
  capture: "post-hoc",
  delivery: "tool-call",
  steer: false,
  interrupt: false,
  gating: "static",
  keepsVendorUi: true,
  identity: "none",
};

const GUEST: LaunchMode = {
  guarantees: GUEST_GUARANTEES,
  verifiedOn: "0.0.0-test",
  evidence: { check: "none (test fixture)", proves: "nothing; this adapter is a fixture" },
  egressSandbox: false,
  plan: async (config) => ({
    command: "true",
    args: [],
    env: config.env,
    tmpDirs: [],
    guarantees: GUEST_GUARANTEES,
    warnings: [],
  }),
};

/** A hosted mode around `start`, with the same fixture guarantees. */
export function testSessionMode(start: SessionMode["start"]): SessionMode {
  return {
    guarantees: GUEST_GUARANTEES,
    verifiedOn: "0.0.0-test",
    evidence: { check: "none (test fixture)", proves: "nothing; this mode is a fixture" },
    egressSandbox: false,
    structuredOutput: "prompted",
    start,
  };
}

export function testAdapter(overrides: Partial<Adapter> = {}): Adapter {
  const inventory = overrides.tools ?? [];
  return {
    id: "test-harness",
    label: "Test harness",
    requirements: {
      binary: {
        command: "true",
        versionArgs: ["--version"],
        versionPattern: "(\\d+\\.\\d+\\.\\d+(?:-test)?)",
        install: { fallback: "this harness is a test fixture; there is nothing to install" },
        pin: { version: "0.0.0-test", enforcedBy: "none (test fixture)" },
      },
    },
    capabilities: {
      mcpTransports: ["stdio"],
      toolDenial: "none",
      systemPromptFormat: "unsupported",
      skillsMount: "none",
      withoutKey: "unauthenticated",
      endpoint: "fixed",
    },
    tools: inventory,
    defaultMode: "guest",
    modes: { hosted: null, instrumented: null, guest: GUEST },
    ...overrides,
  };
}
