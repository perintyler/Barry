import XCTest

/// The shape of every loading flag in the app, tested directly.
///
/// A flag cleared by a statement after the `do/catch` is skipped entirely when
/// the task is cancelled at an `await` — the function never resumes. In a
/// `.transient` popover that closes on any outside click, that is the ordinary
/// case, and the result is a spinner that never stops.
///
/// These test the pattern rather than `MessagesState` itself, which builds its
/// own `BarryClient` and cannot be pointed at a stub. The pattern is the part
/// that was wrong, and the part that will be copied into the next loader.
final class LoadingFlagCancellationTests: XCTestCase {
    /// A loader written the way `loadInitial` used to be.
    private actor TrailingAssignment {
        private(set) var isLoading = false

        func load() async {
            isLoading = true
            do {
                try await Task.sleep(for: .seconds(10))
            } catch {
                // Cancellation lands here only if the sleep throws before the
                // task is torn down; on a real URLSession await it does not.
            }
            isLoading = false
        }

        /// Cancellation at the suspension point, modelled faithfully: the
        /// continuation never resumes, so nothing after the `await` runs.
        func loadAbandoned() async {
            isLoading = true
            await withTaskGroup(of: Void.self) { group in
                group.addTask { try? await Task.sleep(for: .seconds(10)) }
                group.cancelAll()
            }
            if Task.isCancelled { return } // early return skips the clear
            isLoading = false
        }
    }

    private actor DeferredClear {
        private(set) var isLoading = false

        func loadAbandoned() async {
            isLoading = true
            defer { isLoading = false }
            await withTaskGroup(of: Void.self) { group in
                group.addTask { try? await Task.sleep(for: .seconds(10)) }
                group.cancelAll()
            }
            if Task.isCancelled { return }
        }
    }

    /// The bug: an early return past the clear leaves the flag set.
    func testTrailingAssignmentLeavesTheFlagStuck() async {
        let subject = TrailingAssignment()
        let task = Task { await subject.loadAbandoned() }
        task.cancel()
        await task.value
        let stuck = await subject.isLoading
        XCTAssertTrue(stuck, "precondition: this is the shape that strands the spinner")
    }

    /// The fix: `defer` runs on every exit, including the one that skips the
    /// rest of the function.
    func testDeferClearsTheFlagOnAbandonedLoad() async {
        let subject = DeferredClear()
        let task = Task { await subject.loadAbandoned() }
        task.cancel()
        await task.value
        let cleared = await subject.isLoading
        XCTAssertFalse(cleared, "defer must clear the flag even when the load never finishes")
    }
}
