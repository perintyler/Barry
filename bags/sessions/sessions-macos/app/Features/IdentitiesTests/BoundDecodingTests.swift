import XCTest
@testable import IdentitiesFeature

/// Decoding tests for the bound model.
///
/// These exist because the edit sheet re-encodes `AgentBound` and PATCHes the
/// result, so any key the model fails to decode is *erased* on the next save
/// rather than merely hidden. `network` was exactly that: real bounds use it,
/// the model didn't have it, and editing one would have deleted its only rule.
final class BoundDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> BoundRecord {
        try JSONDecoder().decode(BoundRecord.self, from: Data(json.utf8))
    }

    func testNetworkRulesSurviveDecodeAndReencode() throws {
        let record = try decode("""
        {"id":19,"name":"no-network","description":"All outbound network access denied",
         "bound":{"network":{"actions":["all"]}}}
        """)
        XCTAssertEqual(record.bound.network?.actions, ["all"])

        // The round trip the edit sheet performs.
        let reencoded = try JSONEncoder().encode(record.bound)
        let back = try JSONDecoder().decode(BoundRecord.AgentBound.self, from: reencoded)
        XCTAssertEqual(back.network?.actions, ["all"], "network rules were dropped by the round trip")
    }

    func testFileAndBashDenyListsDecode() throws {
        let record = try decode("""
        {"id":3,"name":"no-secrets","description":null,
         "bound":{"files":{"deny":["*.env",".ssh/**"]},"bash":{"deny":["curl *"]},
                  "deniedTools":["Write"],"deniedAccess":["write"]}}
        """)
        XCTAssertEqual(record.bound.files?.deny, ["*.env", ".ssh/**"])
        XCTAssertEqual(record.bound.bash?.deny, ["curl *"])
        XCTAssertEqual(record.bound.deniedTools, ["Write"])
        XCTAssertEqual(record.bound.deniedAccess, ["write"])
    }

    /// Every rule kind reaches the pill list, including network — the display
    /// is what tells a user the rule is there at all.
    func testDenyPillsCoverEveryRuleKind() throws {
        let record = try decode("""
        {"id":1,"name":"everything","description":null,
         "bound":{"deniedTools":["Bash"],"deniedAccess":["write"],
                  "files":{"deny":["*.env"]},"bash":{"deny":["rm *"]},
                  "network":{"actions":["all"]}}}
        """)
        let kinds = Set(record.denyPills.map(\.kind))
        XCTAssertEqual(kinds, [.tool, .access, .filePattern, .bashPattern, .network])
        XCTAssertEqual(record.denyPills.count, 5)
    }

    func testEmptyBoundDecodesWithoutRules() throws {
        let record = try decode(#"{"id":9,"name":"open","description":null,"bound":{}}"#)
        XCTAssertTrue(record.denyPills.isEmpty)
        XCTAssertNil(record.bound.network)
    }
}

/// The network form is a fixed set of tags, not free text.
final class NetworkActionTests: XCTestCase {
    /// `all` expands to `write` + `read` server-side, and those to the leaves.
    /// Offering only the parents keeps the form honest: a leaf like `dns` is
    /// denialble but rarely meant, and a mistyped tag denies nothing at all.
    func testOffersTheParentTagsOnly() {
        XCTAssertEqual(BoundRecord.AgentBound.networkActionChoices, ["all", "write", "read"])
    }

    /// Every offered tag has to survive the encode the sheets perform.
    func testEachChoiceRoundTrips() throws {
        for action in BoundRecord.AgentBound.networkActionChoices {
            let rules = BoundRecord.AgentBound.NetworkRules(actions: [action])
            let data = try JSONEncoder().encode(rules)
            let back = try JSONDecoder().decode(BoundRecord.AgentBound.NetworkRules.self, from: data)
            XCTAssertEqual(back.actions, [action])
        }
    }
}
