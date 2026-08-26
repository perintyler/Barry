import BarrySessionsCore
import XCTest

/// Guards what the menu bar popover shows when it is reopened.
///
/// The popover's hosting controller is built once and reused, so screen state
/// survives dismissal unless something clears it. These pin the rule that
/// decides whether a given close should clear it.
final class PopoverNavigationTests: XCTestCase {
    func testOrdinaryCloseReturnsToHome() {
        // Reading a session, clicking away, clicking the status item again:
        // the next open starts at the list, not back inside that session.
        XCTAssertTrue(PopoverNavigation.shouldResetToHome(isPresentingModal: false))
    }

    func testCloseUnderAModalKeepsItsUnsavedInput() {
        // The new-session sheet can steal key focus and close the transient
        // popover underneath itself. That is not a dismissal, and resetting
        // would throw away a half-typed prompt.
        XCTAssertFalse(PopoverNavigation.shouldResetToHome(isPresentingModal: true))
    }
}
