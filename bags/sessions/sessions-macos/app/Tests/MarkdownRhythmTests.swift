import XCTest
import AppKit
import SwiftUI
@testable import Components

/// Guards the invariants behind message rendering.
///
/// These exist because each one was a real, shipped defect that was invisible
/// in code review — the app looked "fine but ugly" and nobody could say why.
final class MarkdownRhythmTests: XCTestCase {

    // MARK: - Vertical rhythm

    /// **The core invariant.** The gap between two blocks must exceed the gap
    /// between two wrapped lines inside one block.
    ///
    /// When this inverts, a wrapped sentence reads as two paragraphs and a
    /// bulleted list reads as unrelated fragments. The original theme used
    /// `relativeLineSpacing(.em(0.75))` with a 4pt paragraph margin — i.e.
    /// 10.5pt *inside* a paragraph vs 4pt *between* paragraphs — which is
    /// exactly backwards and was the single largest readability defect.
    func testParagraphGapExceedsInternalLineGap() {
        let internalGap = MarkdownTokens.Space.bodyLineSpacing * MarkdownTokens.Size.body
        XCTAssertGreaterThan(
            MarkdownTokens.Space.paragraph,
            internalGap,
            """
            Paragraph spacing (\(MarkdownTokens.Space.paragraph)pt) must exceed \
            the gap between wrapped lines (\(internalGap)pt), or wrapped text \
            reads as separate paragraphs.
            """
        )
    }

    /// Same rule one level down: list items are closer to each other than
    /// paragraphs are, so a list coheres as a single object.
    func testListItemGapIsTighterThanParagraphGap() {
        XCTAssertLessThan(
            MarkdownTokens.Space.listItem,
            MarkdownTokens.Space.paragraph,
            "List items must sit tighter than paragraphs so a list reads as one unit."
        )
    }

    /// A heading must bind *downward* to the section it introduces. Equal
    /// spacing above and below leaves it floating ambiguously between two
    /// sections — the most common tell of amateur markdown rendering.
    func testHeadingSpacingIsAsymmetric() {
        XCTAssertGreaterThan(
            MarkdownTokens.Space.headingTop,
            MarkdownTokens.Space.headingBottom * 2,
            "Space above a heading should be well over twice the space below it."
        )
        XCTAssertGreaterThan(
            MarkdownTokens.Space.headingTopTight,
            MarkdownTokens.Space.headingBottom,
            "Even the tight heading variant must bind downward."
        )
    }

    /// Leading should land in the long-form reading band. `relativeLineSpacing`
    /// is *extra* space on top of the natural line height, so the effective
    /// line-height multiple is roughly `1 + value`.
    func testBodyLeadingIsInReadableRange() {
        let effective = 1.0 + MarkdownTokens.Space.bodyLineSpacing
        XCTAssertGreaterThanOrEqual(effective, 1.20, "Leading below ~1.2 is cramped for long-form text.")
        XCTAssertLessThanOrEqual(effective, 1.60, "Leading above ~1.6 breaks paragraphs into stripes.")
    }

    // MARK: - Type scale

    /// Headings must be visibly larger than body text. The original theme had
    /// h3 at 13pt against a 14pt body — *smaller* than the text it headed —
    /// and h4 fell through to a default identical to body.
    func testHeadingsOutrankBodyText() {
        XCTAssertGreaterThan(MarkdownTokens.Size.h1, MarkdownTokens.Size.h2)
        XCTAssertGreaterThan(MarkdownTokens.Size.h2, MarkdownTokens.Size.h3)
        XCTAssertGreaterThan(MarkdownTokens.Size.h3, MarkdownTokens.Size.body,
                             "h3 must be larger than body text, not smaller.")
        XCTAssertGreaterThanOrEqual(MarkdownTokens.Size.h4, MarkdownTokens.Size.body)
    }

    /// Monospace reads optically larger than a sans at the same point size.
    func testCodeIsOpticallyMatchedToBody() {
        XCTAssertGreaterThanOrEqual(MarkdownTokens.Size.codeEm, 0.82)
        XCTAssertLessThanOrEqual(MarkdownTokens.Size.codeEm, 0.92)
    }

    // MARK: - Fonts

    /// The bug that started all of this.
    ///
    /// `InterVariable.ttf` registers under the CoreText family **"Inter
    /// Variable"**. The theme asked for `"Inter"`, which resolves to nil, so
    /// every message silently fell back to the system font — and because the
    /// custom family never resolved, bold/semibold synthesis was lost too:
    /// `**bold**` and every heading weight rendered as plain body text.
    func testBundledFontFamilyNamesResolve() throws {
        try registerBundledFontsForTesting()

        XCTAssertNotNil(
            NSFont(name: MarkdownTokens.Family.sans, size: 14),
            """
            Sans family '\(MarkdownTokens.Family.sans)' does not resolve. \
            Use the CoreText family name, not the marketing name — a bad name \
            here silently disables bold and heading weights.
            """
        )
        XCTAssertNotNil(
            NSFont(name: MarkdownTokens.Family.mono, size: 14),
            "Mono family '\(MarkdownTokens.Family.mono)' does not resolve."
        )
    }

    /// Bold must actually be synthesisable from the sans family, otherwise
    /// strong emphasis and headings render at regular weight.
    func testSansFamilySupportsBold() throws {
        try registerBundledFontsForTesting()
        let base = try XCTUnwrap(NSFont(name: MarkdownTokens.Family.sans, size: 14))
        let bold = NSFontManager.shared.convert(base, toHaveTrait: .boldFontMask)
        XCTAssertNotEqual(bold.fontName, base.fontName,
                          "Sans family must provide a bold face for **strong** text.")
    }

    /// `AppFont` and the markdown theme must resolve through the *same* family
    /// constants. They used to be declared separately — `AppFont` in the app
    /// target and string literals in `Components` — which is exactly how the
    /// theme drifted to the unresolvable `"Inter"` without anyone noticing.
    func testAppFontResolvesBundledFamilies() throws {
        try registerBundledFontsForTesting()

        let sans = AppFont.sans(size: 14)
        let systemSans = Font.system(size: 14)
        XCTAssertNotEqual(
            sans, systemSans,
            "AppFont.sans fell back to the system font — the bundled family did not resolve."
        )

        let mono = AppFont.mono(size: 12)
        let systemMono = Font.system(size: 12, design: .monospaced)
        XCTAssertNotEqual(
            mono, systemMono,
            "AppFont.mono fell back to the system font — the bundled family did not resolve."
        )
    }

    /// Weight must actually change the rendered glyphs.
    ///
    /// Asserted by *measuring*, not by comparing `Font` values or font names.
    /// Both are useless here: these are variable fonts, so every weight reports
    /// the same family name, and SwiftUI `Font` values wrapping a platform font
    /// compare equal regardless. Requesting a weight via
    /// `fontDescriptor.addingAttributes([.traits: [.weight: …]])` is silently
    /// ignored on a variable font — it returns glyphs of identical width — which
    /// is exactly the bug this test caught. Only the named PostScript instance
    /// moves the weight axis.
    func testWeightChangesRenderedGlyphs() throws {
        try registerBundledFontsForTesting()

        func width(_ psName: String) throws -> CGFloat {
            let font = try XCTUnwrap(NSFont(name: psName, size: 14), "missing face \(psName)")
            return ("Hamburgefonstiv" as NSString).size(withAttributes: [.font: font]).width
        }

        let regular = try width("InterVariable")
        let bold = try width("InterVariable-Bold")
        XCTAssertGreaterThan(
            bold, regular,
            "Bold must render wider than regular — if these match, the weight axis is not moving."
        )

        // Mono is duplexed — bold and regular share advance widths by design —
        // so compare the faces resolve distinctly rather than measuring width.
        let monoRegular = try XCTUnwrap(NSFont(name: "JetBrainsMono-Regular", size: 14))
        let monoBold = try XCTUnwrap(NSFont(name: "JetBrainsMono-Regular_Bold", size: 14))
        XCTAssertNotEqual(monoBold.fontName, monoRegular.fontName,
                          "Mono bold must resolve to a different face than mono regular.")
    }

    /// Documents the known gap: Inter Variable ships no italic face, so the
    /// theme substitutes the system font for emphasised runs. If this ever
    /// starts passing (because an Inter Italic got bundled), the substitution
    /// in `MarkdownText.emphasis` can be dropped.
    func testItalicFallbackIsStillRequired() throws {
        try registerBundledFontsForTesting()
        XCTAssertFalse(
            MarkdownTokens.Family.sansHasItalic,
            """
            Inter now has a real italic face — the system-font substitution in \
            MarkdownText's .emphasis style is no longer needed and can be removed.
            """
        )
    }

    // MARK: - Helpers

    /// Registers the bundled fonts from the source tree. The test bundle has no
    /// copy of `Resources/Fonts`, so resolve them relative to this file.
    private func registerBundledFontsForTesting() throws {
        let fontsDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()          // Tests/
            .deletingLastPathComponent()          // app/
            .appendingPathComponent("Resources/Fonts")

        for name in ["InterVariable.ttf", "JetBrainsMono.ttf"] {
            let url = fontsDir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("Bundled font missing at \(url.path)")
            }
            // Re-registering an already-registered font is a harmless no-op error.
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}
