/** Require physical-memory headroom for a local summary model; swap cannot hold wired pages. */
export const DEFAULT_MIN_FREE_BYTES = 6 * 1024 * 1024 * 1024;

/**
 * Shortest gap between two summaries anywhere in the process. Each one costs a
 * cold model load, and the loads are what hurt; 5 minutes keeps the steady
 * state near zero resident without making a summary feel stale.
 */
export const DEFAULT_MIN_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

export type SummaryRefusal = "insufficient-memory" | "too-soon" | "already-running";

export interface AdmissionState {
  /** Free memory right now, in bytes. */
  freeBytes: number;
  /** When the last summary finished, or null if none has in this process. */
  lastSummaryAt: Date | null;
  /** Now. Passed in so the decision is testable without waiting. */
  now: Date;
  /** True while another summary holds the slot. */
  inFlight: boolean;
}

export interface AdmissionLimits {
  minFreeBytes?: number;
  minIntervalMs?: number;
}

/**
 * The reason a summary may not run, or null when it may.
 *
 * Returns a reason rather than a boolean so the caller can log WHICH limit
 * bound -- a guard that only says "no" gives an operator nothing to act on,
 * and cannot be distinguished from one that says "no" unconditionally.
 */
export function refuseSummary(
  state: AdmissionState,
  limits: AdmissionLimits = {},
): SummaryRefusal | null {
  const minFreeBytes = limits.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const minIntervalMs = limits.minIntervalMs ?? DEFAULT_MIN_SUMMARY_INTERVAL_MS;

  // Concurrency first: two summaries mean two 5 GB loads, which is the case
  // that took the machine down. Many sessions each falling quiet on their own
  // 15-minute timer land continuously once enough sessions exist, so the
  // per-session debounce in scheduleSessionSummary does not bound this.
  if (state.inFlight) return "already-running";

  if (state.freeBytes < minFreeBytes) return "insufficient-memory";

  if (state.lastSummaryAt) {
    const elapsedMs = state.now.getTime() - state.lastSummaryAt.getTime();
    // A clock that jumped backwards leaves elapsed negative, which must read as
    // "too soon" rather than sailing past the check on a negative number.
    if (elapsedMs < minIntervalMs) return "too-soon";
  }

  return null;
}
