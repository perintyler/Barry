import XCTest
@testable import BarrySessionsCore

final class AppRailEntryTests: XCTestCase {
    private let bundle = URL(fileURLWithPath: "/Users/example/.barry/apps/Plans.app")

    /// The rule this whole design turns on. An app is reachable because its
    /// bundle resolved, never because an icon came back — `NSWorkspace` hands
    /// out a generic document icon for a missing path, so an icon-based check
    /// would call every absent app healthy.
    func testAnAppIsUnreachableWhenItsBundleIsMissing() {
        XCTAssertFalse(AppRailEntry.plans.isReachable(bundleURL: nil))
        XCTAssertTrue(AppRailEntry.plans.isReachable(bundleURL: bundle))
    }

    /// The dashboard has no bundle, so a nil URL is not a failure for it. If
    /// this returned false the metrics button would sit permanently marked
    /// broken while working perfectly.
    func testTheWebEntryIsReachableWithoutABundle() {
        XCTAssertTrue(AppRailEntry.metrics.isReachable(bundleURL: nil))
    }

    /// QA.md step 24 presses these by identifier. A copy-paste that left two
    /// entries sharing one would produce a rail that looks perfect while the
    /// script clicks the wrong button — the same failure
    /// `BarryAppLocationTests.testTheTwoAppsAreDistinct` guards one level down.
    func testEveryEntryHasADistinctAccessibilityIdentifier() {
        let identifiers = AppRailEntry.all.map(\.accessibilityIdentifier)
        XCTAssertEqual(Set(identifiers).count, identifiers.count)
    }

    /// Pinned to the identifiers QA already drives, so renaming one breaks the
    /// build rather than the script.
    func testTheIdentifiersAreTheOnesQADrives() {
        XCTAssertEqual(
            Set(AppRailEntry.all.map(\.accessibilityIdentifier)),
            [
                "OpenMetricsButton",
                "OpenIdentitiesButton",
                "OpenActionsButton",
                "OpenPlansButton",
            ]
        )
    }

    /// Catches an entry lost in the move out of the tab row, and catches two
    /// entries pointing at one app — which would open Identities from the
    /// plans slot and look almost right.
    func testEachAppEntryPointsAtItsOwnBundle() {
        let locations = AppRailEntry.all.compactMap(\.appLocation)
        XCTAssertEqual(locations.count, 3)
        XCTAssertEqual(Set(locations.map(\.bundleIdentifier)).count, 3)
    }

    func testOnlyTheDashboardIsAWebEntry() {
        XCTAssertNil(AppRailEntry.metrics.appLocation)
        XCTAssertEqual(AppRailEntry.identities.appLocation, .identities)
    }
}
