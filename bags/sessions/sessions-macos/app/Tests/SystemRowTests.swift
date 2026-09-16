import XCTest
@testable import BarrySessionsCore

/// Covers how `result` / `summary` / `init` messages are presented.
///
/// These three types share one branch in the message list but carry very
/// different content, and the API does not populate them uniformly.
final class SystemRowTests: XCTestCase {

    private func message(_ json: String) throws -> Message {
        try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }

    // MARK: - The blank-pill bug

    /// **Regression test for a user-visible bug.**
    ///
    /// The API spreads `status === "error" ? { error: text } : { result: text }`
    /// (`packages/db/src/messages.ts`), so a failed result carries **no**
    /// `result` and no `content` — only `error`. Reading `result ?? content`
    /// therefore rendered an empty pill for every failed session.
    func testFailedResultShowsErrorText() throws {
        let msg = try message("""
        {
          "type": "result",
          "sequence": 7,
          "status": "error",
          "error": "Session ended: rate limit exceeded"
        }
        """)

        XCTAssertEqual(
            msg.systemRowText,
            "Session ended: rate limit exceeded",
            """
            A failed result populates only `error`; falling back to \
            `result ?? content` alone renders a blank row.
            """
        )
        XCTAssertFalse(msg.systemRowText.isEmpty, "Failed result must never render empty.")
    }

    /// A failed result is prose, but must be styled as a failure so it does not
    /// read as ordinary output.
    func testFailedResultIsStyledAsFailure() throws {
        let msg = try message("""
        {"type": "result", "sequence": 7, "status": "error", "error": "boom"}
        """)
        XCTAssertEqual(msg.systemRowStyle, .failure)
    }

    // MARK: - Successful result

    func testSuccessfulResultUsesResultField() throws {
        let msg = try message("""
        {"type": "result", "sequence": 3, "status": "success", "result": "All tests passed."}
        """)
        XCTAssertEqual(msg.systemRowText, "All tests passed.")
        XCTAssertEqual(msg.systemRowStyle, .prose, "A result is the agent's final turn — markdown prose.")
    }

    // MARK: - Summary

    /// The summarizer prompt (`servers/api/src/session-summarizer.ts`) literally
    /// instructs the model to "Use plain markdown bullet points" and emits `###`
    /// headings, so summaries are markdown by construction.
    func testSummaryIsProse() throws {
        let msg = try message("""
        {
          "type": "summary",
          "sequence": 12,
          "content": "### Done\\n- Fixed the renderer\\n- Added tests"
        }
        """)
        XCTAssertEqual(msg.systemRowStyle, .prose)
        XCTAssertTrue(msg.systemRowText.contains("### Done"))
    }

    // MARK: - Init

    /// `init` is a fixed one-liner and should stay a compact centered notice —
    /// running it through a markdown renderer would be pure overhead.
    func testInitIsNotice() throws {
        let msg = try message("""
        {"type": "init", "sequence": 1, "content": "Session abc123 started"}
        """)
        XCTAssertEqual(msg.systemRowStyle, .notice)
        XCTAssertEqual(msg.systemRowText, "Session abc123 started")
    }

    // MARK: - Non-system rows

    func testTextMessageIsNotASystemRow() throws {
        let msg = try message("""
        {"type": "text", "role": "assistant", "sequence": 2, "content": "hello"}
        """)
        XCTAssertFalse(msg.isSystemRow)
        XCTAssertEqual(msg.systemRowStyle, .notice, "Non-system rows take the inert default.")
    }

    /// Nothing to show at all still yields empty string rather than crashing.
    func testEmptySystemRowDegradesToEmptyString() throws {
        let msg = try message("""
        {"type": "result", "sequence": 4}
        """)
        XCTAssertEqual(msg.systemRowText, "")
    }
}
