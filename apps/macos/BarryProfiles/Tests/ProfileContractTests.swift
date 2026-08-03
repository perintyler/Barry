import BarryKit
import Foundation
import XCTest

final class ProfileContractTests: XCTestCase {
    func testProfileListDecodesCanonicalResponse() throws {
        let json = #"""
        {"profiles":[{
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
        let response = try decoder.decode(
            Components.Schemas.ProfileListResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(response.profiles.count, 1)
        XCTAssertEqual(response.profiles[0].defaultCodingAgent, .codex)
        XCTAssertTrue(response.profiles[0].isDefault)
    }
}
