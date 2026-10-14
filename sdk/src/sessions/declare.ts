/**
 * What a session records about itself when it starts.
 *
 * A snapshot, not a pointer: the adapter's table describes what a NEW session
 * would get, and stops describing a running one the moment it changes. And a
 * mode's guarantees were shown on one build — a session that observed another
 * has not been shown to have them, so it says so rather than repeating them.
 */
import type { Guarantees, Mode } from "../adapters/harnesses/index.js";

export interface SessionDeclaration {
  guarantees: Guarantees;
  harnessVersion?: string;
  guaranteesUnverified: boolean;
}

/**
 * An unknown build is not a mismatch: not every harness reports one, and
 * marking every such session unverified would make the flag meaningless.
 */
export function declareSession(mode: Mode, observedVersion?: string): SessionDeclaration {
  return {
    guarantees: { ...mode.guarantees },
    ...(observedVersion !== undefined ? { harnessVersion: observedVersion } : {}),
    guaranteesUnverified: observedVersion !== undefined && observedVersion !== mode.verifiedOn,
  };
}
