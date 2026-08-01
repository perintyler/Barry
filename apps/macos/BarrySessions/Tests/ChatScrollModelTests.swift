import BarrySessionsCore
import XCTest

final class ChatScrollModelTests: XCTestCase {
    /// A viewport of 500pt over 2000pt of content: bottom is at offsetY 1500.
    private func metrics(offsetY: CGFloat, content: CGFloat = 2000, viewport: CGFloat = 500) -> ChatScrollModel.Metrics {
        ChatScrollModel.Metrics(offsetY: offsetY, contentHeight: content, viewportHeight: viewport)
    }

    // MARK: - distanceToBottom

    func testDistanceToBottomClampsAtZero() {
        // Overscroll/bounce can push offset past the true bottom → clamp, not negative.
        XCTAssertEqual(metrics(offsetY: 1600).distanceToBottom, 0)
        XCTAssertEqual(metrics(offsetY: 1500).distanceToBottom, 0)
        XCTAssertEqual(metrics(offsetY: 1000).distanceToBottom, 500)
    }

    // MARK: - Follow-mode restore

    func testFollowRestoresWhenBackNearBottom() {
        let m = ChatScrollModel(followMode: false)
        m.unseenCount = 3
        // Within followTolerance (60) of the bottom.
        m.geometryDidChange(metrics(offsetY: 1500 - 30))
        XCTAssertTrue(m.followMode)
        XCTAssertEqual(m.unseenCount, 0)
    }

    func testFollowDoesNotEngageWhileScrolledUp() {
        let m = ChatScrollModel(followMode: false)
        m.geometryDidChange(metrics(offsetY: 200)) // far from bottom
        XCTAssertFalse(m.followMode)
    }

    // MARK: - Follow-break on user scroll

    func testUserScrollUpBreaksFollow() {
        let m = ChatScrollModel(followMode: true)
        m.geometryDidChange(metrics(offsetY: 200)) // now scrolled up
        m.phaseDidChange(isInteracting: true)
        XCTAssertFalse(m.followMode)
    }

    func testUserScrollNearBottomKeepsFollow() {
        let m = ChatScrollModel(followMode: true)
        m.geometryDidChange(metrics(offsetY: 1480)) // within tolerance
        m.phaseDidChange(isInteracting: true)
        XCTAssertTrue(m.followMode)
    }

    func testProgrammaticAdjustmentNeverBreaksFollow() {
        let m = ChatScrollModel(followMode: true)
        m.geometryDidChange(metrics(offsetY: 200))
        m.isAdjusting = true
        m.phaseDidChange(isInteracting: true) // our own scroll, not the user's
        XCTAssertTrue(m.followMode)
    }

    // MARK: - Prepend compensation

    func testPrependCompensationRestoresExactOffset() {
        let m = ChatScrollModel(followMode: false)
        // Before prepend: at offset 100 in 2000pt of content.
        m.geometryDidChange(metrics(offsetY: 100))
        m.pendingCompensation = .init(savedOffset: 100, savedHeight: 2000)

        // After prepend: content grew by 800pt at the top.
        let target = m.geometryDidChange(metrics(offsetY: 100, content: 2800))
        XCTAssertEqual(target, 900) // savedOffset + delta = 100 + 800
        XCTAssertNil(m.pendingCompensation)
        XCTAssertTrue(m.isAdjusting)
    }

    func testAdjustmentFrameIsConsumedWithoutSideEffects() {
        let m = ChatScrollModel(followMode: true)
        m.isAdjusting = true
        let target = m.geometryDidChange(metrics(offsetY: 200)) // scrolled-up geometry
        XCTAssertNil(target)
        XCTAssertFalse(m.isAdjusting)      // consumed
        XCTAssertTrue(m.followMode)        // not re-derived from this frame
    }

    func testPrependWithUnchangedHeightDoesNotCompensate() {
        let m = ChatScrollModel(followMode: false)
        m.pendingCompensation = .init(savedOffset: 100, savedHeight: 2000)
        // Height hasn't changed yet (inserted rows not measured) → wait.
        let target = m.geometryDidChange(metrics(offsetY: 100, content: 2000))
        XCTAssertNil(target)
        XCTAssertNotNil(m.pendingCompensation) // still pending
    }

    // MARK: - Load thresholds

    func testShouldLoadOlderNearTop() {
        let m = ChatScrollModel()
        m.geometryDidChange(metrics(offsetY: 399)) // < loadOlderThreshold (400)
        XCTAssertTrue(m.shouldLoadOlder)
    }

    func testShouldNotLoadOlderMidHistory() {
        let m = ChatScrollModel()
        m.geometryDidChange(metrics(offsetY: 800))
        XCTAssertFalse(m.shouldLoadOlder)
    }

    func testShouldLoadNewerNearBottom() {
        let m = ChatScrollModel()
        m.geometryDidChange(metrics(offsetY: 1200)) // distanceToBottom 300 < 400
        XCTAssertTrue(m.shouldLoadNewer)
    }

    func testQueriesFalseWithoutMetrics() {
        let m = ChatScrollModel()
        XCTAssertFalse(m.shouldLoadOlder)
        XCTAssertFalse(m.shouldLoadNewer)
    }

    // MARK: - Unseen count & reset

    func testUnseenCountAccumulates() {
        let m = ChatScrollModel(followMode: false)
        m.didAppendWhileScrolledUp(count: 2)
        m.didAppendWhileScrolledUp(count: 3)
        XCTAssertEqual(m.unseenCount, 5)
    }

    func testResetClearsState() {
        let m = ChatScrollModel(followMode: false)
        m.unseenCount = 4
        m.geometryDidChange(metrics(offsetY: 200))
        m.pendingCompensation = .init(savedOffset: 1, savedHeight: 2)
        m.prependBaseline = metrics(offsetY: 3)

        m.reset(followMode: true)
        XCTAssertTrue(m.followMode)
        XCTAssertEqual(m.unseenCount, 0)
        XCTAssertNil(m.lastMetrics)
        XCTAssertNil(m.pendingCompensation)
        XCTAssertNil(m.prependBaseline)
        XCTAssertFalse(m.isAdjusting)
    }

    // MARK: - Resettle guard (no loadOlder cascade)

    func testCompensationBlocksImmediateReload() {
        let m = ChatScrollModel(followMode: false)
        // User scrolled to the top → eligible to load older.
        m.geometryDidChange(metrics(offsetY: 100))
        XCTAssertTrue(m.shouldLoadOlder)

        // A prepend compensation fires...
        m.pendingCompensation = .init(savedOffset: 100, savedHeight: 2000)
        _ = m.geometryDidChange(metrics(offsetY: 100, content: 2800))
        // ...and lands the viewport back near the top (offset still < threshold).
        m.geometryDidChange(metrics(offsetY: 120, content: 2800)) // consumes isAdjusting frame
        m.geometryDidChange(metrics(offsetY: 120, content: 2800)) // settled frame

        // Even though offset is < threshold, no cascade: the guard holds.
        XCTAssertFalse(m.shouldLoadOlder)
    }

    func testFreshUserScrollClearsResettleGuard() {
        let m = ChatScrollModel(followMode: false)
        m.pendingCompensation = .init(savedOffset: 100, savedHeight: 2000)
        _ = m.geometryDidChange(metrics(offsetY: 100, content: 2800))
        m.geometryDidChange(metrics(offsetY: 120, content: 2800)) // consume adjust frame
        XCTAssertFalse(m.shouldLoadOlder) // guarded

        // User deliberately scrolls again → guard clears, next page allowed.
        m.phaseDidChange(isInteracting: true)
        m.geometryDidChange(metrics(offsetY: 100, content: 2800))
        XCTAssertTrue(m.shouldLoadOlder)
    }

    func testResetClearsResettleGuard() {
        let m = ChatScrollModel(followMode: false)
        m.pendingCompensation = .init(savedOffset: 100, savedHeight: 2000)
        _ = m.geometryDidChange(metrics(offsetY: 100, content: 2800))
        m.reset(followMode: true)
        m.geometryDidChange(metrics(offsetY: 100))
        XCTAssertTrue(m.shouldLoadOlder) // guard gone after reset
    }
}
