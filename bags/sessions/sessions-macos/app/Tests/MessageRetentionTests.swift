import XCTest
@testable import BarrySessionsCore

/// astra review F14: `MessagesState` had no cap on how many messages it kept
/// in memory — a session left open and polling for hours grew `messages`
/// without bound. These pin the pure trim decision `MessagesState.trimIfNeeded`
/// is built on.
final class MessageRetentionTests: XCTestCase {
    func testDoesNotTrimUnderTheCap() {
        XCTAssertFalse(MessageRetention.shouldTrim(currentCount: MessageRetention.retainedMessageCap))
        XCTAssertEqual(MessageRetention.trimCount(currentCount: MessageRetention.retainedMessageCap), 0)
    }

    func testTrimsOnceOverTheCap() {
        let over = MessageRetention.retainedMessageCap + 1
        XCTAssertTrue(MessageRetention.shouldTrim(currentCount: over))
        XCTAssertGreaterThan(MessageRetention.trimCount(currentCount: over), 0)
    }

    /// The batch shape: trimming must land back at cap - trimBatchSize, not
    /// exactly at the cap — otherwise a session sitting right at the cap
    /// would trim again on every single subsequent message (one in, one out),
    /// which is the "check that cannot fail" of retention: technically bounded,
    /// but doing full-rebuild work on every append defeats the point.
    func testTrimLandsABatchBelowTheCapNotExactlyAtIt() {
        let count = MessageRetention.retainedMessageCap + MessageRetention.trimBatchSize
        let drop = MessageRetention.trimCount(currentCount: count)
        let remaining = count - drop
        XCTAssertEqual(remaining, MessageRetention.retainedMessageCap - MessageRetention.trimBatchSize)
    }

    func testNeverDropsMoreThanExist() {
        // A burst that arrives all at once (e.g. catch-up after being
        // backgrounded) must not compute a drop count larger than the list.
        let small = MessageRetention.trimBatchSize / 2
        XCTAssertLessThanOrEqual(MessageRetention.trimCount(currentCount: small), small)
    }

    func testZeroMessagesNeverTrims() {
        XCTAssertEqual(MessageRetention.trimCount(currentCount: 0), 0)
    }

    /// Negative control: proves these tests actually discriminate a broken
    /// cap, not just a tautology — a cap effectively disabled (e.g. mis-set
    /// to Int.max) would make `shouldTrim` false right where it must be true.
    func testCapIsActuallyFiniteAndPositive_negativeControl() {
        XCTAssertGreaterThan(MessageRetention.retainedMessageCap, 0)
        XCTAssertLessThan(MessageRetention.retainedMessageCap, 1_000_000, "cap is not meaningfully bounding anything at this size")
        XCTAssertGreaterThan(MessageRetention.trimBatchSize, 0)
        XCTAssertLessThan(MessageRetention.trimBatchSize, MessageRetention.retainedMessageCap, "a batch >= the cap would trim to zero or negative, an obviously broken policy")
    }
}
