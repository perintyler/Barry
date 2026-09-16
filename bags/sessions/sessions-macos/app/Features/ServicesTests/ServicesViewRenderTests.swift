import SwiftUI
import XCTest
@testable import ServicesFeature

/// Builds the services tab's view tree.
///
/// Same reason as the identities sheets: compiling proves the types line up,
/// not that `body` survives evaluation. A tab that crashes on first render
/// would otherwise only show up when someone clicked it.
@MainActor
final class ServicesViewRenderTests: XCTestCase {
    func testServicesViewBuildsItsBody() {
        let host = NSHostingView(rootView: ServicesView(appState: ServicesState()))
        host.frame = NSRect(x: 0, y: 0, width: 580, height: 680)
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize.height.isNaN)
    }
}
