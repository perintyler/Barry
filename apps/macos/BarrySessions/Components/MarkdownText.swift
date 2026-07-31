import SwiftUI
import MarkdownUI
import Highlighter
import AppKit

/// Renders markdown content using MarkdownUI with an appearance-adaptive chat theme.
/// Uses HighlighterSwift for syntax highlighting in code blocks.
/// Conforms to Equatable so SwiftUI skips re-rendering when content hasn't changed.
public struct MarkdownText: View, Equatable {
    public let content: String

    @Environment(\.colorScheme) private var colorScheme

    public init(content: String) {
        self.content = content
    }

    public static func == (lhs: MarkdownText, rhs: MarkdownText) -> Bool {
        lhs.content == rhs.content
    }

    // Highlighter instances are expensive to create — one cached per appearance.
    private static let darkHighlighter = HighlightrCodeSyntaxHighlighter(theme: "onedark")
    private static let lightHighlighter = HighlightrCodeSyntaxHighlighter(theme: "one-light")

    public var body: some View {
        Markdown(content)
            .markdownTheme(Self.chatTheme)
            .markdownCodeSyntaxHighlighter(colorScheme == .dark ? Self.darkHighlighter : Self.lightHighlighter)
    }

    // MARK: - Colors (light / dark pairs; dark values are the original design)

    public static let codeBackground = Color.adaptive(
        light: Color(red: 0.965, green: 0.965, blue: 0.976),
        dark: Color(red: 0.102, green: 0.102, blue: 0.180)
    )
    public static let codeBorder = Color.adaptive(
        light: Color.black.opacity(0.13),
        dark: Color(white: 0.47).opacity(0.25)
    )
    private static let inlineCodeForeground = Color.adaptive(
        light: Color(red: 0.18, green: 0.20, blue: 0.24),
        dark: Color(red: 0.85, green: 0.87, blue: 0.91)
    )
    private static let inlineCodeBackground = Color.primary.opacity(0.07)
    private static let blockquoteBorder = Color.adaptive(
        light: Color(red: 0.15, green: 0.42, blue: 0.90),
        dark: Color(red: 0.29, green: 0.62, blue: 1.0)
    )
    private static let blockquoteBackground = blockquoteBorder.opacity(0.04)
    private static let tableBorder = Color.primary.opacity(0.15)
    private static let tableHeaderBackground = Color.primary.opacity(0.05)
    private static let tableRowEvenBackground = Color.primary.opacity(0.02)

    /// Compact dark theme sized for a popover chat context.
    /// Inter font name — registered at app startup, falls back to system if unavailable.
    private static let sansFamily = "Inter"
    private static let monoFamily = "JetBrains Mono"

    private static let chatTheme: MarkdownUI.Theme = {
        .init()
            .text {
                FontFamily(.custom(Self.sansFamily))
                FontSize(14)
                ForegroundColor(.primary)
            }
            .heading1 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(16)
                        FontWeight(.semibold)
                    }
                    .markdownMargin(top: 16, bottom: 6)
            }
            .heading2 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(14.5)
                        FontWeight(.semibold)
                    }
                    .markdownMargin(top: 14, bottom: 6)
            }
            .heading3 { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(13)
                        FontWeight(.semibold)
                    }
                    .markdownMargin(top: 12, bottom: 4)
            }
            .thematicBreak {
                Rectangle()
                    .fill(Color.primary.opacity(0.1))
                    .frame(height: 1)
                    .markdownMargin(top: 16, bottom: 16)
            }
            .code {
                FontFamily(.custom(Self.monoFamily))
                FontSize(.em(0.88))
                ForegroundColor(Self.inlineCodeForeground)
                BackgroundColor(Self.inlineCodeBackground)
            }
            .codeBlock { configuration in
                CollapsibleCodeBlock(
                    configuration: configuration,
                    monoFamily: Self.monoFamily,
                    sansFamily: Self.sansFamily,
                    codeBackground: Self.codeBackground,
                    codeBorder: Self.codeBorder
                )
            }
            .blockquote { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(12.5)
                        ForegroundColor(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .background(Self.blockquoteBackground)
                    .clipShape(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 0,
                            bottomLeadingRadius: 0,
                            bottomTrailingRadius: 4,
                            topTrailingRadius: 4
                        )
                    )
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Self.blockquoteBorder)
                            .frame(width: 3)
                    }
                    .markdownMargin(top: 4, bottom: 4)
            }
            .table { configuration in
                configuration.label
                    .markdownTableBorderStyle(
                        TableBorderStyle(
                            .horizontalBorders,
                            color: Self.tableBorder,
                            width: 1
                        )
                    )
                    .markdownTableBackgroundStyle(
                        .alternatingRows(
                            Self.tableRowEvenBackground,
                            .clear,
                            header: Self.tableHeaderBackground
                        )
                    )
                    .markdownMargin(top: 6, bottom: 6)
            }
            .tableCell { configuration in
                configuration.label
                    .markdownTextStyle {
                        FontSize(12.5)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
            .paragraph { configuration in
                configuration.label
                    .relativeLineSpacing(.em(0.75))
                    .markdownMargin(top: 0, bottom: 4)
            }
            .listItem { configuration in
                configuration.label
                    .relativeLineSpacing(.em(0.7))
                    .markdownMargin(top: 4, bottom: 4)
            }
    }()
}
