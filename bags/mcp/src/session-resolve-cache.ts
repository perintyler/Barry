/** Reuse resolution only while fresh and derived from the current session traits, collapsing concurrent requests into one promise; see docs/decisions/0013-session-store-and-mcp-admission.md. */

/** How long a SETTLED resolution may be reused, absent a trait change. */
export const SESSION_RESOLVE_TTL_MS = 10_000;

/** Use a separate generous deadline for pending resolutions so slow work stays single-flight without pinning genuinely abandoned entries forever; see docs/decisions/0013-session-store-and-mcp-admission.md. */
export const SESSION_RESOLVE_PENDING_DEADLINE_MS = 10 * 60_000;

/** What a cache entry must remember for `isCacheEntryUsable` to judge it. */
export interface CacheEntryStamp {
  /** When the entry was created (ms epoch) — the pending-deadline clock. */
  at: number;
  /**
   * When the promise settled (ms epoch), or `null` while still pending. The
   * settled TTL (`SESSION_RESOLVE_TTL_MS`) is measured from here, not from
   * `at` — see `SESSION_RESOLVE_PENDING_DEADLINE_MS` for why the two clocks
   * must be separate.
   */
  settledAt: number | null;
  /** The session's traits at creation time, via `traitKeyOf`. */
  traitKey: string;
}

/**
 * A comparable stamp of a session's trait set.
 *
 * Order-insensitive, because the trait list's order is not meaningful and a
 * reordering must not force a needless re-resolve. The separator is escaped so
 * `["a,b"]` and `["a","b"]` cannot collide into the same key — trait names are
 * validated elsewhere, but a cache that silently conflates two different grants
 * is exactly the class of bug this file exists to prevent.
 */
export function traitKeyOf(traits: readonly string[] | null | undefined): string {
  if (!traits || traits.length === 0) return "";
  return [...traits]
    .map((t) => t.replace(/\\/g, "\\\\").replace(/,/g, "\\,"))
    .sort()
    .join(",");
}

/**
 * Whether a cached resolution may be reused.
 *
 * Deliberately total: a missing entry is not usable, so callers need no
 * separate null check and cannot forget one.
 *
 * Two different clocks depending on whether the entry has settled yet (astra
 * review F10): a PENDING entry (`settledAt === null`) is checked against the
 * generous `SESSION_RESOLVE_PENDING_DEADLINE_MS`, measured from `at` (its
 * creation) — a caller awaiting `entry.promise` should keep waiting on the
 * SAME in-flight resolution rather than starting a duplicate one just because
 * 10s of wall-clock passed while it was still legitimately working. A SETTLED
 * entry is checked against the short `SESSION_RESOLVE_TTL_MS`, measured from
 * `settledAt` — once the answer is known, staleness is what matters (bag
 * auth, credential expiry), and that clock should start counting only once
 * there IS an answer to go stale.
 */
export function isCacheEntryUsable(
  entry: CacheEntryStamp | undefined,
  now: number,
  currentTraitKey: string,
): boolean {
  if (!entry) return false;
  if (entry.traitKey !== currentTraitKey) return false;
  if (entry.settledAt === null) return now - entry.at < SESSION_RESOLVE_PENDING_DEADLINE_MS;
  return now - entry.settledAt < SESSION_RESOLVE_TTL_MS;
}
