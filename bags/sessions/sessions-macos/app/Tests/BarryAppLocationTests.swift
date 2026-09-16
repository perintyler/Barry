import XCTest
@testable import BarrySessionsCore

final class BarryAppLocationTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/example")

    func testInstalledPathMatchesWhereSetupPutsIt() {
        XCTAssertEqual(
            BarryAppLocation.identities.installedBundle(home: home).path,
            "/Users/example/.barry/apps/BarryIdentities.app"
        )
        XCTAssertEqual(
            BarryAppLocation.actions.installedBundle(home: home).path,
            "/Users/example/.barry/apps/BarryActions.app"
        )
        // Plans is an external-bag app; setup keys the path on the bundle
        // name, which is "Plans" — not "BarryPlans".
        XCTAssertEqual(
            BarryAppLocation.plans.installedBundle(home: home).path,
            "/Users/example/.barry/apps/Plans.app"
        )
    }

    /// The preference that matters. Launch Services returns whichever copy it
    /// saw most recently, which on a dev machine is usually a `.build`
    /// directory — opening that from the button silently runs a stale binary
    /// while looking like it opened the real app. Observed exactly that while
    /// testing this: `open -b` launched the worktree build.
    func testInstalledBundleBeatsWhateverLaunchServicesSuggests() {
        let installed = URL(fileURLWithPath: "/Users/example/.barry/apps/BarryIdentities.app")
        let stale = URL(fileURLWithPath: "/Users/example/repos/barry/.build/BarryIdentities.app")
        XCTAssertEqual(
            BarryAppLocation.identities.resolve(installed: installed, registered: stale),
            installed
        )
    }

    func testFallsBackToTheRegisteredCopyWhenNotInstalled() {
        let registered = URL(fileURLWithPath: "/Applications/BarryIdentities.app")
        XCTAssertEqual(
            BarryAppLocation.identities.resolve(installed: nil, registered: registered),
            registered
        )
    }

    /// Nil means not installed anywhere. The caller logs it — a button that
    /// quietly does nothing reads as broken.
    func testResolvesToNilWhenTheAppIsAbsent() {
        XCTAssertNil(BarryAppLocation.identities.resolve(installed: nil, registered: nil))
    }

    func testBundleIdentifiersMatchTheAppsInfoPlists() {
        XCTAssertEqual(BarryAppLocation.identities.bundleIdentifier, "com.barry.identities")
        XCTAssertEqual(BarryAppLocation.actions.bundleIdentifier, "com.barry.actions")
        XCTAssertEqual(BarryAppLocation.plans.bundleIdentifier, "com.barry.plans")
    }

    /// Two apps sharing one launcher: the whole point is that they do not
    /// resolve to the same bundle. A copy-paste that left `bundleName` alone
    /// would open Identities from the actions button and look almost right.
    func testTheTwoAppsAreDistinct() {
        XCTAssertNotEqual(
            BarryAppLocation.identities.bundleIdentifier,
            BarryAppLocation.actions.bundleIdentifier
        )
        XCTAssertNotEqual(
            BarryAppLocation.identities.installedBundle(home: home),
            BarryAppLocation.actions.installedBundle(home: home)
        )
    }
}
