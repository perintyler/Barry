/** Explicit semantic/calendar ranges: inclusive min/max, exclusive before. */
export interface VersionRange { min?: string; max?: string; before?: string }
export interface VersionPolicy {
  recommendedVersion: string;
  testedVersions: readonly string[];
  supportedVersions: readonly VersionRange[];
  incompatibleVersions?: readonly { range: VersionRange; reason: string }[];
}
export interface VersionAssessment {
  status: "supported" | "untested" | "unknown" | "incompatible";
  recommendedVersion: string;
  observedVersion?: string;
  tested: boolean;
  reason?: string;
}

function parsed(value: string): { numbers: number[]; pre: string[]; calendar: boolean } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return null;
  const calendar = match[1]!.length === 4;
  if (calendar) {
    const [year, month, day] = numbers;
    const date = new Date(Date.UTC(year!, month! - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month! - 1 || date.getUTCDate() !== day) return null;
  }
  return { numbers, pre: match[4]?.split(".") ?? [], calendar };
}
/** Bundled/custom runtimes may identify a build by a hash or opaque release label. */
function opaque(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && !/^\d+\.\d+\.\d+/.test(value);
}
function identifier(value: string): boolean { return parsed(value) !== null || opaque(value); }
/** Calendar build suffixes identify builds on the same date; they have no ordering. */
export function compareVersions(a: string, b: string): number | null {
  const x = parsed(a), y = parsed(b);
  if (!x || !y) return a === b && opaque(a) ? 0 : null;
  if (x.calendar !== y.calendar) return null;
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i]! < y.numbers[i]! ? -1 : 1;
  if (x.calendar) return 0;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i], right = y.pre[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) return Number(left) < Number(right) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}
function within(version: string, range: VersionRange): boolean {
  if (compareVersions(version, version) === null) return false;
  const min = range.min === undefined ? 1 : compareVersions(version, range.min);
  const max = range.max === undefined ? -1 : compareVersions(version, range.max);
  const before = range.before === undefined ? -1 : compareVersions(version, range.before);
  return min !== null && max !== null && before !== null && min >= 0 && max <= 0 && before < 0;
}
export function validVersionPolicy(policy: VersionPolicy): boolean {
  if (!policy || !Array.isArray(policy.testedVersions) || !Array.isArray(policy.supportedVersions)
    || policy.incompatibleVersions !== undefined && !Array.isArray(policy.incompatibleVersions)) return false;
  const ranges = [...policy.supportedVersions, ...policy.incompatibleVersions?.map(entry => entry.range) ?? []];
  return identifier(policy.recommendedVersion) && policy.testedVersions.every(identifier)
    && ranges.every(range => range && Boolean(range.min || range.max || range.before) && (!range.min || identifier(range.min))
      && (!range.max || identifier(range.max)) && (!range.before || parsed(range.before) !== null)
      && (!range.min || !opaque(range.min) || range.min === range.max && !range.before)
      && (!range.max || !opaque(range.max) || range.min === range.max && !range.before)
      && (!range.min || !range.before || (compareVersions(range.min, range.before) ?? 1) < 0) && (!range.min || !range.max || (compareVersions(range.min, range.max) ?? 1) <= 0))
    && (policy.incompatibleVersions ?? []).every(entry => typeof entry.reason === "string" && entry.reason.trim().length > 0);
}
/** Legacy evidence establishes one tested build, never an inferred major/minor range. */
export function modeVersions(mode: { verifiedOn: string; versions?: VersionPolicy }): VersionPolicy {
  return mode.versions ?? { recommendedVersion: mode.verifiedOn, testedVersions: [mode.verifiedOn], supportedVersions: [{ min: mode.verifiedOn, max: mode.verifiedOn }] };
}
export function assessVersion(policy: VersionPolicy, observedVersion?: string): VersionAssessment {
  const base = { recommendedVersion: policy.recommendedVersion, ...(observedVersion ? { observedVersion } : {}), tested: observedVersion !== undefined && policy.testedVersions.includes(observedVersion) };
  const recognizedOpaque = observedVersion && opaque(observedVersion) && (base.tested || observedVersion === policy.recommendedVersion || [...policy.supportedVersions, ...policy.incompatibleVersions?.map(entry => entry.range) ?? []].some(range => range.min === observedVersion && range.max === observedVersion));
  if (!observedVersion || compareVersions(observedVersion, observedVersion) === null || opaque(observedVersion) && !recognizedOpaque) return { ...base, tested: false, status: "unknown", reason: "could not establish the runtime version" };
  const incompatible = policy.incompatibleVersions?.find(entry => within(observedVersion, entry.range));
  if (incompatible) return { ...base, tested: false, status: "incompatible", reason: incompatible.reason };
  return { ...base, status: policy.supportedVersions.some(range => within(observedVersion, range)) ? "supported" : "untested" };
}

/** A notice is carried with each session/launch, even when process logging is deduplicated. */
export function versionNotice(adapterId: string, result: VersionAssessment): string | undefined {
  if (result.status === "supported") return undefined;
  return `${adapterId}: ${result.observedVersion ?? "unknown version"}; recommended ${result.recommendedVersion}; ${result.reason ?? "outside established support; compatibility and guarantees have not been verified"}`;
}
