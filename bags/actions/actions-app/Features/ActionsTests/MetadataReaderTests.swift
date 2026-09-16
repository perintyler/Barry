import XCTest
@testable import ActionsFeature

final class MetadataReaderTests: XCTestCase {
    // The whole point of the input pane. These three must not collapse into
    // one another: an empty pane that means "predates capture" and one that
    // means "no inputs declared" would be indistinguishable on screen, which
    // is the failure this app is built to avoid.
    func testRunPredatingCaptureReportsNotRecorded() {
        let metadata: [String: Any] = ["legacySkill": false, "output_schema": ["type": "string"]]
        XCTAssertEqual(MetadataReader.inputSide(from: metadata), .notRecorded)
    }

    // wrap-up declares no inputs, so keying "was this captured" off `inputs`
    // rather than `prompt` would report every wrap-up run as uncaptured —
    // breaking the feature exactly where it is most used.
    func testCapturedRunWithoutInputsIsNotConfusedWithNotRecorded() {
        let metadata: [String: Any] = ["prompt": "# Wrap Up", "legacySkill": false]
        XCTAssertEqual(MetadataReader.inputSide(from: metadata), .noInputs(prompt: "# Wrap Up"))
    }

    func testCapturedRunWithInputs() {
        let metadata: [String: Any] = ["prompt": "P", "inputs": ["pr_number": 42]]
        XCTAssertEqual(
            MetadataReader.inputSide(from: metadata),
            .inputs(values: ["pr_number": "42"], prompt: "P")
        )
    }

    // An empty inputs object should read as "no inputs", not as an inputs
    // block with nothing in it.
    func testEmptyInputsObjectFallsBackToNoInputs() {
        let metadata: [String: Any] = ["prompt": "P", "inputs": [String: Any]()]
        XCTAssertEqual(MetadataReader.inputSide(from: metadata), .noInputs(prompt: "P"))
    }

    // An empty prompt is not evidence of capture — treating it as such would
    // render a blank Prompt pane and claim the run was recorded.
    func testEmptyPromptCountsAsNotRecorded() {
        XCTAssertEqual(MetadataReader.inputSide(from: ["prompt": ""]), .notRecorded)
    }

    func testTruncationFlagIsReadAndDefaultsFalse() {
        XCTAssertTrue(MetadataReader.promptTruncated(from: ["prompt_truncated": true]))
        XCTAssertFalse(MetadataReader.promptTruncated(from: ["prompt": "P"]))
    }

    // Plumbing keys describe how Barry ran the action, not what was asked of
    // it, so they stay out of the Input pane.
    func testExtrasExcludePlumbingButKeepUnknownKeys() {
        let metadata: [String: Any] = [
            "prompt": "P",
            "inputs": ["a": 1],
            "output_schema": ["type": "string"],
            "legacySkill": false,
            "provider": "claude",
            "some_future_key": "kept",
        ]

        let extras = MetadataReader.extras(from: metadata)

        XCTAssertEqual(extras, [RunDetail.Extra(key: "some_future_key", value: "kept")])
    }

    func testDisplayRendersJsonRatherThanSwiftDescriptions() {
        XCTAssertEqual(MetadataReader.display("plain"), "plain")
        XCTAssertEqual(MetadataReader.display(true), "true")
        XCTAssertEqual(MetadataReader.display(7), "7")
        XCTAssertEqual(MetadataReader.display(["b": 1, "a": 2]), #"{"a":2,"b":1}"#)
    }
}

final class RunStatusTests: XCTestCase {
    func testKnownStatusesParse() {
        XCTAssertEqual(RunStatus(wire: "complete"), .complete)
        XCTAssertEqual(RunStatus(wire: "failed"), .failed)
        XCTAssertEqual(RunStatus(wire: "started"), .started)
    }

    // A status this build has not heard of still describes a real run. Falling
    // back to `started` keeps it visible and open rather than dropping it from
    // a list that would then be quietly incomplete.
    func testUnknownStatusStaysVisibleAsOpen() {
        XCTAssertEqual(RunStatus(wire: "cancelled"), .started)
    }

    // REGRESSION: action_runs has no CHECK on status, and one legacy row holds
    // "completed" (not "complete"). While the contract typed status as an enum,
    // that single row made the generated decoder reject the ENTIRE 100-row
    // list — the app showed "Could not load" against a healthy API. The
    // contract now types status as a string so tolerance lives here.
    func testLegacyCompletedSpellingDoesNotBreakTheList() {
        XCTAssertEqual(RunStatus(wire: "completed"), .started)
    }
}

final class LoadStateTests: XCTestCase {
    // The guard: a failed fetch must never be representable as an empty
    // result, because on screen those two look identical.
    func testFailureIsNotAnEmptyLoad() {
        let failed = LoadState<[RunSummary]>.failed("401")
        XCTAssertNil(failed.value)
        XCTAssertEqual(failed.errorMessage, "401")

        let empty = LoadState<[RunSummary]>.loaded([])
        XCTAssertEqual(empty.value?.count, 0)
        XCTAssertNil(empty.errorMessage)
    }

    func testUnauthorizedIsNamedSoItCanBeActedOn() {
        struct Undocumented: Error {}
        let message = describeFetchFailure(URLError(.cannotConnectToHost))
        XCTAssertTrue(message.contains("com.barry.api"), message)
    }
}

final class CatalogEntryTests: XCTestCase {
    private func entry(description: String) -> CatalogEntry {
        CatalogEntry(
            name: "wrap-up", qualifiedName: "sessions:wrap-up", bag: "sessions",
            description: description, executable: false, inputNames: []
        )
    }

    // find_actions descriptions are written to be MATCHED, so they run to
    // paragraphs of "use when the user says…" phrasing. A list row wants the
    // first line, not the retrieval text.
    func testShortDescriptionTakesTheFirstLineOnly() {
        XCTAssertEqual(
            entry(description: "Summarize session work\n\nUse when the user says wrap up…").shortDescription,
            "Summarize session work"
        )
    }

    func testShortDescriptionLeavesASingleLineAlone() {
        XCTAssertEqual(entry(description: "Just one line").shortDescription, "Just one line")
    }
}

final class TriggerOutcomeTests: XCTestCase {
    // A trigger whose only feedback is a spinner vanishing is indistinguishable
    // from one that silently failed, so success carries the session id.
    func testSuccessNamesTheSessionAndActionSoItIsNotSilent() {
        let outcome = TriggerOutcome.started(sessionId: "sess_1", action: "wrap-up")

        guard case let .started(sessionId, action) = outcome else {
            return XCTFail("expected .started")
        }
        XCTAssertEqual(sessionId, "sess_1")
        XCTAssertEqual(action, "wrap-up")
    }

    // Failure must not be representable as idle — the same rule LoadState
    // follows, for the same reason.
    func testFailureIsDistinctFromIdle() {
        XCTAssertNotEqual(TriggerOutcome.failed("401"), .idle)
        XCTAssertNotEqual(TriggerOutcome.starting, .idle)
    }
}
