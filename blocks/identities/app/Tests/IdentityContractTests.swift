import BarryKit
import Foundation
import XCTest

final class IdentityContractTests: XCTestCase {
    /// Identities come back under a `identities` key.
    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { value in
            let container = try value.singleValueContainer()
            let string = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = formatter.date(from: string) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO-8601 timestamp with fractional seconds"
                )
            }
            return date
        }
        return decoder
    }

    func testBarryListDecodesCanonicalResponse() throws {
        let json = #"""
        {"identities":[{
          "id":1,
          "token":"profile-token",
          "name":"default",
          "blocks":["filesystem"],
          "traits":["core"],
          "scopeId":null,
          "defaultCodingAgent":"codex",
          "defaultModel":null,
          "envKeys":[],
          "vaultEmail":null,
          "isDefault":true,
          "createdAt":"2026-07-14T20:00:00.123Z",
          "lastUsedAt":null
        }]}
        """#
        let response = try decoder().decode(
            Components.Schemas.IdentityListResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(response.identities.count, 1)
        XCTAssertEqual(response.identities[0].defaultCodingAgent, .codex)
        XCTAssertTrue(response.identities[0].isDefault)
    }

    /// `source` tells the UI whether a Identity is editable as a file. It must
    /// survive the generated OpenAPI types, which is what proves the spec was
    /// regenerated after the contract change.
    func testBarryDecodesFileSource() throws {
        let json = #"""
        {"identities":[{
          "id":1234567890,
          "token":"prf_abc123",
          "name":"goode",
          "blocks":[],
          "traits":["coding"],
          "scopeId":null,
          "defaultCodingAgent":null,
          "defaultModel":"claude-sonnet-4-20250514",
          "envKeys":["ANTHROPIC_API_KEY"],
          "vaultEmail":null,
          "isDefault":false,
          "createdAt":null,
          "lastUsedAt":null,
          "source":"file"
        }]}
        """#
        let response = try decoder().decode(
            Components.Schemas.IdentityListResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(response.identities[0].source, .file)
    }

    /// Older API builds predate the field entirely, so it has to stay optional.
    func testBarryDecodesWithoutSource() throws {
        let json = #"""
        {"identities":[{
          "id":1,
          "token":"profile-token",
          "name":"default",
          "blocks":[],
          "traits":[],
          "scopeId":null,
          "defaultCodingAgent":null,
          "defaultModel":null,
          "envKeys":[],
          "vaultEmail":null,
          "isDefault":false,
          "createdAt":null,
          "lastUsedAt":null
        }]}
        """#
        let response = try decoder().decode(
            Components.Schemas.IdentityListResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(response.identities[0].source)
    }

    /// A PATCH returns the updated Identity plus any non-fatal warnings. The
    /// endpoint was typed as an empty ActionAck for a long time, so no client
    /// could surface one — this pins the shape that makes it reachable.
    func testUpdateResponseCarriesWarnings() throws {
        let json = #"""
        {"identity":{
          "id":16,"name":"bgoode","displayName":"Identity B. Goode","token":"prf_x",
          "blocks":[],"traits":[],"scopeId":null,"defaultCodingAgent":null,
          "defaultModel":"claude-sonnet-4-20250514","envKeys":[],"vaultEmail":null,
          "isDefault":true,"createdAt":null,"lastUsedAt":null
        },"warnings":[{
          "kind":"unknown-model",
          "message":"Unknown model id 'claude-sonnet-4-20250514' — not in the curated catalog"
        }]}
        """#
        let response = try decoder().decode(
            Components.Schemas.IdentityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(response.warnings?.count, 1)
        XCTAssertEqual(response.warnings?.first?.kind, "unknown-model")
        XCTAssertNil(response.warnings?.first?.hint)
        XCTAssertEqual(response.identity.displayName, "Identity B. Goode")
    }

    /// A save with nothing to report must leave the banner empty rather than
    /// showing an empty warning.
    func testUpdateResponseWithoutWarnings() throws {
        let json = #"""
        {"identity":{
          "id":16,"name":"bgoode","displayName":null,"token":"prf_x",
          "blocks":[],"traits":[],"scopeId":null,"defaultCodingAgent":null,
          "defaultModel":"claude-opus-4-6","envKeys":[],"vaultEmail":null,
          "isDefault":true,"createdAt":null,"lastUsedAt":null
        }}
        """#
        let response = try decoder().decode(
            Components.Schemas.IdentityResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(response.warnings)
        XCTAssertNil(response.identity.displayName)
    }

}
