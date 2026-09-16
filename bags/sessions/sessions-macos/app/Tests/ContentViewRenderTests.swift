import SwiftUI
import XCTest
import EventsFeature
import ServicesFeature
@testable import BarrySessionsCore

/// Builds the popover's root view on every tab.
///
/// The tab bar is the one thing the merge added that nothing else covers: the
/// features have their own tests, but the switch between them, the badge, and
/// the profile button live in ContentView. Compiling proves the types line up;
/// only a layout pass proves `body` survives evaluation on each branch.
///
/// ContentView is internal to the executable target, which a test target
/// cannot import — so this exercises the pieces it composes plus the pure
/// navigation rules it depends on, which is where the logic actually is.
@MainActor
final class ContentViewRenderTests: XCTestCase {
    private func render(_ view: some View, height: CGFloat = 680) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 580, height: height)
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize.width.isNaN)
    }

    /// Each tab's root view builds. A crash here would only otherwise appear
    /// when someone clicked that tab.
    func testEventsTabBuilds() {
        render(EventsView(state: EventsState()))
    }

    func testServicesTabBuilds() {
        render(ServicesView(appState: ServicesState()))
    }

    /// Every tab is reachable and titled — a case added to the enum without a
    /// title would show a blank button.
    func testEveryTabIsTitled() {
        XCTAssertEqual(RootTab.allCases.map(\.title), ["Sessions", "Events", "Approvals", "Services"])
        for tab in RootTab.allCases {
            XCTAssertFalse(tab.title.isEmpty, "\(tab) has no title")
        }
    }

    /// Switching tabs changes whether the events feed counts as visible, which
    /// is what gates notifications. Both halves matter — see RootNavigation.
    func testFeedVisibilityFollowsTheSelectedTab() {
        XCTAssertTrue(RootNavigation.isVisible(.events, selected: .events, whilePopoverOpen: true))
        XCTAssertFalse(RootNavigation.isVisible(.events, selected: .services, whilePopoverOpen: true))
        XCTAssertFalse(RootNavigation.isVisible(.events, selected: .events, whilePopoverOpen: false))
    }

    /// Reopening lands on Sessions rather than resuming Services or Events.
    func testHomeIsSessionsEvenWithThreeTabs() {
        XCTAssertEqual(RootNavigation.home, .sessions)
    }
}
