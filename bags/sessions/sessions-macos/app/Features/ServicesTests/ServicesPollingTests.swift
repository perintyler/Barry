import XCTest
@testable import ServicesFeature

/// astra review F13: before this fix, `start()` ran once at app launch and
/// polled every 5s FOREVER — `stop()` existed but had zero call sites
/// anywhere in the app. These tests pin the fixed lifecycle: `start()`
/// begins at the cadence matching the popover's actual (closed) state,
/// `setVisible` switches cadence rather than fully stopping (so the
/// menu-bar attention badge stays roughly current while hidden), and
/// `stop()` genuinely halts the timer.
@MainActor
final class ServicesPollingTests: XCTestCase {
    func testStartsAtBackgroundCadenceWhenPopoverIsClosed() {
        // The popover is closed by default at app launch — start() must not
        // assume otherwise. Before this fix, `start()` unconditionally used
        // the foreground interval regardless of visibility.
        let state = ServicesState()
        state.start()
        defer { state.stop() }

        XCTAssertEqual(state.currentPollInterval, ServicesState.backgroundInterval)
    }

    func testSetVisibleTrueSwitchesToForegroundCadence() {
        let state = ServicesState()
        state.start()
        defer { state.stop() }

        state.setVisible(true)
        XCTAssertEqual(state.currentPollInterval, ServicesState.foregroundInterval)
    }

    func testSetVisibleFalseSwitchesBackToBackgroundCadence() {
        // The actual F13 regression: before this fix, closing the popover
        // did nothing to the poll timer at all — it just kept running at
        // whatever cadence (or, before the fix existed, always 5s) it
        // already had.
        let state = ServicesState()
        state.start()
        defer { state.stop() }

        state.setVisible(true)
        XCTAssertEqual(state.currentPollInterval, ServicesState.foregroundInterval)
        state.setVisible(false)
        XCTAssertEqual(state.currentPollInterval, ServicesState.backgroundInterval)
    }

    func testSetVisibleIsANoOpWhenAlreadyInThatState() {
        // Guards against the private `guard visible != isVisible else {
        // return }` regressing into an unconditional re-arm — a repeated
        // `setVisible(false)` call (main.swift calls it from more than one
        // popover-close-adjacent path) must not thrash the timer.
        let state = ServicesState()
        state.start()
        defer { state.stop() }

        let intervalBefore = state.currentPollInterval
        state.setVisible(false)  // already false — must be a no-op
        XCTAssertEqual(state.currentPollInterval, intervalBefore)
    }

    func testStopHaltsPollingEntirely() {
        // Negative control on stop() itself: before F13, stop() existed and
        // worked correctly in isolation (invalidate + nil the timer) — the
        // bug was that nothing ever CALLED it. This test proves stop() still
        // does what it always claimed to, now that setVisible is the more
        // commonly used path.
        let state = ServicesState()
        state.start()
        XCTAssertNotNil(state.currentPollInterval, "start() must arm a timer")

        state.stop()
        XCTAssertNil(state.currentPollInterval, "stop() must invalidate the timer, not merely change its interval")
    }

    /// A second `refresh()` call while the first is still in flight must be
    /// a genuine no-op — not a second overlapping fetch — mirrors bdiff's
    /// `loadInFlight` guard. Before this guard, `refresh()` fired a new
    /// `Task` unconditionally on every call (every 5s tick, or every
    /// `setVisible(true)`), so a slow fetch overlapping the next tick could
    /// race two updates to `self.services`.
    ///
    /// Uses `fetchOverride` with an artificially slow fake fetch specifically
    /// so the second `refresh()` call is GUARANTEED to land while the first
    /// is still in flight — timing-dependent without this would be flaky
    /// (the first call could finish before the second ever runs) and,
    /// worse, could pass by coincidence even with a broken guard. The
    /// discriminator is `fetchCallCount`: with the guard, it must stay at 1
    /// no matter how many times `refresh()` is called while the fetch is
    /// pending.
    func testRefreshIsSingleFlight() async {
        let state = ServicesState()
        let gate = AsyncGate()
        state.fetchOverride = {
            await gate.wait()
            return []
        }

        state.refresh()
        XCTAssertTrue(state.refreshInFlight, "refresh() must mark itself in-flight synchronously, before the Task's async body runs")

        // These three overlapping calls, while the fake fetch is still
        // blocked on the gate, must all be rejected by the guard.
        state.refresh()
        state.refresh()
        state.refresh()

        await gate.open()

        // Poll for completion rather than a fixed sleep — bounded, not flaky
        // under CI load.
        for _ in 0..<50 {
            if !state.refreshInFlight { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertFalse(state.refreshInFlight, "the flag must clear once the real fetch finishes")
        XCTAssertEqual(state.fetchCallCount, 1, "exactly one fetch must have run — the guard must have rejected the three overlapping calls")
    }
}

/// A resumable one-shot gate: `wait()` suspends until `open()` is called.
/// Lets a test hold a fake async operation open for a controlled window,
/// rather than guessing at a sleep duration long enough to "probably"
/// overlap two calls.
actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        for continuation in pending { continuation.resume() }
    }
}
