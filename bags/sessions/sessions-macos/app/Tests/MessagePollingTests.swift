import XCTest
@testable import BarrySessionsCore

/// astra review F14: `pollForNew` fetched at most one page (10 messages) per
/// 5s tick with no catch-up — a burst larger than that permanently fell
/// behind, one page closer per tick, however large the backlog. These pin
/// the bounded catch-up rule `MessagesState.pollForNew`'s loop is built on —
/// mirrors `SessionPagingTests.swift`'s coverage of the sibling
/// `SessionPaging.shouldFetchAnotherPage`.
final class MessagePollingTests: XCTestCase {
    func testStopsWhenServerHasNoMore() {
        XCTAssertFalse(MessagePolling.shouldFetchAnotherPage(hasMore: false, pagesFetched: 1))
    }

    func testContinuesWhileUnderTheBudgetAndMoreExists() {
        XCTAssertTrue(MessagePolling.shouldFetchAnotherPage(hasMore: true, pagesFetched: 1))
    }

    func testStopsAtTheBudgetEvenWithMoreAvailable() {
        // The actual F14 backstop: a large backlog must not block the poll
        // Task in one long await chain — the rest is picked up next tick.
        XCTAssertFalse(
            MessagePolling.shouldFetchAnotherPage(hasMore: true, pagesFetched: MessagePolling.maxPagesPerTick)
        )
    }

    /// A large backlog (far past the budget) must terminate in bounded pages,
    /// not run away — same shape as `SessionPagingTests.testConsecutiveInvisiblePagesTerminate`.
    func testLargeBacklogTerminatesAtTheBudget() {
        let pagesAvailable = 500
        var pagesFetched = 0

        while MessagePolling.shouldFetchAnotherPage(hasMore: pagesFetched < pagesAvailable, pagesFetched: pagesFetched) {
            pagesFetched += 1
            XCTAssertLessThanOrEqual(pagesFetched, MessagePolling.maxPagesPerTick, "poll catch-up exceeded its per-tick budget")
        }

        XCTAssertEqual(pagesFetched, MessagePolling.maxPagesPerTick)
    }

    /// Negative control: proves the budget is actually finite, not a
    /// tautology that always returns true up to Int.max.
    func testBudgetIsActuallySmall_negativeControl() {
        XCTAssertGreaterThan(MessagePolling.maxPagesPerTick, 0)
        XCTAssertLessThan(MessagePolling.maxPagesPerTick, 1000, "budget is not meaningfully bounding a single poll tick at this size")
    }
}
