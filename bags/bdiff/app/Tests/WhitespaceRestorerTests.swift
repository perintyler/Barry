import Foundation
import Testing
@testable import BDiffCore

struct WhitespaceRestorerTests {
    private let marker = URL(string: "https://example.com/style")!

    /// Attach a Foundation-scope attribute so tests can verify styling survives.
    private func styled(_ text: String) -> AttributedString {
        var attr = AttributedString(text)
        attr.link = marker
        return attr
    }

    @Test func exactMatchPassesThrough() {
        let original = "    let x = 1"
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled(original))
        #expect(restored.map { String($0.characters) } == original)
    }

    @Test func restoresStrippedLeadingIndentation() {
        let original = "        return result"
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled("return result"))
        #expect(restored.map { String($0.characters) } == original)
    }

    @Test func restoresTabIndentation() {
        let original = "\t\tfoo()"
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled("foo()"))
        #expect(restored.map { String($0.characters) } == original)
    }

    @Test func restoresCollapsedInteriorWhitespace() {
        let original = "let x  =   1  // aligned"
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled("let x = 1 // aligned"))
        #expect(restored.map { String($0.characters) } == original)
    }

    @Test func restoresTabConvertedToSpace() {
        let original = "foo\tbar"
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled("foo bar"))
        #expect(restored.map { String($0.characters) } == original)
    }

    @Test func restoresTrailingWhitespace() {
        let original = "foo()   "
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled("foo()"))
        #expect(restored.map { String($0.characters) } == original)
    }

    @Test func preservesSyntaxAttributes() {
        let original = "    let x"
        var highlighted = styled("let")
        highlighted += AttributedString(" x")

        let restored = WhitespaceRestorer.restore(original: original, highlighted: highlighted)
        #expect(restored.map { String($0.characters) } == original)

        // The "let" keyword keeps its styling after restoration.
        let keywordRange = restored!.range(of: "let")!
        #expect(restored![keywordRange].runs.allSatisfy { $0.link == marker })

        // The restored indentation carries no styling.
        let indentEnd = restored!.range(of: "let")!.lowerBound
        #expect(restored![restored!.startIndex..<indentEnd].runs.allSatisfy { $0.link == nil })
    }

    @Test func rejectsDivergentContent() {
        let original = "    let x = 1"
        #expect(WhitespaceRestorer.restore(original: original, highlighted: styled("something else")) == nil)
    }

    @Test func rejectsExtraNonWhitespaceInHighlighted() {
        #expect(WhitespaceRestorer.restore(original: "foo", highlighted: styled("foobar")) == nil)
    }

    @Test func whitespaceOnlyOriginal() {
        let original = "    "
        let restored = WhitespaceRestorer.restore(original: original, highlighted: styled(""))
        #expect(restored.map { String($0.characters) } == original)
    }
}
