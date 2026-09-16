import SwiftUI

/// Design tokens for message rendering.
///
/// Everything the markdown renderer measures with lives here, so type, rhythm
/// and colour stay internally consistent instead of drifting as per-block
/// magic numbers scattered across the theme.
///
/// ## The vertical rhythm rule
///
/// The most important rule in this file: **the gap between two blocks must be
/// larger than the gap between two wrapped lines inside one block.** When that
/// inverts, a wrapped sentence reads as two paragraphs and a bulleted list
/// reads as unrelated fragments. Concretely: `Space.paragraph` must exceed
/// `Space.bodyLineSpacing * Type.body`. `MarkdownRhythmTests` asserts it.
public enum MarkdownTokens {

    // MARK: - Font families

    /// Family names as CoreText reports them — not the marketing name.
    ///
    /// `InterVariable.ttf` registers under the family `Inter Variable`;
    /// `NSFont(name: "Inter", size:)` returns **nil** and silently falls back
    /// to the system font. That fallback also loses bold/semibold synthesis,
    /// so `**bold**` and heading weights stop rendering at all. Verified with
    /// `CTFontManagerCreateFontDescriptorsFromURL`.
    public enum Family {
        public static let sans = "Inter Variable"
        public static let mono = "JetBrains Mono"

        /// True when the bundled fonts actually resolved. Registration is done
        /// by the host app (or the snapshot harness); if it hasn't happened we
        /// must fall back to the system font rather than emit a `.custom`
        /// family that CoreText can't find.
        public static var sansAvailable: Bool { NSFont(name: sans, size: 12) != nil }
        public static var monoAvailable: Bool { NSFont(name: mono, size: 12) != nil }

        /// Inter Variable ships nine *weights* and **no italic face**, so
        /// `NSFontManager.convert(toHaveTrait: .italicFontMask)` returns the
        /// font unchanged and `*emphasis*` renders identically to body text.
        /// Emphasis is therefore synthesised as an oblique — see
        /// `MarkdownTokens.obliqueSkew`.
        public static var sansHasItalic: Bool {
            guard let base = NSFont(name: sans, size: 12) else { return false }
            let italic = NSFontManager.shared.convert(base, toHaveTrait: .italicFontMask)
            return italic.fontName != base.fontName
        }
    }

    /// Shear applied when synthesising an italic from a family that has no
    /// true italic face. ~12° is the conventional oblique angle; more than
    /// that starts to look like a distortion rather than a typeface.
    public static let obliqueSkew: CGFloat = 0.21

    // MARK: - Type scale

    /// A restrained scale for a ~400pt-wide popover. Body is the anchor and
    /// headings step in clearly perceptible increments, so hierarchy is
    /// obvious at a glance. Weight carries as much of the signal as size.
    public enum Size {
        public static let body: CGFloat = 14
        // Modular scale, ratio ≈1.25 (major third) — the ratio recommended for
        // dense/technical content. Beyond h4, differentiate by weight and
        // colour rather than size; a chat popover has no room for six sizes.
        public static let h1: CGFloat = 20      // 14 × 1.25²  ≈ 21.9, pulled in
        public static let h2: CGFloat = 17.5    // 14 × 1.25
        public static let h3: CGFloat = 15
        public static let h4: CGFloat = 14
        /// Code sits just below body: monospace has a larger apparent x-height
        /// and over-weights the page at a matched point size. 0.85–0.9 is the
        /// commonly recommended range.
        public static let codeEm: CGFloat = 0.875
        public static let small: CGFloat = 11
        public static let tiny: CGFloat = 10
    }

    // MARK: - Vertical rhythm

    public enum Space {
        /// Extra leading *within* a paragraph, as a multiple of font size —
        /// the units MarkdownUI's `relativeLineSpacing(.em:)` expects (space
        /// added on top of natural line height). 0.28em lands near a 1.5
        /// line-height, the long-form reading sweet spot.
        ///
        /// The previous value was 0.75em (≈2.0 line-height), which pushed
        /// wrapped lines further apart than whole paragraphs and destroyed the
        /// reading rhythm.
        public static let bodyLineSpacing: CGFloat = 0.28
        /// Tighter inside list items — they're short, and the marker already
        /// does the work of grouping them.
        public static let listLineSpacing: CGFloat = 0.20
        public static let codeLineSpacing: CGFloat = 0.30

        // Block gaps, expressed against a 14pt body. The ratios come from
        // standard long-form typography guidance; the asymmetry between
        // `headingTop` and `headingBottom` is the thing that makes document
        // structure legible at a glance.

        /// Between sibling paragraphs (≈0.95em). Must exceed
        /// `bodyLineSpacing * body` or wrapped lines out-gap whole paragraphs.
        public static let paragraph: CGFloat = 13
        /// Between list items (≈0.3em) — tight, so a list reads as one object
        /// rather than as N paragraphs.
        public static let listItem: CGFloat = 4
        /// Above a heading (≈1.7em): generous, so the heading binds downward
        /// to the section it opens instead of floating equidistant between two.
        public static let headingTop: CGFloat = 24
        public static let headingTopTight: CGFloat = 19
        /// Below a heading (≈0.45em): deliberately small. Proximity is what
        /// couples a heading to the text it introduces.
        public static let headingBottom: CGFloat = 6
        /// Around code blocks, tables and quotes (≈1.1em).
        public static let block: CGFloat = 15
        public static let rule: CGFloat = 22
    }

    // MARK: - Inline code

    public enum InlineCode {
        public static let hPadding: CGFloat = 4.5
        public static let vPadding: CGFloat = 1.5
        public static let cornerRadius: CGFloat = 4
    }

    // MARK: - Blocks

    public enum Block {
        public static let cornerRadius: CGFloat = 8
        public static let padding: CGFloat = 11
        public static let quoteBarWidth: CGFloat = 2.5
        public static let quoteIndent: CGFloat = 13
        /// Code blocks stay expanded until they are genuinely long. Code is
        /// the payload in an agent transcript — collapsing an 8-line diff by
        /// default hid the answer behind a click.
        public static let codeCollapseThreshold: Int = 28
    }
}
