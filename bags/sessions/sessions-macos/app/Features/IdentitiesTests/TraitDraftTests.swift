import XCTest
@testable import IdentitiesFeature

final class TraitDraftTests: XCTestCase {
    /// The names bags already generate have to keep working — these are the
    /// shapes the picker is full of.
    func testAcceptsTheShapeBagsGenerate() {
        for name in ["git", "barry-core-read", "deploy-safe", "x9", "a"] {
            XCTAssertTrue(TraitDraft.isValidName(name), "rejected \(name)")
        }
    }

    /// Spaces, capitals and underscores are what a person types first, and all
    /// three break a name that has to survive yaml and argv.
    func testRejectsWhatPeopleActuallyType() {
        for name in ["Bad Name", "UPPER", "has space", "under_score", "-leading", "", "   "] {
            XCTAssertFalse(TraitDraft.isValidName(name), "accepted \(name)")
        }
    }

    func testTrimsSurroundingWhitespaceBeforeJudging() {
        XCTAssertTrue(TraitDraft.isValidName("  deploy-safe  "))
    }

    /// A trait with no namespaces resolves to no tools: it appears in every
    /// picker and does nothing when chosen.
    func testNamespacesAreRequired() {
        var draft = TraitDraft()
        draft.name = "deploy-safe"
        XCTAssertFalse(draft.isComplete)
        XCTAssertEqual(draft.blockingReason, "Pick at least one — a trait with no namespaces grants no tools.")

        draft.namespaces = ["git"]
        XCTAssertTrue(draft.isComplete)
        XCTAssertNil(draft.blockingReason)
    }

    func testBlockingReasonNamesTheFirstProblem() {
        var draft = TraitDraft()
        XCTAssertEqual(draft.blockingReason, "Name is required.")

        draft.name = "Bad Name"
        XCTAssertEqual(draft.blockingReason, "Lowercase letters, digits and hyphens only.")
    }

    /// Scopes are optional — a trait that only grants namespaces is ordinary.
    func testScopesAreOptional() {
        var draft = TraitDraft()
        draft.name = "git-only"
        draft.namespaces = ["git"]
        XCTAssertTrue(draft.isComplete)
    }
}
