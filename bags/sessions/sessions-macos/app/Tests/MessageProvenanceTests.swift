import Foundation
import XCTest
@testable import BarrySessionsCore

/// Subagent work is persisted under the parent session, tagged with the id of
/// the Task tool call that spawned it. `MessagesPanel` keys its indent off
/// `parentToolUseId`, so the field has to survive decoding — `Message` decodes
/// by an explicit `CodingKeys` list, where a new field is silently dropped
/// unless it is added in both places.
final class MessageProvenanceTests: XCTestCase {
    private let decoder = JSONDecoder()

    private func decode(_ json: String) throws -> Message {
        try decoder.decode(Message.self, from: Data(json.utf8))
    }

    func testDecodesSubagentProvenance() throws {
        let msg = try decode(#"""
        {
          "type": "tool_start",
          "sessionId": "s1",
          "sequence": 4,
          "name": "Grep",
          "input": {"pattern": "retry"},
          "parentToolUseId": "toolu_task_abc",
          "createdAt": "2026-08-07T20:00:00.000Z"
        }
        """#)
        XCTAssertEqual(msg.parentToolUseId, "toolu_task_abc")
    }

    func testMainThreadMessageHasNoProvenance() throws {
        // Absent, not empty — the view branches on nil.
        let msg = try decode(#"""
        {
          "type": "text",
          "sessionId": "s1",
          "sequence": 1,
          "role": "assistant",
          "content": "main thread",
          "createdAt": "2026-08-07T20:00:00.000Z"
        }
        """#)
        XCTAssertNil(msg.parentToolUseId)
    }

    func testProvenanceDoesNotDisturbExistingFields() throws {
        // The field was added alongside tool decoding, which normalizes input
        // and result from arbitrary JSON shapes. Guard against regressing that.
        let msg = try decode(#"""
        {
          "type": "tool_start",
          "sessionId": "s1",
          "sequence": 2,
          "name": "Read",
          "input": {"file_path": "/tmp/auth.test.ts"},
          "result": "ok",
          "toolUseId": "t1",
          "parentToolUseId": "toolu_task_abc",
          "createdAt": "2026-08-07T20:00:00.000Z"
        }
        """#)
        XCTAssertEqual(msg.name, "Read")
        XCTAssertEqual(msg.result, "ok")
        XCTAssertTrue(msg.isToolCall)
        XCTAssertEqual(msg.toolInputSummary, "auth.test.ts")
        XCTAssertEqual(msg.parentToolUseId, "toolu_task_abc")
    }
}
