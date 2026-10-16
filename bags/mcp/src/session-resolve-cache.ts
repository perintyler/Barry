/** Reuse resolution only while fresh and derived from the current session selection, collapsing concurrent requests into one promise; see docs/decisions/0013-session-store-and-mcp-admission.md. */
import type { Bound } from "@barry-rocks/sdk/bounds";

/** How long a SETTLED resolution may be reused, absent a selection change. */
export const SESSION_RESOLVE_TTL_MS = 10_000;

/** Use a separate generous deadline for pending resolutions so slow work stays single-flight without pinning genuinely abandoned entries forever; see docs/decisions/0013-session-store-and-mcp-admission.md. */
export const SESSION_RESOLVE_PENDING_DEADLINE_MS = 10 * 60_000;

export interface SessionSelectionLike {
  bags?: readonly string[] | null;
  bounds?: readonly string[] | null;
  bound?: (Bound & Record<string, unknown>) | Bound | Record<string, unknown> | null;
}

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
  /** The session's bags and bounds at creation time, via `selectionKeyOf`. */
  selectionKey: string;
}

function escapeList(items: readonly string[] | null | undefined): string {
  if (!items || items.length === 0) return "";
  return [...items]
    .map((item) => item.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/\|/g, "\\|"))
    .sort()
    .join(",");
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    if (keys.length === 0) return "";
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A comparable stamp of a session's bag and bound selection.
 *
 * Order-insensitive over `bags` and `bounds`, because list order is not
 * meaningful and a reordering must not force a needless re-resolve. The
 * separator is escaped so `["a,b"]` and `["a","b"]` cannot collide into the
 * same key, and the pinned `bound` JSON is canonicalized so `session.update({ bounds })`
 * or `barry start` writes immediately invalidate an earlier resolution.
 */
export function selectionKeyOf(
  session: SessionSelectionLike | readonly string[] | null | undefined,
): string {
  if (!session) return "";
  if (Array.isArray(session)) {
    return escapeList(session);
  }
  const sel = session as SessionSelectionLike;
  const bagsKey = escapeList(sel.bags);
  const boundsKey = escapeList(sel.bounds);
  const boundKey = canonicalJson(sel.bound);
  if (!bagsKey && !boundsKey && !boundKey) return "";
  return `${bagsKey}|${boundsKey}|${boundKey}`;
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
  currentSelectionKey: string,
): boolean {
  if (!entry) return false;
  if (entry.selectionKey !== currentSelectionKey) return false;
  if (entry.settledAt === null) return now - entry.at < SESSION_RESOLVE_PENDING_DEADLINE_MS;
  return now - entry.settledAt < SESSION_RESOLVE_TTL_MS;
}
