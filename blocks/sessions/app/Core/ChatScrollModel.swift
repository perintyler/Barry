import CoreGraphics
import Observation

/// Scroll policy for the message list — the "chat feel" logic, separated from
/// both data (`MessagesState`) and rendering (`MessagesPanel`).
///
/// Responsibilities:
/// - **Follow-mode**: while the user is at/near the bottom, new messages keep the
///   view pinned to the bottom. If the user scrolls up, follow-mode disengages and
///   appended messages leave the viewport untouched (a "N new messages" pill shows
///   instead).
/// - **Prepend compensation**: when older messages are inserted at the top, remember
///   the pre-mutation offset/height so the view can restore the exact pixel position.
/// - **Load thresholds**: expose distances so the panel can trigger pagination.
///
/// Lives in `BarrySessionsCore` (UI-independent — depends only on CoreGraphics /
/// Observation) so its transition logic can be unit-tested without the executable.
@Observable
public final class ChatScrollModel {
    /// Derived scroll geometry. `Equatable` so `onScrollGeometryChange` only fires
    /// the action when a meaningful value actually changed.
    public struct Metrics: Equatable {
        public var offsetY: CGFloat
        public var contentHeight: CGFloat
        public var viewportHeight: CGFloat

        public init(offsetY: CGFloat, contentHeight: CGFloat, viewportHeight: CGFloat) {
            self.offsetY = offsetY
            self.contentHeight = contentHeight
            self.viewportHeight = viewportHeight
        }

        /// Pixels between the bottom edge of the viewport and the bottom of content.
        /// Clamped at 0 (bounce/overscroll can make the raw value negative).
        public var distanceToBottom: CGFloat {
            max(0, contentHeight - viewportHeight - offsetY)
        }
    }

    /// Saved position captured just before a prepend, used to restore the exact
    /// pixel offset once the new content has been measured.
    public struct PendingCompensation: Equatable {
        public var savedOffset: CGFloat
        public var savedHeight: CGFloat

        public init(savedOffset: CGFloat, savedHeight: CGFloat) {
            self.savedOffset = savedOffset
            self.savedHeight = savedHeight
        }
    }

    // MARK: - Policy constants

    /// Within this many pixels of the bottom counts as "at the bottom" — follow-mode
    /// engages/stays engaged.
    public static let followTolerance: CGFloat = 60
    /// Trigger `loadOlder` when the top of content is within this distance.
    public static let loadOlderThreshold: CGFloat = 400
    /// Trigger `loadNewer` when the bottom of content is within this distance.
    public static let loadNewerThreshold: CGFloat = 400

    // MARK: - State

    public var followMode: Bool
    public var unseenCount = 0
    public private(set) var lastMetrics: Metrics?
    public var isUserInteracting = false
    /// A programmatic scroll (prepend compensation, resize re-pin, pill tap) is in
    /// flight; the next geometry callback is our own adjustment, not user intent.
    public var isAdjusting = false
    public var pendingCompensation: PendingCompensation?
    /// Geometry snapshot taken the instant a `loadOlder` is triggered, so prepend
    /// compensation uses the true pre-insert offset even if other geometry callbacks
    /// (e.g. the loading indicator appearing) land before the mutation commits.
    public var prependBaseline: Metrics?
    /// Set right after a prepend compensation scroll. While true, `shouldLoadOlder`
    /// stays false so a single scroll-up gesture loads exactly one page instead of
    /// cascading page-after-page (the compensation scroll can land back near the top
    /// threshold, which would otherwise immediately re-trigger loadOlder). Cleared
    /// once the viewport settles above the threshold or the content is exhausted.
    public private(set) var awaitingResettle = false

    public init(followMode: Bool = true) {
        self.followMode = followMode
    }

    // MARK: - Transitions (pure)

    /// Fold new geometry into state. Returns the compensation target offset if a
    /// pending prepend should be restored on this callback, else nil. The caller
    /// performs the actual scroll.
    @discardableResult
    public func geometryDidChange(_ metrics: Metrics) -> CGFloat? {
        // 1. Prepend compensation — fire once the inserted content has grown height.
        if let pending = pendingCompensation, metrics.contentHeight != pending.savedHeight {
            let delta = metrics.contentHeight - pending.savedHeight
            pendingCompensation = nil
            isAdjusting = true
            // Block further loadOlder until the viewport settles clear of the top
            // threshold — otherwise this compensation scroll can re-trigger a load
            // and cascade through the whole history.
            awaitingResettle = true
            lastMetrics = metrics
            return pending.savedOffset + delta
        }

        // 2. Consume our own adjustment frame without re-deriving follow-mode from it.
        if isAdjusting {
            isAdjusting = false
            lastMetrics = metrics
            return nil
        }

        lastMetrics = metrics

        // 3. Restore follow-mode whenever the view is back at the bottom, regardless
        //    of cause (user scrolled down, content shrank, pill tapped).
        if metrics.distanceToBottom <= Self.followTolerance {
            if !followMode {
                followMode = true
                unseenCount = 0
            }
        }
        return nil
    }

    /// React to a scroll phase change. Breaks follow-mode only on a user-driven
    /// scroll that leaves the bottom; programmatic/animating scrolls never break it.
    public func phaseDidChange(isInteracting: Bool) {
        isUserInteracting = isInteracting
        guard isInteracting else { return }
        // A fresh user-driven scroll clears the post-compensation guard: the
        // previous page has settled and the user is deliberately scrolling again,
        // so the next loadOlder is intentional, not a compensation echo.
        awaitingResettle = false
        guard !isAdjusting, let m = lastMetrics else { return }
        if m.distanceToBottom > Self.followTolerance {
            followMode = false
        }
    }

    /// Record appended messages while scrolled up — bump the unseen counter.
    public func didAppendWhileScrolledUp(count: Int) {
        unseenCount += count
    }

    /// Reset for a fresh load (initial mount or refresh).
    public func reset(followMode: Bool) {
        self.followMode = followMode
        unseenCount = 0
        lastMetrics = nil
        isUserInteracting = false
        isAdjusting = false
        pendingCompensation = nil
        prependBaseline = nil
        awaitingResettle = false
    }

    // MARK: - Queries

    public var shouldLoadOlder: Bool {
        guard !awaitingResettle, let m = lastMetrics else { return false }
        return m.offsetY < Self.loadOlderThreshold
    }

    public var shouldLoadNewer: Bool {
        guard let m = lastMetrics else { return false }
        return m.distanceToBottom < Self.loadNewerThreshold
    }
}
