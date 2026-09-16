import Foundation

/// Pure rules for `MessagesState.pollForNew`'s catch-up loop.
///
/// astra review F14: `pollForNew` fetched at most 10 messages every 5s tick.
/// A session that produced a burst of activity between ticks (many tool
/// calls in quick succession, or a poll that was skipped while a prepend was
/// in flight) fell permanently behind — each tick only ever closed a 10
/// message gap, so a 200 message burst took 20 ticks (100s) to catch up, and
/// `hasNewer`/`hasMore` semantics meant the UI looked "live" the whole time.
///
/// Mirrors `SessionPaging.maxPagesPerFetch`: bounded, not unbounded — a
/// pathological backlog must not block the poll `Task` in one long `await`
/// chain, so catch-up is capped per tick and the remainder is picked up by
/// the next tick, same shape as the session list's load-more sentinel.
public enum MessagePolling {
    /// How many pages one poll tick may fetch while catching up.
    public static let maxPagesPerTick = 5

    /// Whether to fetch another page in the same tick, having just appended one.
    public static func shouldFetchAnotherPage(hasMore: Bool, pagesFetched: Int) -> Bool {
        guard hasMore else { return false }
        return pagesFetched < maxPagesPerTick
    }
}
