import Foundation

/// Pure rules for paging the session list.
///
/// The list renders a *filtered* view of what it fetches: sessions with no
/// messages are hidden. The load-more sentinel, however, is armed from the
/// unfiltered cursor — "the server has more rows" — and those are not the same
/// question. When a fetched page is entirely message-less the visible list does
/// not grow, the sentinel stays on screen, and its `onAppear` fires again,
/// paging the table as fast as the network allows while the main thread
/// re-lays out the list on every reply.
///
/// That is not hypothetical: in a real 673-session store, 128 sessions had no
/// messages and three *consecutive* 20-row pages were 100% message-less, so
/// scrolling far enough down reliably wedged the app.
///
/// The fix is to make one sentinel firing keep paging until it has something to
/// show, and to bound how long it may do that. These rules are pure so the
/// termination guarantee can be tested without a client or a live socket.
public enum SessionPaging {
    /// How many pages one sentinel firing may fetch before yielding.
    ///
    /// A long message-less run should not block the main actor in a single
    /// `await` chain. Stopping early leaves the sentinel armed, so the next
    /// `onAppear` resumes — progress continues, just in bounded slices.
    ///
    /// This is now a **backstop, not the primary fix.** The server takes
    /// `hasMessages=true` (see `BarryClient.fetchRecentSessions`), so a page is
    /// already all-renderable and this loop should exit after one iteration.
    /// It still matters against an older server that ignores the parameter, and
    /// as the thing that bounds the damage if the two predicates drift apart
    /// again.
    ///
    /// Sized against measured data rather than taste: at a page size of 20 this
    /// covers a run of 100 consecutive message-less sessions, versus a worst
    /// observed run of 64 in a real 673-session store. If that headroom ever
    /// stops holding, the symptom is a list that stops early until a manual
    /// refresh — never the hang this replaced.
    public static let maxPagesPerFetch = 5

    /// Whether to fetch another page immediately, having just appended one.
    ///
    /// - Parameters:
    ///   - gainedVisibleRows: did the page just appended add any row the list
    ///     will actually render?
    ///   - hasMoreServerRows: does the server report another page after this one?
    ///   - pagesFetched: pages fetched so far in this sentinel firing.
    ///
    /// Continue only while all three hold: nothing visible was gained, the
    /// server has more, and we are under the slice budget. Any one of those
    /// failing ends the loop — which is what makes it terminate.
    public static func shouldFetchAnotherPage(
        gainedVisibleRows: Bool,
        hasMoreServerRows: Bool,
        pagesFetched: Int
    ) -> Bool {
        if gainedVisibleRows { return false }
        if !hasMoreServerRows { return false }
        return pagesFetched < maxPagesPerFetch
    }

    /// Whether the sentinel may arm itself again after a fetch completes.
    ///
    /// The backstop for the bug above: even if the predicate driving
    /// `hasMoreServerRows` and the one hiding rows drift apart again, the
    /// sentinel only re-arms when the visible list actually grew. A future
    /// mismatch then degrades to "stops loading early" — a stalled list the
    /// user can refresh — instead of a spin that hangs the app.
    public static func shouldRearmSentinel(
        visibleCountBefore: Int,
        visibleCountAfter: Int,
        hasMoreServerRows: Bool
    ) -> Bool {
        guard hasMoreServerRows else { return false }
        return visibleCountAfter > visibleCountBefore
    }
}
