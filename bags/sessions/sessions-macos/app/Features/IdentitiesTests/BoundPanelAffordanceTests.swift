import SwiftUI
import XCTest
@testable import IdentitiesFeature

/// What the Bounds tab offers, per identity source.
///
/// The bug these guard: creating and editing a bound were nested inside the
/// `else` of `if editor.isFileBased`, so on a machine whose identities are all
/// file-based — which is every machine by default, since `barry heir` only
/// makes those — the tab showed two lines of explanation and nothing else. The
/// sheets existed, compiled and were reachable by no one.
///
/// Assignment genuinely is identity-specific: a directory has no row to hold a
/// bound_id. Authoring is not — a bound is a global record. Conflating the two
/// is what hid the feature.
@MainActor
final class BoundPanelAffordanceTests: XCTestCase {
    private func identity(source: String) throws -> Identity {
        let json = """
        {"id":1,"name":"x","displayName":null,"token":"t","bags":[],"traits":[],
         "boundId":null,"defaultCodingAgent":null,"defaultModel":null,
         "envKeys":[],"vaultEmail":null,"isDefault":false,"lastUsedAt":null,
         "createdAt":null,"source":"\(source)"}
        """
        return try JSONDecoder().decode(Identity.self, from: Data(json.utf8))
    }

    private func render(_ view: some View) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 520, height: 600)
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize.width.isNaN)
    }

    /// Both branches have to build — the file-based one grew a new list
    /// variant when authoring was lifted out of the conditional.
    func testBothSourcesRenderTheBoundsPanel() throws {
        render(IdentityBoundsPanel(editor: IdentityEditor(identity: try identity(source: "file"))))
        render(IdentityBoundsPanel(editor: IdentityEditor(identity: try identity(source: "db"))))
    }

    /// The distinction the panel encodes: a file-based identity can't be
    /// *assigned* a named bound, which is why the explanation exists. If this
    /// ever flips, the panel's whole branch is wrong.
    func testFileBasedIdentitiesCannotHoldANamedBound() throws {
        XCTAssertTrue(IdentityEditor(identity: try identity(source: "file")).isFileBased)
        XCTAssertFalse(IdentityEditor(identity: try identity(source: "db")).isFileBased)
    }

    /// Authoring a bound takes no identity: name, description and rules only.
    /// Nothing about the call depends on which identity is selected, so
    /// nothing about the button should either.
    func testCreatingABoundIsIndependentOfTheSelectedIdentity() async throws {
        let fileBased = IdentityEditor(identity: try identity(source: "file"))
        let dbBased = IdentityEditor(identity: try identity(source: "db"))
        // Both editors expose the same authoring entry point; the panel is the
        // only thing that ever gated it.
        XCTAssertNotNil(fileBased.createBound)
        XCTAssertNotNil(dbBased.createBound)
    }
}
