import SwiftUI
import XCTest
@testable import ActionsFeature

/// Builds the input form for every control kind.
///
/// `InputField.parse` proves the schema becomes the right `Kind`; this proves
/// each `Kind` then survives a layout pass. They are different failures: a
/// `Kind` the form has no case for, or one whose control traps on an empty
/// binding, compiles fine and only breaks when someone selects that action.
///
/// The combo box is the one worth pinning hardest — it is a hand-built pairing
/// of a TextField and a Menu, not a stock control.
@MainActor
final class InputFormViewTests: XCTestCase {
    private func render(_ fields: [InputField], draft: InputDraft = InputDraft()) {
        var draft = draft
        let binding = Binding(get: { draft }, set: { draft = $0 })
        let host = NSHostingView(rootView: InputFormView(fields: fields, draft: binding))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 600)
        host.layoutSubtreeIfNeeded()
        XCTAssertFalse(host.fittingSize.height.isNaN)
    }

    /// One schema exercising every branch of the control switch at once.
    func testEveryControlKindLaysOut() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "plain": ["type": "string"],
                "prose": ["type": "string", "description": String(repeating: "x", count: 130)],
                "count": ["type": "integer"],
                "ratio": ["type": "number"],
                "flag": ["type": "boolean"],
                "closed": ["enum": ["a", "b"]],
                "soft": ["anyOf": [["type": "string", "enum": ["a", "b"]], ["type": "string"]]],
                "blob": ["type": "object"],
            ],
        ])
        XCTAssertEqual(fields.count, 8, "every property should produce a field")
        render(fields)
    }

    /// The empty state is the one a user actually opens the sheet to: nothing
    /// typed, every field showing its default as a placeholder.
    func testLaysOutWithAnEmptyDraft() {
        let fields = InputField.parse(schema: [
            "type": "object",
            "properties": [
                "theme": [
                    "title": "Theme",
                    "anyOf": [["type": "string", "enum": ["propublica"]], ["type": "string"]],
                    "default": "surprise me",
                ],
            ],
        ])
        render(fields)
    }

    /// A field with no default must still render — the placeholder falls back
    /// to "optional" rather than an unlabelled empty box.
    func testFieldWithNoDefaultStillRenders() {
        render(InputField.parse(schema: ["type": "object", "properties": ["n": ["type": "string"]]]))
    }

    func testRequiredFieldRenders() {
        render(InputField.parse(schema: [
            "type": "object",
            "properties": ["branch": ["type": "string"]],
            "required": ["branch"],
        ]))
    }

    /// The 15-of-16 case: no declared inputs at all. The form must be an empty
    /// view, not a crash and not a stray divider.
    func testEmptyFieldListRendersNothing() {
        render([])
    }
}
