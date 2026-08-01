import BarryKit
import Foundation
import XCTest

final class ContractDecodeTests: XCTestCase {
    private let decoder: JSONDecoder = {
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
    }()

    func testSessionListDecodesCanonicalResponse() throws {
        let json = #"""
        {
          "sessions": [{
            "id": "session-1",
            "name": "Contract check",
            "systemPrompt": "Verify the client",
            "summary": null,
            "repoPath": "/tmp/project",
            "profileId": 1,
            "status": "running",
            "traits": ["core"],
            "scope": null,
            "pinned": false,
            "useWorktree": false,
            "worktreeStatus": null,
            "worktreePath": null,
            "baseRepoPath": null,
            "source": "web",
            "provider": "codex",
            "model": null,
            "messageCount": 2,
            "lastMessageAt": "2026-07-14T20:00:00.123Z",
            "statusUpdate": {
              "summary": "CI passed, merging",
              "phase": "complete",
              "updatedAt": "2026-07-14T20:05:00.000Z"
            },
            "createdAt": "2026-07-14T19:00:00.456Z",
            "startedAt": "2026-07-14T19:01:00.789Z"
          }],
          "nextCursor": "cursor-2"
        }
        """#

        let response = try decoder.decode(
            Components.Schemas.SessionListResponse.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(response.sessions.count, 1)
        XCTAssertEqual(response.sessions[0].id, "session-1")
        XCTAssertEqual(response.nextCursor, "cursor-2")
        XCTAssertEqual(response.sessions[0].statusUpdate?.summary, "CI passed, merging")
        XCTAssertEqual(response.sessions[0].statusUpdate?.phase, "complete")
    }

    func testMessageListDecodesCanonicalEventResponse() throws {
        let json = #"""
        {
          "messages": [{
            "type": "tool_start",
            "sessionId": "session-1",
            "name": "Edit",
            "input": {"file_path": "/tmp/example.ts"},
            "result": null,
            "hasDetail": true,
            "sequence": 23,
            "createdAt": "2026-07-15T03:27:12.686Z"
          }],
          "nextSequence": 23,
          "hasMore": true
        }
        """#

        let response = try decoder.decode(
            Components.Schemas.MessageListResponse.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(response.messages.count, 1)
        XCTAssertEqual(response.messages[0]._type.rawValue, "tool_start")
        XCTAssertEqual(response.messages[0].sequence, 23)
    }

    func testProblemDetailsDecodesCanonicalError() throws {
        let json = #"{"type":"about:blank","title":"Not Found","status":404,"detail":"Session not found"}"#
        let problem = try decoder.decode(Components.Schemas.ProblemDetails.self, from: Data(json.utf8))
        XCTAssertEqual(problem.status, 404)
        XCTAssertEqual(problem.title, "Not Found")
    }
}
