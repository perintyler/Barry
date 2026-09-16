import SwiftUI
import XCTest
@testable import IdentitiesFeature

/// Presents each sheet in a real hosting view and lets SwiftUI lay it out.
///
/// Not a snapshot test — it asserts nothing about pixels. It exists because
/// every other check on these sheets was static: the endpoints were exercised
/// over HTTP and the views compiled, but nothing had ever *built the view
/// tree*. A bad `@State` initializer, a `ForEach` over a non-unique id, or a
/// binding that traps only shows up when the body actually runs.
@MainActor
final class SheetRenderTests: XCTestCase {
    private func identity() throws -> Identity {
        let json = """
        {"id":1,"name":"bux","displayName":null,"token":"prf_x","bags":["git"],
         "traits":["coding"],"boundId":null,"defaultCodingAgent":"claude",
         "defaultModel":null,"envKeys":["A"],"envSources":{"A":"vault"},
         "vaultEmail":null,"statusNotify":null,"githubInstallationId":null,
         "allowNativeTools":false,"isDefault":true,"lastUsedAt":null,
         "createdAt":null,"source":"file"}
        """
        return try JSONDecoder().decode(Identity.self, from: Data(json.utf8))
    }

    private func render(_ view: some View) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 460, height: 560)
        // Forces a layout pass, which is what evaluates `body`.
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize.width.isNaN)
    }

    func testCreateTraitSheetBuildsItsBody() throws {
        let editor = IdentityEditor(identity: try identity())
        render(CreateTraitSheet(editor: editor, isPresented: .constant(true)))
    }

    func testCreateBoundSheetBuildsItsBody() throws {
        let editor = IdentityEditor(identity: try identity())
        render(CreateBoundSheet(editor: editor, isPresented: .constant(true)))
    }

    func testEditBoundSheetBuildsItsBodyAndSeedsFromTheBound() throws {
        let bound = try JSONDecoder().decode(BoundRecord.self, from: Data("""
        {"id":19,"name":"no-network","description":"All outbound denied",
         "bound":{"network":{"actions":["all"]},"files":{"deny":["*.env"]}}}
        """.utf8))
        let editor = IdentityEditor(identity: try identity())
        render(EditBoundSheet(editor: editor, bound: bound, editingBound: .constant(bound)))
    }

    /// The panels host the sheets, so they get a layout pass too.
    func testPanelsBuildTheirBodies() throws {
        let editor = IdentityEditor(identity: try identity())
        render(IdentityTraitsPanel(editor: editor))
        render(IdentityBoundsPanel(editor: editor))
        render(IdentityInfoPanel(editor: editor))
        render(IdentityBagsPanel(editor: editor))
    }
}
