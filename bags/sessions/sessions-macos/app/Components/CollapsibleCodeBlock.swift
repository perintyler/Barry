import SwiftUI
import MarkdownUI

/// A code block that collapses to an inline pill when the content exceeds a line threshold.
/// Short bags render normally. Long bags show a pill: `SWIFT 20 lines ›`
/// Click the pill to expand, click the header to collapse.
public struct CollapsibleCodeBlock: View {
    let configuration: CodeBlockConfiguration
    let lineThreshold: Int
    let monoFamily: String
    let sansFamily: String
    let codeBackground: Color
    let codeBorder: Color

    @State private var isExpanded = false
    @State private var didCopy = false

    /// Dim text levels mirrored around the code background in each appearance.
    private static let langLabel = Color.adaptive(light: Color(white: 0.42), dark: Color(white: 0.62))
    private static let lineCountLabel = Color.adaptive(light: Color(white: 0.58), dark: Color(white: 0.45))
    private static let chevron = Color.adaptive(light: Color(white: 0.62), dark: Color(white: 0.42))
    private static let copyLabel = Color.adaptive(light: Color(white: 0.45), dark: Color(white: 0.58))
    private static let copiedLabel = Color.adaptive(
        light: Color(red: 0.13, green: 0.55, blue: 0.30),
        dark: Color(red: 0.44, green: 0.83, blue: 0.55)
    )

    public init(
        configuration: CodeBlockConfiguration,
        lineThreshold: Int = MarkdownTokens.Block.codeCollapseThreshold,
        monoFamily: String = MarkdownTokens.Family.mono,
        sansFamily: String = MarkdownTokens.Family.sans,
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
            fullBag
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

    // MARK: - Full bag (expanded or short)

    private var fullBag: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header bar — clickable to collapse if long
            header

            // Code content.
            //
            // Deliberately *not* wrapped in a horizontal ScrollView: doing so
            // hands the content an unbounded width, which collapses the
            // layout and renders nothing at all. MarkdownUI wraps long lines
            // instead, which is the acceptable trade-off in a narrow popover.
            configuration.label
                .relativeLineSpacing(.em(MarkdownTokens.Space.codeLineSpacing))
                .markdownTextStyle {
                    FontFamily(.custom(monoFamily))
                    FontSize(.em(MarkdownTokens.Size.codeEm))
                }
                .padding(MarkdownTokens.Block.padding)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: MarkdownTokens.Block.cornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: MarkdownTokens.Block.cornerRadius)
                .strokeBorder(codeBorder, lineWidth: 1)
        )
        .markdownMargin(top: MarkdownTokens.Space.block, bottom: MarkdownTokens.Space.block)
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
            // Normal header for short bags
            headerContent(showLineCount: false, chevronRotated: false)
        }
    }

    private func headerContent(showLineCount: Bool, chevronRotated: Bool) -> some View {
        HStack(spacing: 8) {
            if let lang = configuration.language {
                Text(lang)
                    .font(.custom(monoFamily, size: MarkdownTokens.Size.tiny).weight(.medium))
                    .foregroundStyle(Self.langLabel)
                    .textCase(.uppercase)
                    .kerning(0.5)
            }

            Spacer(minLength: 0)

            if showLineCount {
                Text("\(lineCount) lines")
                    .font(.custom(monoFamily, size: 9.5))
                    .foregroundStyle(Self.lineCountLabel)

                Text("\u{203A}")
                    .font(.system(size: 9))
                    .foregroundStyle(Self.chevron)
                    .rotationEffect(.degrees(chevronRotated ? 90 : 0))
            }

            // Copy is always present. It used to live in the `else` branch of
            // the line-count check, so it disappeared on exactly the long
            // blocks people most want to copy.
            copyButton
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.primary.opacity(0.035))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(codeBorder)
                .frame(height: 1)
        }
    }

    @ViewBuilder
    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(configuration.content, forType: .string)
            withAnimation(.easeOut(duration: 0.12)) { didCopy = true }
            Task {
                try? await Task.sleep(for: .milliseconds(1400))
                withAnimation(.easeOut(duration: 0.2)) { didCopy = false }
            }
        } label: {
            Text(didCopy ? "Copied" : "Copy")
                .font(.custom(sansFamily, size: MarkdownTokens.Size.tiny))
                .foregroundStyle(didCopy ? Self.copiedLabel : Self.copyLabel)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Copy code to clipboard")
    }
}
