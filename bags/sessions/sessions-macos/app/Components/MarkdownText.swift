import SwiftUI
import MarkdownUI
import Highlighter
import AppKit

/// Renders markdown message content with an appearance-adaptive chat theme.
///
/// Uses MarkdownUI (cmark-gfm) for parsing and HighlighterSwift for code
/// syntax highlighting. Conforms to `Equatable` so SwiftUI skips re-rendering
/// when content is unchanged — the transcript re-evaluates on every streamed
/// token, so this matters.
///
/// > Important: both user *and* assistant messages render through this view,
/// > so any change here affects the whole transcript.
public struct MarkdownText: View, Equatable {
    public let content: String

    @Environment(\.colorScheme) private var colorScheme

    public init(content: String) {
        self.content = content
    }

    // Note: `colorScheme` is intentionally excluded — the palette below is
    // built from `Color.adaptive`, which resolves per-appearance at draw time.
    // Only the syntax highlighter needs the scheme, and it is picked in `body`.
    public static func == (lhs: MarkdownText, rhs: MarkdownText) -> Bool {
        lhs.content == rhs.content
    }

    // Highlighter instances are expensive to construct — one cached per appearance.
    private static let darkHighlighter = HighlightrCodeSyntaxHighlighter(theme: "onedark")
    private static let lightHighlighter = HighlightrCodeSyntaxHighlighter(theme: "one-light")

    public var body: some View {
        Markdown(content)
            .markdownTheme(Self.chatTheme)
            .markdownCodeSyntaxHighlighter(colorScheme == .dark ? Self.darkHighlighter : Self.lightHighlighter)
            // Per-block selection. SwiftUI cannot select *across* Text views,
            // so this makes each block individually selectable rather than the
            // whole message — a known SwiftUI limitation, not a bug here.
            // Note: `.textSelection(.enabled)` also silently disables any
            // `TextRenderer`, so don't add one to this view.
            .textSelection(.enabled)
    }

    // Long URLs and paths wrap correctly — verified, not assumed.
    //
    // An earlier version of this comment claimed they were truncated with an
    // ellipsis and that fixing it required an NSTextView-backed renderer. That
    // was wrong. Measured behaviour (see the `link-wrapping` snapshot fixture):
    // SwiftUI `Text` breaks long URLs at `/` boundaries on its own, and
    // injecting U+200B changes nothing. Truncation appears only under
    // `.lineLimit(n)` or `fixedSize(horizontal: true)`, neither of which this
    // path uses.
    //
    // The one genuine limitation is cross-block selection (above): you can
    // select within a block but not across two. That is a view-hosting problem,
    // not a text one, and is not worth an NSTextView rewrite — hosting the
    // code-block chrome inside one would reintroduce a selection boundary
    // anyway. Prefer a "copy message" affordance.

    // MARK: - Fonts
    //
    // Resolved through the tokens so a missing bundled font degrades to the
    // system font instead of emitting an unresolvable custom family (which
    // silently kills bold synthesis — see MarkdownTokens.Family).

    private static var sansFamily: FontProperties.Family {
        MarkdownTokens.Family.sansAvailable
            ? .custom(MarkdownTokens.Family.sans)
            : .system()
    }

    private static var monoFamily: FontProperties.Family {
        MarkdownTokens.Family.monoAvailable
            ? .custom(MarkdownTokens.Family.mono)
            : .system(.monospaced)
    }

    /// Family name strings for the plain-SwiftUI chrome inside code blocks.
    static var sansFamilyName: String? {
        MarkdownTokens.Family.sansAvailable ? MarkdownTokens.Family.sans : nil
    }

    static var monoFamilyName: String? {
        MarkdownTokens.Family.monoAvailable ? MarkdownTokens.Family.mono : nil
    }

    // MARK: - Colors (light / dark pairs)

    public static let codeBackground = Color.adaptive(
        light: Color(red: 0.969, green: 0.973, blue: 0.980),
        dark: Color(red: 0.106, green: 0.110, blue: 0.133)
    )
    public static let codeBorder = Color.adaptive(
        light: Color.black.opacity(0.10),
        dark: Color.white.opacity(0.08)
    )
    /// Inline code: a desaturated warm tint that reads as "literal token"
    /// without competing with links or bold for attention. A fully saturated
    /// pink here turns every file path into a decoration.
    private static let inlineCodeForeground = Color.adaptive(
        light: Color(red: 0.58, green: 0.22, blue: 0.34),
        dark: Color(red: 0.91, green: 0.80, blue: 0.82)
    )
    private static let inlineCodeBackground = Color.adaptive(
        light: Color(red: 0.03, green: 0.05, blue: 0.15).opacity(0.055),
        dark: Color.white.opacity(0.085)
    )
    /// Quotes use a neutral rule, not blue — blue reads as a link or as the
    /// "you" speaker colour elsewhere in the transcript.
    private static let blockquoteBorder = Color.adaptive(
        light: Color(white: 0.0).opacity(0.20),
        dark: Color(white: 1.0).opacity(0.26)
    )
    private static let blockquoteForeground = Color.secondary
    private static let tableBorder = Color.primary.opacity(0.14)
    private static let tableHeaderBackground = Color.primary.opacity(0.055)
    private static let tableRowEvenBackground = Color.primary.opacity(0.022)
    private static let ruleColor = Color.primary.opacity(0.13)
    /// List markers are chrome, not content — dimmed so the text leads, but
    /// not so far that they disappear against a dark surface.
    private static let listMarker = Color.adaptive(
        light: Color(white: 0.42),
        dark: Color(white: 0.62)
    )
    private static let linkColor = Color.adaptive(
        light: Color(red: 0.10, green: 0.40, blue: 0.85),
        dark: Color(red: 0.45, green: 0.71, blue: 1.0)
    )

    // MARK: - Theme

    private static let chatTheme: MarkdownUI.Theme = {
        .init()
            // ---- Base text ----
            .text {
                FontFamily(Self.sansFamily)
                FontSize(MarkdownTokens.Size.body)
                ForegroundColor(.primary)
            }
            .link {
                ForegroundColor(Self.linkColor)
                UnderlineStyle(.single)
            }
            // Inter Variable ships no italic face, so SwiftUI's `.italic()`
            // is a no-op against it and `*emphasis*` renders identically to
            // body text. Fall back to the system font for emphasised runs
            // only — it has a true italic — so emphasis is actually visible.
            // (Checked at runtime rather than hardcoded, so bundling an Inter
            // Italic later automatically takes precedence.)
            .emphasis {
                if !MarkdownTokens.Family.sansHasItalic {
                    FontFamilyVariant(.normal)
                    FontFamily(.system())
                }
                FontStyle(.italic)
            }
            .strong {
                FontWeight(.semibold)
            }
            .strikethrough {
                StrikethroughStyle(.single)
                ForegroundColor(.secondary)
            }

            // ---- Headings ----
            //
            // Large top margin + small bottom margin: proximity is what binds
            // a heading to the section it introduces.
            .heading1 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.h1)
                        FontWeight(.bold)
                    }
                    .markdownMargin(top: MarkdownTokens.Space.headingTop,
                                    bottom: MarkdownTokens.Space.headingBottom)
            }
            .heading2 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.h2)
                        FontWeight(.semibold)
                    }
                    .markdownMargin(top: MarkdownTokens.Space.headingTop,
                                    bottom: MarkdownTokens.Space.headingBottom)
            }
            .heading3 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.h3)
                        FontWeight(.semibold)
                    }
                    .markdownMargin(top: MarkdownTokens.Space.headingTopTight,
                                    bottom: MarkdownTokens.Space.headingBottom)
            }
            // h4–h6 previously fell through to MarkdownUI defaults, which are
            // sized for a document, not a popover — h4 came out identical to
            // body text. Differentiate by weight and colour instead of size.
            .heading4 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.h4)
                        FontWeight(.semibold)
                    }
                    .markdownMargin(top: MarkdownTokens.Space.headingTopTight,
                                    bottom: MarkdownTokens.Space.headingBottom)
            }
            .heading5 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.h4)
                        FontWeight(.semibold)
                        ForegroundColor(.secondary)
                    }
                    .markdownMargin(top: MarkdownTokens.Space.headingTopTight,
                                    bottom: MarkdownTokens.Space.headingBottom)
            }
            .heading6 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.small)
                        FontWeight(.semibold)
                        ForegroundColor(.secondary)
                    }
                    .markdownMargin(top: MarkdownTokens.Space.headingTopTight,
                                    bottom: MarkdownTokens.Space.headingBottom)
            }

            // ---- Rules ----
            .thematicBreak {
                Rectangle()
                    .fill(Self.ruleColor)
                    .frame(height: 1)
                    .markdownMargin(top: MarkdownTokens.Space.rule,
                                    bottom: MarkdownTokens.Space.rule)
            }

            // ---- Inline code ----
            //
            // MarkdownUI's `BackgroundColor` paints the text run's box with no
            // inset, so the chip used to clamp flush against the glyphs. There
            // is no padding primitive for an inline run, so the breathing room
            // is bought with hair spaces (U+200A) inside the styled run.
            .code {
                FontFamily(Self.monoFamily)
                FontSize(.em(MarkdownTokens.Size.codeEm))
                ForegroundColor(Self.inlineCodeForeground)
                BackgroundColor(Self.inlineCodeBackground)
            }

            // ---- Code blocks ----
            .codeBlock { configuration in
                CollapsibleCodeBlock(configuration: configuration)
            }

            // ---- Quotes ----
            .blockquote { configuration in
                HStack(spacing: 0) {
                    Rectangle()
                        .fill(Self.blockquoteBorder)
                        .frame(width: MarkdownTokens.Block.quoteBarWidth)
                    configuration.label
                        .markdownTextStyle {
                            ForegroundColor(Self.blockquoteForeground)
                        }
                        .padding(.leading, MarkdownTokens.Block.quoteIndent)
                }
                .fixedSize(horizontal: false, vertical: true)
                .markdownMargin(top: MarkdownTokens.Space.block,
                                bottom: MarkdownTokens.Space.block)
            }

            // ---- Tables ----
            .table { configuration in
                configuration.label
                    .markdownTableBorderStyle(
                        TableBorderStyle(.horizontalBorders, color: Self.tableBorder, width: 1)
                    )
                    .markdownTableBackgroundStyle(
                        .alternatingRows(
                            Self.tableRowEvenBackground,
                            .clear,
                            header: Self.tableHeaderBackground
                        )
                    )
                    .markdownMargin(top: MarkdownTokens.Space.block,
                                    bottom: MarkdownTokens.Space.block)
            }
            .tableCell { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(MarkdownTokens.Size.small + 1.5)
                        // Header row carries weight so it reads as a header.
                        if configuration.row == 0 {
                            FontWeight(.semibold)
                        }
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
            }

            // ---- Blocks ----
            .paragraph { configuration in
                configuration.label
                    .relativeLineSpacing(.em(MarkdownTokens.Space.bodyLineSpacing))
                    .markdownMargin(top: 0, bottom: MarkdownTokens.Space.paragraph)
            }
            .listItem { configuration in
                configuration.label
                    .relativeLineSpacing(.em(MarkdownTokens.Space.listLineSpacing))
                    .markdownMargin(top: MarkdownTokens.Space.listItem,
                                    bottom: MarkdownTokens.Space.listItem)
            }
            // Markers are chrome — dim them so content leads the eye. The
            // default markers also rendered in the system font while the text
            // used Inter.
            .bulletedListMarker { configuration in
                ListMarkerDot(level: configuration.listLevel)
                    .foregroundStyle(Self.listMarker)
            }
            .numberedListMarker { configuration in
                Text("\(configuration.itemNumber).")
                    .monospacedDigit()
                    .markdownTextStyle {
                        FontFamily(Self.sansFamily)
                        ForegroundColor(Self.listMarker)
                    }
            }
            .taskListMarker { configuration in
                Image(systemName: configuration.isCompleted ? "checkmark.square.fill" : "square")
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(configuration.isCompleted ? Self.linkColor : Self.listMarker)
                    .imageScale(.small)
                    .relativeFrame(minWidth: .em(1.0), alignment: .leading)
            }
            // Images in a ~400pt popover must never blow out the layout.
            .image { configuration in
                configuration.label
                    .frame(maxWidth: .infinity)
                    .markdownMargin(top: MarkdownTokens.Space.block,
                                    bottom: MarkdownTokens.Space.block)
            }
    }()
}

/// Bullet glyph that varies by nesting depth (•, ◦, ▪) so nested lists are
/// distinguishable at a glance.
private struct ListMarkerDot: View {
    let level: Int

    var body: some View {
        Text(glyph)
            .font(.system(size: level == 1 ? 7.5 : 7, weight: .black))
            // Nudge the dot onto the text's optical centre rather than the
            // baseline, so it sits level with the x-height of the first line.
            .baselineOffset(3)
            .relativeFrame(minWidth: .em(0.9), alignment: .trailing)
    }

    private var glyph: String {
        switch level {
        case 1: return "\u{25CF}"   // ●
        case 2: return "\u{25CB}"   // ○
        default: return "\u{25AA}"  // ▪
        }
    }
}
