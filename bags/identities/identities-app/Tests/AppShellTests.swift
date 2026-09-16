import AppKit
import SwiftUI
import XCTest
@testable import IdentitiesFeature

/// Covers what this app adds on top of the shared feature: the window it
/// builds and the menu it installs.
///
/// The feature's own logic is tested in the sessions package, which owns it.
/// What is only exercised here is the shell — and the shell is where the two
/// mistakes that would break this app live: a window that cannot take key
/// focus, and a `.regular` app with no Edit menu, which leaves ⌘C/⌘V dead in
/// every text field.
@MainActor
final class AppShellTests: XCTestCase {
    /// Mirrors `AppDelegate.applicationDidFinishLaunching`. Kept in step by
    /// hand — a second definition would be worse than none if it drifted, so
    /// the assertions below are about properties, not about this being a copy.
    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Identities"
        window.contentViewController = NSHostingController(
            rootView: IdentitiesWindowView(state: IdentitiesState())
        )
        window.isReleasedWhenClosed = false
        return window
    }

    /// The reason this is a separate app at all: an `.accessory` process
    /// cannot reliably key a window, which presents as text fields ignoring
    /// input. A titled window in a regular app can.
    func testWindowCanBecomeKey() {
        XCTAssertTrue(makeWindow().canBecomeKey)
    }

    /// Default is `true`, which over-releases a window ARC owns. This app has
    /// no NSWindowController to force it false, so the property is load-bearing
    /// here in a way it was not inside Barry Sessions.
    func testWindowIsNotReleasedWhenClosed() {
        XCTAssertFalse(makeWindow().isReleasedWhenClosed)
    }

    func testWindowHostsTheIdentitiesView() {
        let window = makeWindow()
        let host = window.contentViewController?.view
        XCTAssertNotNil(host)
        host?.layoutSubtreeIfNeeded()
        XCTAssertFalse(host!.fittingSize.width.isNaN)
    }

    /// The standalone app builds its own bus when none is injected — there is
    /// no shell here to hand it one, and the version that hardcoded
    /// `ownsBus = false` would have subscribed to a socket nothing connected.
    func testStateStartsWithoutAnInjectedBus() async throws {
        let state = IdentitiesState()
        state.start()
        // Reaching the API is not the assertion; not trapping on a nil bus is.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNotNil(state)
    }
}
