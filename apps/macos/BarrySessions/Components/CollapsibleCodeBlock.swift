import SwiftUI
import MarkdownUI

/// A code block that collapses to an inline pill when the content exceeds a line threshold.
/// Short blocks render normally. Long blocks show a pill: `SWIFT 20 lines ›`
/// Click the pill to expand, click the header to collapse.
public struct CollapsibleCodeBlock: View {
    let configuration: CodeBlockConfiguration
    let lineThreshold: Int
    let monoFamily: String
    let sansFamily: String
    let codeBackground: Color
    let codeBorder: Color

    @State private var isExpanded = false

    /// Dim text levels mirrored around the code background in each appearance.
    private static let langLabel = Color.adaptive(light: Color(white: 0.45), dark: Color(white: 0.55))
    private static let lineCountLabel = Color.adaptive(light: Color(white: 0.62), dark: Color(white: 0.33))
    private static let chevron = Color.adaptive(light: Color(white: 0.70), dark: Color(white: 0.27))
    private static let copyLabel = Color.adaptive(light: Color(white: 0.52), dark: Color(white: 0.4))

    public init(
        configuration: CodeBlockConfiguration,
        lineThreshold: Int = 8,
        monoFamily: String = "JetBrains Mono",
        sansFamily: String = "Inter",
        codeBackground: Color = MarkdownText.codeBackground,
        codeBorder: Color = MarkdownText.codeBorder
    ) {
        self.configuration = configuration
        self.lineThreshold = lineThreshold
        self.monoFamily = monoFamily
        self.sansFamily = sansFamily
        self.codeBackground = codeBackground
        self.codeBorder = codeBorder
    }

    private var lineCount: Int {
        configuration.content.components(separatedBy: "\n").count
    }

    private var isLong: Bool {
        lineCount >= lineThreshold
    }

    public var body: some View {
        if isLong && !isExpanded {
            pill
        } else {
            fullBlock
        }
    }

    // MARK: - Pill (collapsed)

    private var pill: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                isExpanded = true
            }
        } label: {
            HStack(spacing: 6) {
                if let lang = configuration.language {
                    Text(lang)
                        .font(.custom(monoFamily, size: 10).weight(.medium))
                        .foregroundStyle(Self.langLabel)
                        .textCase(.uppercase)
                }

                Text("\(lineCount) lines")
                    .font(.custom(monoFamily, size: 9.5))
                    .foregroundStyle(Self.lineCountLabel)

                Text("\u{203A}")
                    .font(.system(size: 9))
                    .foregroundStyle(Self.chevron)
            }
            .padding(.vertical, 3)
            .padding(.horizontal, 10)
            .background(codeBackground)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(codeBorder, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .markdownMargin(top: 4, bottom: 4)
    }

    // MARK: - Full block (expanded or short)

    private var fullBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header bar — clickable to collapse if long
            header

            // Code content
            configuration.label
                .relativeLineSpacing(.em(0.2))
                .markdownTextStyle {
                    FontFamily(.custom(monoFamily))
                    FontSize(.em(0.85))
                }
                .padding(10)
        }
        .background(codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(codeBorder, lineWidth: 1)
        )
        .markdownMargin(top: 4, bottom: 4)
    }

    @ViewBuilder
    private var header: some View {
        if isLong {
            // Collapsible header — click to collapse
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    isExpanded = false
                }
            } label: {
                headerContent(showLineCount: true, chevronRotated: true)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else if configuration.language != nil {
            // Normal header for short blocks
            headerContent(showLineCount: false, chevronRotated: false)
        }
    }

    private func headerContent(showLineCount: Bool, chevronRotated: Bool) -> some View {
        HStack {
            if let lang = configuration.language {
                Text(lang)
                    .font(.custom(monoFamily, size: 10).weight(.medium))
                    .foregroundStyle(Self.langLabel)
                    .textCase(.uppercase)
            }

            Spacer()

            if showLineCount {
                Text("\(lineCount) lines")
                    .font(.custom(monoFamily, size: 9.5))
                    .foregroundStyle(Self.lineCountLabel)

                Text("\u{203A}")
                    .font(.system(size: 9))
                    .foregroundStyle(Self.chevron)
                    .rotationEffect(.degrees(chevronRotated ? 90 : 0))
            } else {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(configuration.content, forType: .string)
                } label: {
                    Text("Copy")
                        .font(.custom(sansFamily, size: 10))
                        .foregroundStyle(Self.copyLabel)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Color.primary.opacity(0.03))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(codeBorder)
                .frame(height: 1)
        }
    }
}
