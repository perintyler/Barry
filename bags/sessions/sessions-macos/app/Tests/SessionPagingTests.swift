import XCTest

@testable import BarrySessionsCore

/// Pins the termination guarantee for the session list's load-more sentinel.
///
/// The app once wedged because "the server has more rows" and "the list grew"
/// were treated as the same condition. A run of message-less sessions satisfied
/// the first and not the second, so the sentinel re-fired forever. These tests
/// fail if that coupling comes back.
final class SessionPagingTests: XCTestCase {

    // MARK: - shouldFetchAnotherPage

    func testStopsAsSoonAsAPageYieldsVisibleRows() {
        // The common case: one page, something to show, done.
        XCTAssertFalse(
            SessionPaging.shouldFetchAnotherPage(
                gainedVisibleRows: true,
                hasMoreServerRows: true,
                pagesFetched: 1
            )
        )
    }

    func testKeepsPagingThroughAnInvisiblePage() {
        // An all-message-less page must not end the fetch, or the sentinel is
        // left to re-fire with nothing gained — the original spin.
        XCTAssertTrue(
            SessionPaging.shouldFetchAnotherPage(
                gainedVisibleRows: false,
                hasMoreServerRows: true,
                pagesFetched: 1
            )
        )
    }

    func testStopsAtEndOfHistoryEvenWithNothingVisible()  {
        XCTAssertFalse(
            SessionPaging.shouldFetchAnotherPage(
                gainedVisibleRows: false,
                hasMoreServerRows: false,
                pagesFetched: 1
            )
        )
    }

    func testStopsAtTheSliceBudget() {
        // Bounded work per firing: the main actor is released even mid-run.
        XCTAssertFalse(
            SessionPaging.shouldFetchAnotherPage(
                gainedVisibleRows: false,
                hasMoreServerRows: true,
                pagesFetched: SessionPaging.maxPagesPerFetch
            )
        )
    }

    /// The regression proper: consecutive all-invisible pages must terminate.
    ///
    /// Mirrors real data — three back-to-back 20-row pages with no messages —
    /// but runs far past that to prove the loop is bounded by the budget and
    /// not by luck in the fixture.
    func testConsecutiveInvisiblePagesTerminate() {
        let invisiblePagesAvailable = 50
        var pagesFetched = 0

        while SessionPaging.shouldFetchAnotherPage(
            gainedVisibleRows: false,
            hasMoreServerRows: pagesFetched < invisiblePagesAvailable,
            pagesFetched: pagesFetched
        ) {
            pagesFetched += 1
            XCTAssertLessThanOrEqual(
                pagesFetched,
                SessionPaging.maxPagesPerFetch,
                "load-more exceeded its per-firing budget — this is the wedge"
            )
        }

        XCTAssertEqual(pagesFetched, SessionPaging.maxPagesPerFetch)
    }

    // MARK: - shouldRearmSentinel

    func testRearmsOnlyWhenTheVisibleListGrew() {
        XCTAssertTrue(
            SessionPaging.shouldRearmSentinel(
                visibleCountBefore: 10,
                visibleCountAfter: 24,
                hasMoreServerRows: true
            )
        )
    }

    func testDoesNotRearmWhenNothingBecameVisible() {
        // The backstop. Server says "more rows", list gained none: stop.
        XCTAssertFalse(
            SessionPaging.shouldRearmSentinel(
                visibleCountBefore: 10,
                visibleCountAfter: 10,
                hasMoreServerRows: true
            )
        )
    }

    func testDoesNotRearmAtEndOfHistory() {
        XCTAssertFalse(
            SessionPaging.shouldRearmSentinel(
                visibleCountBefore: 10,
                visibleCountAfter: 30,
                hasMoreServerRows: false
            )
        )
    }
}
