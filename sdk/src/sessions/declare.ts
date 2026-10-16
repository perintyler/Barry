import { assessVersion, modeVersions, type VersionAssessment } from "../adapters/harnesses/versions.js";
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
  versionAssessment: VersionAssessment;
}

/**
 * An unknown build has no verification evidence. Compatibility and tested
 * guarantees are separate: a supported range does not verify every build.
 */
export function declareSession(mode: Mode, observedVersion?: string): SessionDeclaration {
  const assessment = assessVersion(modeVersions(mode), observedVersion);
  return {
    guarantees: { ...mode.guarantees },
    ...(observedVersion !== undefined ? { harnessVersion: observedVersion } : {}),
    guaranteesUnverified: !assessment.tested,
    versionAssessment: assessment,
  };
}
