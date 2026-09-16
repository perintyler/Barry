import XCTest
@testable import BarrySessionsCore

final class RootNavigationTests: XCTestCase {
    // The events feed suppresses notifications while it is visible. Before the
    // merge that was "is the popover open", because the feed was the whole app.
    // Now it is a conjunction, and each half has its own failure mode: drop the
    // tab check and every banner is swallowed while the user sits on Sessions;
    // drop the popover check and the app announces what is already on screen.
    func testFeedIsVisibleOnlyWhenItsTabIsSelectedAndPopoverIsOpen() {
        XCTAssertTrue(RootNavigation.isVisible(.events, selected: .events, whilePopoverOpen: true))
        XCTAssertFalse(RootNavigation.isVisible(.events, selected: .sessions, whilePopoverOpen: true))
        XCTAssertFalse(RootNavigation.isVisible(.events, selected: .events, whilePopoverOpen: false))
        XCTAssertFalse(RootNavigation.isVisible(.events, selected: .sessions, whilePopoverOpen: false))
    }

    func testSessionsTabFollowsTheSameRule() {
        XCTAssertTrue(RootNavigation.isVisible(.sessions, selected: .sessions, whilePopoverOpen: true))
        XCTAssertFalse(RootNavigation.isVisible(.sessions, selected: .events, whilePopoverOpen: true))
    }

    /// Reopening lands on the session list rather than resuming the last tab,
    /// matching `PopoverNavigation.shouldResetToHome`.
    func testHomeIsTheSessionList() {
        XCTAssertEqual(RootNavigation.home, .sessions)
    }

    func testEveryTabHasATitleAndIsEnumerable() {
        XCTAssertEqual(RootTab.allCases.map(\.title), ["Sessions", "Events", "Approvals", "Services"])
    }
}

/// The rules ContentView defers to, tested here because ContentView itself is
/// internal to the executable target and no test target can import it.
final class TabBarVisibilityTests: XCTestCase {
    /// A session's detail screen has its own back button and tab row. Showing
    /// the root switcher above it stacked two competing navigations.
    func testTabBarHidesBehindASessionDetail() {
        XCTAssertFalse(RootNavigation.showsTabBar(selected: .sessions, isShowingDetail: true))
        XCTAssertTrue(RootNavigation.showsTabBar(selected: .sessions, isShowingDetail: false))
    }

    /// Only the sessions tab has a detail screen. If `isShowingDetail` ever
    /// leaks true while another tab is selected — a stale selectedSessionId,
    /// say — that tab must still show its switcher, or the user is stranded
    /// with no way back.
    func testOtherTabsAlwaysShowTheSwitcher() {
        for tab in RootTab.allCases where tab != .sessions {
            XCTAssertTrue(
                RootNavigation.showsTabBar(selected: tab, isShowingDetail: true),
                "\(tab) hid its switcher and stranded the user"
            )
        }
    }
}
