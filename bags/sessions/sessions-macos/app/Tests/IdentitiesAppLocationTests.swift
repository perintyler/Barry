import XCTest
@testable import BarrySessionsCore

final class IdentitiesAppLocationTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/example")

    func testInstalledPathMatchesWhereSetupPutsIt() {
        XCTAssertEqual(
            IdentitiesAppLocation.installedBundle(home: home).path,
            "/Users/example/.barry/apps/BarryIdentities.app"
        )
    }

    /// The preference that matters. Launch Services returns whichever copy it
    /// saw most recently, which on a dev machine is usually a `.build`
    /// directory — opening that from the profile button silently runs a stale
    /// binary while looking like it opened the real app. Observed exactly that
    /// while testing this: `open -b` launched the worktree build.
    func testInstalledBundleBeatsWhateverLaunchServicesSuggests() {
        let installed = URL(fileURLWithPath: "/Users/example/.barry/apps/BarryIdentities.app")
        let stale = URL(fileURLWithPath: "/Users/example/repos/barry/.build/BarryIdentities.app")
        XCTAssertEqual(IdentitiesAppLocation.resolve(installed: installed, registered: stale), installed)
    }

    func testFallsBackToTheRegisteredCopyWhenNotInstalled() {
        let registered = URL(fileURLWithPath: "/Applications/BarryIdentities.app")
        XCTAssertEqual(IdentitiesAppLocation.resolve(installed: nil, registered: registered), registered)
    }

    /// Nil means not installed anywhere. The caller logs it — a button that
    /// quietly does nothing reads as broken.
    func testResolvesToNilWhenTheAppIsAbsent() {
        XCTAssertNil(IdentitiesAppLocation.resolve(installed: nil, registered: nil))
    }

    func testBundleIdentifierMatchesTheAppsInfoPlist() {
        XCTAssertEqual(IdentitiesAppLocation.bundleIdentifier, "com.barry.identities")
    }
}
