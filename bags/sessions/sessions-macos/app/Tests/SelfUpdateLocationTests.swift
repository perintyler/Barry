import XCTest
@testable import BarrySessionsCore

final class SelfUpdateLocationTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/example")

    private func resolve(
        environment: [String: String] = [:],
        present: Set<String>
    ) -> URL? {
        SelfUpdateLocation.resolveScript(
            home: home,
            environment: environment,
            exists: { present.contains($0.path) }
        )
    }

    func testFindsTheScriptInTheConventionalCheckout() {
        let expected = "/Users/example/repos/barry/\(SelfUpdateLocation.scriptSubpath)"
        XCTAssertEqual(resolve(present: [expected])?.path, expected)
    }

    /// The reason the override exists: during development the app is restarted
    /// to pick up the worktree's changes, not master's. Master is also the
    /// shared tree and usually dirty with other sessions' work, so silently
    /// building it would rebuild something the user never asked for.
    func testBarryRepoOverrideWinsOverTheConventionalCheckout() {
        let worktree = "/Users/example/worktrees/feature/\(SelfUpdateLocation.scriptSubpath)"
        let conventional = "/Users/example/repos/barry/\(SelfUpdateLocation.scriptSubpath)"
        XCTAssertEqual(
            resolve(
                environment: ["BARRY_REPO": "/Users/example/worktrees/feature"],
                present: [worktree, conventional]
            )?.path,
            worktree
        )
    }

    /// An override pointing somewhere without the script must not strand the
    /// restart — fall through to the checkout that does have it.
    func testFallsThroughWhenTheOverrideHasNoScript() {
        let conventional = "/Users/example/repos/barry/\(SelfUpdateLocation.scriptSubpath)"
        XCTAssertEqual(
            resolve(
                environment: ["BARRY_REPO": "/Users/example/not-a-checkout"],
                present: [conventional]
            )?.path,
            conventional
        )
    }

    /// An empty value is what an unset-but-exported variable looks like. Taken
    /// literally it resolves to the script path relative to root, so guard it.
    func testEmptyOverrideIsIgnored() {
        let conventional = "/Users/example/repos/barry/\(SelfUpdateLocation.scriptSubpath)"
        XCTAssertEqual(
            resolve(environment: ["BARRY_REPO": ""], present: [conventional])?.path,
            conventional
        )
    }

    /// Nil is the signal that there is nothing to rebuild from. The caller has
    /// to stay up and say so: terminating with no updater scheduled would take
    /// the app down for good.
    func testResolvesToNilWhenNoCheckoutHasTheScript() {
        XCTAssertNil(resolve(present: []))
    }

    /// The resolver is only honest if this path is the real one. If the script
    /// moves and this constant does not, every restart silently degrades into
    /// the "can't find source" alert.
    func testScriptSubpathMatchesTheRepoLayout() {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // app
            .deletingLastPathComponent()  // sessions-macos
            .deletingLastPathComponent()  // sessions
            .deletingLastPathComponent()  // bags
            .deletingLastPathComponent()  // repo root
        let script = repoRoot.appendingPathComponent(SelfUpdateLocation.scriptSubpath)
        XCTAssertTrue(
            FileManager.default.isExecutableFile(atPath: script.path),
            "expected an executable self-update script at \(script.path)"
        )
    }
}
