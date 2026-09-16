import XCTest
@testable import BarrySessionsCore

/// astra review F14: before this fix, `buildSegments(messages)` re-walked and
/// re-allocated the ENTIRE transcript on every mutation — the initial load,
/// every 5s poll tick, every `loadOlder` page, every tool-detail expand. A
/// long-running session's per-mutation cost grew without bound in the message
/// count, not in the size of what actually changed.
///
/// These tests pin two properties for `appendSegments`/`prependSegments`:
/// 1. **Correctness** — the incrementally patched result is IDENTICAL to a
///    full `buildSegments` rebuild, across boundary shapes that stress the
///    turn-merge logic (same speaker across the seam, different speaker,
///    tool rows at the seam, empty existing/new lists).
/// 2. **Boundary-only cost** — patching a small batch onto a large existing
///    list only re-groups the small batch (plus, when merging, the one
///    turn at the seam) — never the untouched bulk. Measured via
///    `MessageGroupingMetrics.messagesGrouped`, a message count, not a timer:
///    a slow CI box does not make this test flaky, and a regression back to
///    "rebuild everything" fails it regardless of machine speed.
final class ConversationSegmentsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        MessageGroupingMetrics.reset()
    }

    // MARK: - Fixtures

    /// An alternating-speaker transcript: user/agent turns of `turnLength`
    /// messages each, with a tool row every `toolEvery` turns. Deterministic
    /// (no `Date()`/`UUID` in content) so equivalence checks are exact.
    private func makeTranscript(
        messageCount: Int,
        startingAt startSeq: Int = 0,
        turnLength: Int = 3,
        toolEvery: Int = 5
    ) -> [Message] {
        var messages: [Message] = []
        var turnIndex = 0
        var seq = startSeq
        while messages.count < messageCount {
            if toolEvery > 0 && turnIndex > 0 && turnIndex % toolEvery == 0 {
                messages.append(Message(
                    type: "tool_start", sequence: seq, createdAt: isoTimestamp(seq),
                    name: "Read", input: "{}"
                ))
                seq += 1
                turnIndex += 1
                continue
            }
            let role = turnIndex % 2 == 0 ? "user" : "assistant"
            for _ in 0..<turnLength where messages.count < messageCount {
                messages.append(Message(
                    type: "text", sequence: seq, createdAt: isoTimestamp(seq),
                    role: role, content: "message \(seq)"
                ))
                seq += 1
            }
            turnIndex += 1
        }
        return messages
    }

    /// Seconds-granularity, monotonically increasing, deliberately dense
    /// (no >5min gaps) so pill placement is driven by turn/speaker structure
    /// in most fixtures — tests that need a pill gap build one explicitly.
    private func isoTimestamp(_ sequence: Int) -> String {
        let date = Date(timeIntervalSince1970: 1_700_000_000 + Double(sequence))
        return ISO8601DateFormatter().string(from: date)
    }

    // MARK: - Equivalence: append

    func testAppendMatchesFullRebuild_sameSpeakerContinuesLastTurn() {
        let existing = makeTranscript(messageCount: 30)
        let more = makeTranscript(messageCount: 6, startingAt: 30, turnLength: 6, toolEvery: 0)
        // `more`'s first (only) turn is "user" — force it to match whatever
        // speaker `existing`'s last turn actually is, so this case reliably
        // exercises the merge path regardless of makeTranscript's internals.
        let existingSegments = buildSegments(existing)
        guard case .turn(let lastTurn) = existingSegments.last!.segment else {
            XCTFail("fixture must end on a turn for this case"); return
        }
        let continuation = more.map { msg in
            Message(type: msg.type, sequence: msg.sequence, createdAt: msg.createdAt,
                    role: lastTurn.speaker == .user ? "user" : "assistant", content: msg.content)
        }

        let patched = appendSegments(to: existingSegments, appending: continuation)
        let rebuilt = buildSegments(existing + continuation)

        assertSegmentsEqual(patched, rebuilt)
    }

    func testAppendMatchesFullRebuild_differentSpeakerStartsNewTurn() {
        let existing = makeTranscript(messageCount: 30)
        let existingSegments = buildSegments(existing)
        guard case .turn(let lastTurn) = existingSegments.last!.segment else {
            XCTFail("fixture must end on a turn for this case"); return
        }
        let otherRole = lastTurn.speaker == .user ? "assistant" : "user"
        let more = (0..<4).map { i in
            Message(type: "text", sequence: 30 + i, createdAt: isoTimestamp(30 + i),
                    role: otherRole, content: "reply \(i)")
        }

        let patched = appendSegments(to: existingSegments, appending: more)
        let rebuilt = buildSegments(existing + more)

        assertSegmentsEqual(patched, rebuilt)
    }

    func testAppendMatchesFullRebuild_toolRowAtTheSeam() {
        let existing = makeTranscript(messageCount: 20)
        let existingSegments = buildSegments(existing)
        let more = [Message(type: "tool_start", sequence: 20, createdAt: isoTimestamp(20), name: "Grep", input: "{}")]

        let patched = appendSegments(to: existingSegments, appending: more)
        let rebuilt = buildSegments(existing + more)

        assertSegmentsEqual(patched, rebuilt)
    }

    func testAppendOntoEmptyExistingListEqualsBuildSegments() {
        let more = makeTranscript(messageCount: 10)
        let patched = appendSegments(to: [], appending: more)
        let rebuilt = buildSegments(more)
        assertSegmentsEqual(patched, rebuilt)
    }

    func testAppendingEmptyBatchIsANoOp() {
        let existing = makeTranscript(messageCount: 10)
        let existingSegments = buildSegments(existing)
        let patched = appendSegments(to: existingSegments, appending: [])
        XCTAssertEqual(patched.map(\.id), existingSegments.map(\.id))
    }

    // MARK: - Equivalence: prepend

    func testPrependMatchesFullRebuild_sameSpeakerMergesIntoFirstTurn() {
        let existing = makeTranscript(messageCount: 30, startingAt: 100)
        let existingSegments = buildSegments(existing)
        guard case .turn(let firstTurn) = existingSegments.first!.segment else {
            XCTFail("fixture must start on a turn for this case"); return
        }
        let older = (0..<5).map { i in
            Message(type: "text", sequence: 95 + i, createdAt: isoTimestamp(95 + i),
                    role: firstTurn.speaker == .user ? "user" : "assistant", content: "older \(i)")
        }

        let patched = prependSegments(to: existingSegments, prepending: older)
        let rebuilt = buildSegments(older + existing)

        assertSegmentsEqual(patched, rebuilt)
    }

    func testPrependMatchesFullRebuild_differentSpeakerStaysSeparate() {
        let existing = makeTranscript(messageCount: 30, startingAt: 100)
        let existingSegments = buildSegments(existing)
        guard case .turn(let firstTurn) = existingSegments.first!.segment else {
            XCTFail("fixture must start on a turn for this case"); return
        }
        let otherRole = firstTurn.speaker == .user ? "assistant" : "user"
        let older = (0..<4).map { i in
            Message(type: "text", sequence: 96 + i, createdAt: isoTimestamp(96 + i),
                    role: otherRole, content: "older \(i)")
        }

        let patched = prependSegments(to: existingSegments, prepending: older)
        let rebuilt = buildSegments(older + existing)

        assertSegmentsEqual(patched, rebuilt)
    }

    func testPrependMatchesFullRebuild_toolRowAtTheSeam() {
        let existing = makeTranscript(messageCount: 20, startingAt: 50)
        let existingSegments = buildSegments(existing)
        let older = [Message(type: "tool_start", sequence: 49, createdAt: isoTimestamp(49), name: "Bash", input: "{}")]

        let patched = prependSegments(to: existingSegments, prepending: older)
        let rebuilt = buildSegments(older + existing)

        assertSegmentsEqual(patched, rebuilt)
    }

    func testPrependOntoEmptyExistingListEqualsBuildSegments() {
        let older = makeTranscript(messageCount: 10)
        let patched = prependSegments(to: [], prepending: older)
        let rebuilt = buildSegments(older)
        assertSegmentsEqual(patched, rebuilt)
    }

    func testPrependingEmptyBatchIsANoOp() {
        let existing = makeTranscript(messageCount: 10, startingAt: 50)
        let existingSegments = buildSegments(existing)
        let patched = prependSegments(to: existingSegments, prepending: [])
        XCTAssertEqual(patched.map(\.id), existingSegments.map(\.id))
    }

    /// A >5min gap right at the prepend seam must produce a timestamp pill on
    /// the (possibly merged) boundary segment, same as a full rebuild would —
    /// the pill's inputs are exactly the two neighbors at the seam, which is
    /// precisely what an incremental patch risks getting wrong.
    func testPrependAcrossATimeGapMatchesFullRebuild() {
        let existing = [
            Message(type: "text", sequence: 10, createdAt: "2026-01-01T12:10:00Z", role: "user", content: "later")
        ]
        let existingSegments = buildSegments(existing)
        let older = [
            Message(type: "text", sequence: 9, createdAt: "2026-01-01T12:00:00Z", role: "user", content: "earlier")
        ]

        let patched = prependSegments(to: existingSegments, prepending: older)
        let rebuilt = buildSegments(older + existing)

        assertSegmentsEqual(patched, rebuilt)
    }

    // MARK: - Boundary-only cost (1k/10k fixtures)

    func testAppendOnA1kTranscriptOnlyGroupsTheNewBatch() {
        let existing = makeTranscript(messageCount: 1000)
        let existingSegments = buildSegments(existing)
        let batch = makeTranscript(messageCount: 8, startingAt: 1000, turnLength: 8, toolEvery: 0)

        MessageGroupingMetrics.reset()
        _ = appendSegments(to: existingSegments, appending: batch)

        // Only the new batch (and, if it merges, the seam's existing turn —
        // bounded by turnLength, never by the transcript size) was grouped.
        XCTAssertLessThan(
            MessageGroupingMetrics.messagesGrouped, 100,
            "appendSegments re-grouped far more than the new batch — the incremental patch fell back to rebuilding the transcript"
        )
    }

    func testAppendOnA10kTranscriptCostDoesNotScaleWithTranscriptSize() {
        let small = makeTranscript(messageCount: 1000)
        let large = makeTranscript(messageCount: 10000)
        let batch = makeTranscript(messageCount: 8, startingAt: 20000, turnLength: 8, toolEvery: 0)
        // Build both segment lists BEFORE resetting the counter — the
        // rebuild itself is O(n) (proven by the negative control below) and
        // must not be attributed to the append it precedes.
        let smallSegments = buildSegments(small)
        let largeSegments = buildSegments(large)

        MessageGroupingMetrics.reset()
        _ = appendSegments(to: smallSegments, appending: batch)
        let costAfterSmall = MessageGroupingMetrics.messagesGrouped

        MessageGroupingMetrics.reset()
        _ = appendSegments(to: largeSegments, appending: batch)
        let costAfterLarge = MessageGroupingMetrics.messagesGrouped

        XCTAssertEqual(
            costAfterSmall, costAfterLarge,
            "append cost must depend only on the new batch, not on the existing transcript's size (1k vs 10k)"
        )
    }

    func testLoadOlderPageOnA10kTranscriptOnlyGroupsThePage() {
        let existing = makeTranscript(messageCount: 10000, startingAt: 1000)
        let existingSegments = buildSegments(existing)
        let page = makeTranscript(messageCount: 50, startingAt: 950, turnLength: 10, toolEvery: 0)

        MessageGroupingMetrics.reset()
        _ = prependSegments(to: existingSegments, prepending: page)

        XCTAssertLessThan(
            MessageGroupingMetrics.messagesGrouped, 200,
            "prependSegments (loadOlder's path) re-grouped far more than the loaded page — this is the F14 regression, on the harder-to-patch side"
        )
    }

    /// Negative control for the cost tests above: proves the counter and the
    /// fixtures actually discriminate, by measuring `buildSegments` itself
    /// (which is genuinely O(n)) and confirming its cost DOES scale with
    /// transcript size — so "cost didn't scale" above is a property of the
    /// incremental functions, not an artifact of a counter that never moves.
    func testFullRebuildCostDoesScaleWithTranscriptSize_negativeControl() {
        let small = makeTranscript(messageCount: 1000)
        let large = makeTranscript(messageCount: 10000)

        MessageGroupingMetrics.reset()
        _ = buildSegments(small)
        let costSmall = MessageGroupingMetrics.messagesGrouped

        MessageGroupingMetrics.reset()
        _ = buildSegments(large)
        let costLarge = MessageGroupingMetrics.messagesGrouped

        XCTAssertEqual(costSmall, 1000)
        XCTAssertEqual(costLarge, 10000)
        XCTAssertGreaterThan(costLarge, costSmall, "precondition: buildSegments cost must scale with input size, or the tests above prove nothing")
    }

    // MARK: - Helpers

    private func assertSegmentsEqual(_ a: [RenderedSegment], _ b: [RenderedSegment], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.count, b.count, "segment count differs", file: file, line: line)
        for (lhs, rhs) in zip(a, b) {
            XCTAssertEqual(lhs.id, rhs.id, "segment id differs", file: file, line: line)
            XCTAssertEqual(lhs.timestampPill, rhs.timestampPill, "pill differs for \(lhs.id)", file: file, line: line)
            XCTAssertEqual(lhs.prevIsTurn, rhs.prevIsTurn, "prevIsTurn differs for \(lhs.id)", file: file, line: line)
            XCTAssertEqual(lhs.nextIsTurn, rhs.nextIsTurn, "nextIsTurn differs for \(lhs.id)", file: file, line: line)
            XCTAssertEqual(messageSequences(lhs.segment), messageSequences(rhs.segment), "member messages differ for \(lhs.id)", file: file, line: line)
        }
    }

    private func messageSequences(_ kind: SegmentKind) -> [Int] {
        switch kind {
        case .turn(let t): return t.messages.map(\.sequence)
        case .toolRow(let m): return [m.sequence]
        }
    }
}
