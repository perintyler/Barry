import XCTest
@testable import ActionsFeature

final class InputFieldTests: XCTestCase {
    /// The soft spelling from docs/actions.md: suggestions that do not
    /// constrain. It has no top-level `type`, so a parser that checked `type`
    /// first would fall through to `.json` and render a JSON box where the
    /// form's most-used control belongs.
    func testAnyOfEnumStringBecomesSuggestionsNotAClosedChoice() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "theme": [
                    "title": "Theme",
                    "anyOf": [
                        ["type": "string", "enum": ["propublica", "pudding"]],
                        ["type": "string"],
                    ],
                    "default": "surprise me",
                ],
            ],
        ])

        XCTAssertEqual(fields.count, 1)
        XCTAssertEqual(fields[0].kind, .suggestion(["propublica", "pudding"]))
        XCTAssertEqual(fields[0].title, "Theme")
        XCTAssertEqual(fields[0].defaultDisplay, "surprise me")
    }

    /// A bare enum is the one control that refuses what the user types.
    func testBareEnumIsAClosedChoice() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": ["imagery": ["enum": ["photography", "abstract"]]],
        ])
        XCTAssertEqual(fields[0].kind, .choice(["photography", "abstract"]))
    }

    func testScalarTypesMapToTheirControls() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "name": ["type": "string"],
                "count": ["type": "integer"],
                "ratio": ["type": "number"],
                "enabled": ["type": "boolean"],
            ],
        ])
        let byName = Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0.kind) })
        XCTAssertEqual(byName["name"], .text)
        XCTAssertEqual(byName["count"], .number(isInteger: true))
        XCTAssertEqual(byName["ratio"], .number(isInteger: false))
        XCTAssertEqual(byName["enabled"], .toggle)
    }

    /// A shape the form cannot model must still appear. A field that silently
    /// vanishes is indistinguishable from an action that never declared it.
    func testUnmodellableShapesFallBackToJsonRatherThanDisappearing() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "nested": ["type": "object", "properties": ["a": ["type": "string"]]],
                "list": ["type": "array", "items": ["type": "string"]],
                "either": ["oneOf": [["type": "string"], ["type": "number"]]],
            ],
        ])
        XCTAssertEqual(fields.count, 3)
        for field in fields {
            XCTAssertEqual(field.kind, .json, "\(field.name) should survive as raw JSON")
        }
    }

    func testRequiredIsCarriedThrough() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": ["window_days": ["type": "number"]],
            "required": ["window_days"],
        ])
        XCTAssertTrue(fields[0].isRequired)
        // No title in the schema, so the property name is humanized.
        XCTAssertEqual(fields[0].title, "Window days")
    }

    func testDescriptionBecomesHelpAndLongProseBecomesMultiline() {
        let long = String(repeating: "a", count: 130)
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": ["brief": ["type": "string", "description": long]],
        ])
        XCTAssertEqual(fields[0].help, long)
        XCTAssertEqual(fields[0].kind, .multiline)
    }

    /// The real merge-worktree schema (bags/coding), verbatim. Two string
    /// fields, one required — the shape most in-the-wild actions actually
    /// have, as opposed to the soft nine-field form this feature was designed
    /// around. Both must render.
    func testARealTwoFieldSchemaFromTheInstalledCatalog() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "branch": ["type": "string", "description": "Branch to merge, e.g. barry/x or feat/foo"],
                "repo": ["type": "string", "description": "Absolute path to the base repo. Defaults to the current repo."],
            ],
            "required": ["branch"],
        ])

        XCTAssertEqual(fields.map(\.name), ["branch", "repo"])
        XCTAssertEqual(fields.map(\.kind), [.text, .text])
        XCTAssertTrue(fields[0].isRequired)
        XCTAssertFalse(fields[1].isRequired)
        // No `title` in the schema, so both fall back to the humanized name.
        XCTAssertEqual(fields.map(\.title), ["Branch", "Repo"])
    }

    /// The digital-storytelling production form, as migrated. Nine soft
    /// fields, none required, every one defaulted — the shape this feature was
    /// designed around, so the parser must produce nine usable controls and
    /// not one JSON box.
    func testTheMigratedProductionFormParsesToUsableControls() {
        let soft: ([String], String) -> [String: Any] = { options, fallback in
            [
                "anyOf": [["type": "string", "enum": options], ["type": "string"]],
                "default": fallback,
            ]
        }
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "theme": soft(["snowfall", "pudding"], "surprise me"),
                "audience": ["type": "string", "default": "general"],
                "imagery": soft(["photography", "abstract"], "abstract"),
                "interactions": soft(["restrained", "rich"], "restrained"),
                "constraints": ["type": "string", "default": "none"],
            ],
        ])

        XCTAssertEqual(fields.count, 5)
        // Not one of them is required: every field is overrulable.
        XCTAssertTrue(fields.allSatisfy { !$0.isRequired })
        // And every one shows something rather than an empty box.
        XCTAssertTrue(fields.allSatisfy { $0.defaultDisplay != nil })
        // The soft ones must be combo boxes, not closed pickers — "surprise
        // me" is not in any enum, and typing a vibe must stay legal.
        let byName = Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0.kind) })
        XCTAssertEqual(byName["theme"], .suggestion(["snowfall", "pudding"]))
        XCTAssertEqual(byName["audience"], .text)
    }

    func testNoSchemaAndEmptySchemaBothYieldNoFields() {
        XCTAssertTrue(InputField.parse(schema: nil).isEmpty)
        XCTAssertTrue(InputField.parse(schema: ["type": "object"]).isEmpty)
        XCTAssertTrue(InputField.parse(schema: ["type": "object", "properties": [:]]).isEmpty)
    }

    func testFieldOrderIsStableAcrossParses() {
        let schema: [String: Any] = [
            "type": "object",
            "properties": ["z": ["type": "string"], "a": ["type": "string"], "m": ["type": "string"]],
        ]
        let once = InputField.parse(schema: schema).map(\.name)
        let twice = InputField.parse(schema: schema).map(\.name)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(once, ["a", "m", "z"])
    }
}

final class InputDraftTests: XCTestCase {
    private let fields = InputField.parse(schema: [
        "type": "object",
        "properties": [
            "theme": ["type": "string", "default": "surprise me"],
            "days": ["type": "integer"],
            "rich": ["type": "boolean"],
        ],
    ])

    /// THE invariant of the whole feature. A default is shown, never sent: an
    /// agent told the caller decided will not infer, so transmitting a
    /// placeholder silently disables the inference the action depends on.
    func testUntouchedFieldsAreOmittedEvenThoughTheyShowADefault() {
        let draft = InputDraft()
        XCTAssertTrue(draft.values(for: fields).isEmpty)
    }

    func testTypedTextIsSentUnderItsOwnName() {
        var draft = InputDraft()
        draft.text["theme"] = "propublica"
        XCTAssertEqual(draft.values(for: fields)["theme"] as? String, "propublica")
        // Still only the one field — typing in one does not commit the others.
        XCTAssertEqual(draft.values(for: fields).count, 1)
    }

    /// Typed, not stringified: the server validates against the declared JSON
    /// Schema, and `"7"` fails a `type: integer` check that `7` passes.
    func testNumbersAreSentAsNumbers() {
        var draft = InputDraft()
        draft.text["days"] = "7"
        XCTAssertEqual(draft.values(for: fields)["days"] as? Int, 7)
    }

    func testHalfTypedNumberIsSkippedRatherThanSentAsText() {
        var draft = InputDraft()
        draft.text["days"] = "1."
        XCTAssertNil(draft.values(for: fields)["days"])
    }

    /// A toggle has no empty state, so it needs the explicit touched bit — and
    /// "off" must be sendable, which an emptiness check could never express.
    func testAnExplicitlyTouchedFalseToggleIsStillSent() {
        var draft = InputDraft()
        draft.text["rich"] = "false"
        draft.touched.insert("rich")
        XCTAssertEqual(draft.values(for: fields)["rich"] as? Bool, false)
    }
}
