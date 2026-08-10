import SwiftUI
import AppKit
import Components

// MARK: - Font Registration

/// Register bundled Inter and JetBrains Mono for snapshot rendering.
private func registerFonts() {
    let fontsDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // Snapshots/
        .appendingPathComponent("../Resources/Fonts")
        .standardized
    for name in ["InterVariable.ttf", "JetBrainsMono.ttf"] {
        let url = fontsDir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}

// MARK: - Snapshot Harness

/// Renders SwiftUI views to PNG files for visual QA.
/// Run: swift run Snapshots [output-dir]
/// Opens the output directory in Finder when done.

/// Snapshots render dark by default (the reference design). Pass --light to
/// QA the adaptive light palette of the shared Components.
let renderLight = CommandLine.arguments.contains("--light")

@MainActor
func renderSnapshot<V: View>(
    _ name: String,
    width: CGFloat = 400,
    to directory: URL,
    @ViewBuilder content: () -> V
) {
    let panelBg = renderLight
        ? NSColor(red: 0.976, green: 0.976, blue: 0.980, alpha: 1)  // #f9f9fa
        : NSColor(red: 0.133, green: 0.133, blue: 0.149, alpha: 1)  // #222226
    let view = content()
        .frame(width: width)
        .padding(1) // avoid clipping
        .background(Color(nsColor: panelBg))
        .environment(\.colorScheme, renderLight ? .light : .dark)

    let renderer = ImageRenderer(content: view)
    renderer.scale = 2.0

    // Components colors are appearance-adaptive (NSColor dynamic providers), so
    // the drawing appearance must be pinned too — .colorScheme alone doesn't
    // affect NSColor resolution.
    var rendered: NSImage?
    NSAppearance(named: renderLight ? .aqua : .darkAqua)?.performAsCurrentDrawingAppearance {
        rendered = renderer.nsImage
    }
    guard let image = rendered else {
        print("  FAIL: \(name) — could not render")
        return
    }

    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        print("  FAIL: \(name) — could not encode PNG")
        return
    }

    let path = directory.appendingPathComponent("\(name).png")
    do {
        try png.write(to: path)
        print("  OK: \(name).png")
    } catch {
        print("  FAIL: \(name) — \(error)")
    }
}

// MARK: - Mock Colors (matching v13.html CSS vars)

private enum MockColors {
    // Adaptive pairs mirroring the app palette (MessagesPanel.TurnColors /
    // ToolRenderers.DetailColors) so --light snapshots match the real app.
    static let panelBg = Color.adaptive(
        light: Color(red: 0.976, green: 0.976, blue: 0.980),           // #f9f9fa
        dark: Color(red: 0.133, green: 0.133, blue: 0.149)             // #222226
    )

    static let userBase = Color.adaptive(
        light: Color(red: 37/255, green: 99/255, blue: 235/255),       // #2563eb
        dark: Color(red: 96/255, green: 165/255, blue: 250/255)        // #60a5fa
    )
    static let userBg = userBase.opacity(0.055)
    static let userLine = userBase.opacity(0.16)
    static let userLabel = userBase.opacity(0.55)

    static let agentBase = Color.adaptive(
        light: Color(red: 217/255, green: 119/255, blue: 6/255),       // #d97706
        dark: Color(red: 251/255, green: 191/255, blue: 36/255)        // #fbbf24
    )
    static let agentBg = agentBase.opacity(0.04)
    static let agentLine = agentBase.opacity(0.1)
    static let agentLabel = agentBase.opacity(0.45)

    static let toolName = Color.adaptive(light: Color(white: 0.60), dark: Color(white: 0.33))
    static let toolSummary = Color.adaptive(
        light: Color(red: 0.72, green: 0.73, blue: 0.75),
        dark: Color(red: 0.22, green: 0.23, blue: 0.25)                // #383b40
    )
    static let toolLine = Color.primary.opacity(0.05)
    static let toolChevron = Color.adaptive(light: Color(white: 0.80), dark: Color(white: 0.2))

    static let detailLabel = toolName
    static let detailBg = Color.adaptive(light: Color.black.opacity(0.05), dark: Color.black.opacity(0.15))
    static let inputColor = Color.adaptive(
        light: Color(red: 0.40, green: 0.41, blue: 0.44),
        dark: Color(red: 0.60, green: 0.62, blue: 0.64)                // #9a9da3
    )
    static let resultColor = successGreen.opacity(0.7)

    static let lineNumber = Color.adaptive(
        light: Color(red: 0.78, green: 0.78, blue: 0.80),
        dark: Color(red: 0.23, green: 0.24, blue: 0.26)                // #3a3d42
    )
    static let codeText = Color.adaptive(
        light: Color(red: 0.26, green: 0.27, blue: 0.30),
        dark: Color(red: 0.69, green: 0.71, blue: 0.73)                // #b0b4ba
    )
    static let successGreen = Color.adaptive(
        light: Color(red: 0.09, green: 0.64, blue: 0.29),              // #16a34a
        dark: Color(red: 0.29, green: 0.87, blue: 0.50)                // #4ade80
    )
    static let errorRed = Color.adaptive(
        light: Color(red: 0.86, green: 0.15, blue: 0.15),              // #dc2626
        dark: Color(red: 0.97, green: 0.44, blue: 0.44)                // #f87171
    )
    static let blue = Color.adaptive(
        light: Color(red: 0.15, green: 0.39, blue: 0.92),              // #2563eb
        dark: Color(red: 0.38, green: 0.65, blue: 0.98)                // #60a5fa
    )
    static let purple = Color.adaptive(
        light: Color(red: 0.58, green: 0.20, blue: 0.92),              // #9333ea
        dark: Color(red: 0.75, green: 0.52, blue: 0.99)                // #c084fc
    )
    static let filePath = Color.adaptive(light: Color(white: 0.52), dark: Color(white: 0.40))
    static let dimText = Color.adaptive(light: Color(white: 0.72), dark: Color(white: 0.27))
}

// MARK: - Snapshot Helpers

/// Static tool row for snapshot rendering (Style 7a — flush left, 12px padding).
@ViewBuilder
private func toolRow(name: String, summary: String, expanded: Bool = false) -> some View {
    HStack(spacing: 8) {
        Text(name)
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(MockColors.toolName)
            .fixedSize()

        Text(summary)
            .font(.system(size: 10.5))
            .foregroundStyle(MockColors.toolSummary)
            .lineLimit(1)
            .truncationMode(.tail)

        Rectangle()
            .fill(MockColors.toolLine)
            .frame(height: 1)

        Text("\u{203A}")
            .font(.system(size: 9))
            .foregroundStyle(MockColors.toolChevron)
            .fixedSize()
            .rotationEffect(.degrees(expanded ? 90 : 0))
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 12)
}

/// Static turn for snapshot rendering.
@ViewBuilder
private func mockTurn(
    actor: String,
    @ViewBuilder content: () -> some View
) -> some View {
    let isUser = actor == "You"
    let bg = isUser ? MockColors.userBg : MockColors.agentBg
    let lineColor = isUser ? MockColors.userLine : MockColors.agentLine
    let labelColor = isUser ? MockColors.userLabel : MockColors.agentLabel

    VStack(alignment: .leading, spacing: 0) {
        TurnSeparator(label: actor, lineColor: lineColor, labelColor: labelColor)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

        content()
    }
    .padding(.top, 18)
    .padding(.bottom, 20)
    .background(bg)
}

// MARK: - Tool Renderer Mocks

/// Read detail: file preview with line numbers.
@ViewBuilder
private func readDetailMock() -> some View {
    VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
            Image(systemName: "doc.text")
                .font(.system(size: 10))
                .foregroundStyle(MockColors.detailLabel)
            Text("Package.swift")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(MockColors.filePath)
            Text("lines 1\u{2013}9")
                .font(.system(size: 9))
                .foregroundStyle(MockColors.dimText)
        }

        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array([
                "// swift-tools-version: 5.9",
                "",
                "import PackageDescription",
                "",
                "let package = Package(",
                "    name: \"BarrySessions\",",
                "    platforms: [",
                "        .macOS(.v14)",
                "    ],",
            ].enumerated()), id: \.offset) { idx, line in
                HStack(alignment: .top, spacing: 0) {
                    Text("\(idx + 1)")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(MockColors.lineNumber)
                        .frame(width: 32, alignment: .trailing)
                        .padding(.trailing, 12)
                    Text(line.isEmpty ? " " : line)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(MockColors.codeText)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 0.5)
            }
        }
        .padding(.vertical, 8)
        .background(MockColors.detailBg)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    .padding(.top, 4)
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
}

/// Bash detail: terminal output with prompt and exit code badge.
@ViewBuilder
private func bashDetailMock(command: String, output: String, isError: Bool) -> some View {
    let promptColor = isError ? MockColors.errorRed : MockColors.successGreen

    VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
            Text("$")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(promptColor)
            Text(command)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(MockColors.codeText)
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(isError ? "1" : "0")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(promptColor)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(promptColor.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 3))
        }

        Text(output)
            .font(.system(size: 10.5, design: .monospaced))
            .lineSpacing(10.5 * 0.55)
            .foregroundStyle(isError ? MockColors.errorRed.opacity(0.7) : MockColors.codeText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(MockColors.detailBg)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    .padding(.top, 4)
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
}

/// Edit detail: diff view with old/new lines.
@ViewBuilder
private func editDetailMock(file: String, oldLines: [String], newLines: [String]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
            Text(file)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(MockColors.filePath)
            Text("replaced")
                .font(.system(size: 9, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.3)
                .foregroundStyle(MockColors.blue)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(MockColors.blue.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 3))
        }

        VStack(alignment: .leading, spacing: 0) {
            ForEach(oldLines, id: \.self) { line in
                Text("- \(line)")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(MockColors.errorRed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 1)
                    .background(MockColors.errorRed.opacity(0.06))
            }
            ForEach(newLines, id: \.self) { line in
                Text("+ \(line)")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(MockColors.successGreen)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 1)
                    .background(MockColors.successGreen.opacity(0.06))
            }
        }
        .padding(.vertical, 6)
        .background(MockColors.detailBg)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    .padding(.top, 4)
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
}

/// Grep detail: search results with pattern pill.
@ViewBuilder
private func grepDetailMock() -> some View {
    VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
            Text("UserBubble")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(MockColors.blue)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(MockColors.blue.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 3))
            Text("3 matches in 2 files")
                .font(.system(size: 9))
                .foregroundStyle(MockColors.detailLabel)
        }

        VStack(alignment: .leading, spacing: 0) {
            Text("MessagesPanel.swift")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(MockColors.blue)
                .padding(.horizontal, 10)
                .padding(.bottom, 1)
            Text("101  UserBubble(content: msg.content ?? \"\")")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(MockColors.codeText)
                .padding(.horizontal, 10)
                .padding(.vertical, 0.5)
            Text("114  private func userBubble(_ msg: Message)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(MockColors.codeText)
                .padding(.horizontal, 10)
                .padding(.vertical, 0.5)

            Text("Snapshots/main.swift")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(MockColors.blue)
                .padding(.horizontal, 10)
                .padding(.top, 4)
                .padding(.bottom, 1)
            Text("160  UserBubble(content: \"Can you check...\")")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(MockColors.codeText)
                .padding(.horizontal, 10)
                .padding(.vertical, 0.5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .background(MockColors.detailBg)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    .padding(.top, 4)
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
}

/// Glob detail: file list with pattern pill.
@ViewBuilder
private func globDetailMock() -> some View {
    VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
            Text("**/*.swift")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(MockColors.purple)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(MockColors.purple.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 3))
            Text("7 files")
                .font(.system(size: 9))
                .foregroundStyle(MockColors.detailLabel)
        }

        VStack(alignment: .leading, spacing: 0) {
            ForEach([
                "Components/MarkdownText.swift",
                "Components/TurnSeparator.swift",
                "Components/HighlightrAdapter.swift",
                "Sources/Models/Message.swift",
                "Sources/Views/MessagesPanel.swift",
                "Sources/Views/ContentView.swift",
                "Sources/main.swift",
            ], id: \.self) { file in
                Text(file)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(MockColors.codeText)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .background(MockColors.detailBg)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
    .padding(.top, 4)
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
}

// MARK: - Scenarios

@MainActor
func renderAll(to dir: URL) {
    print("Rendering snapshots to \(dir.path)...\n")

    // 1. Markdown — headings & paragraphs
    renderSnapshot("01-headings", to: dir) {
        MarkdownText(content: """
        # Heading 1

        ## Heading 2

        ### Heading 3

        #### Heading 4

        This is a plain paragraph with some text that wraps to multiple lines to show how paragraph rendering works in the message bubble.
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 2. Markdown — inline formatting
    renderSnapshot("02-inline", to: dir) {
        MarkdownText(content: """
        This has **bold text**, *italic text*, and `inline code` mixed together.

        Here is ***bold italic*** text and a [link](https://example.com) to somewhere.

        Multiple `code spans` in one line with **bold** between them.
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 3. Markdown — lists
    renderSnapshot("03-lists", to: dir) {
        MarkdownText(content: """
        ### Bullet List

        - First item
        - Second item with **bold**
        - Third item with `code`

        ### Numbered List

        1. First step
        2. Second step
        3. Third step

        ### Nested

        - Parent item
          - Child item
          - Another child
        - Back to parent
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 4. Markdown — code blocks
    renderSnapshot("04-code-blocks", to: dir) {
        MarkdownText(content: """
        Here is some code:

        ```typescript
        const server = express();
        server.get("/health", (req, res) => {
          res.json({ ok: true });
        });
        ```

        And a block without a language:

        ```
        plain code block
        no syntax highlighting
        ```
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 5. Markdown — realistic assistant response
    renderSnapshot("05-realistic-response", width: 380, to: dir) {
        MarkdownText(content: """
        ### Done

        **Message Persistence Layer — implemented and committed (`ebb749ca`)**
        - Added `UserPromptSubmit` hook to capture user prompts
        - Added `Stop` hook to extract assistant responses from transcript
        - Added `POST /sessions/:id/messages/persist` endpoint

        ### Open Loops

        1. **OL-f7a2d8** — The `Stop` hook hasn't been verified in a fresh session yet
        2. **OL-3f8c21** — No automated tests for the persist endpoint

        ### Suggested Next Steps

        - Start a new `barry start` session and verify messages appear
        - Check the Messages tab in the BarrySessions app
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 6. Conversation turns — matches v13 mock layout exactly:
    //    agent turn → tool rows (outside turn) → agent turn → user turn → agent turn → expanded tool → tool
    renderSnapshot("06-conversation-turns", width: 420, to: dir) {
        VStack(spacing: 0) {
            mockTurn(actor: "Barry") {
                MarkdownText(content: "I'll swap the dependency and create a new adapter.")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }

            // Tool rows — outside turns, no background
            toolRow(name: "Read", summary: "Package.swift")
            toolRow(name: "Edit", summary: "Package.swift")
            toolRow(name: "Write", summary: "HighlightrAdapter.swift")
            toolRow(name: "Bash", summary: "swift build --target BarrySessions")

            mockTurn(actor: "Barry") {
                MarkdownText(content: "Done. Build succeeds.")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }

            mockTurn(actor: "You") {
                MarkdownText(content: "fix the inline code colors")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }

            mockTurn(actor: "Barry") {
                MarkdownText(content: "Switched from amber to light gray.")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }

            // Expanded tool row
            toolRow(name: "Edit", summary: "MarkdownText.swift", expanded: true)

            // Expanded detail
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Input")
                        .font(.system(size: 9, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(0.5)
                        .foregroundStyle(MockColors.detailLabel)

                    Text("{\n  \"file_path\": \"MarkdownText.swift\",\n  \"old_string\": \"Color(red: 0.90, green: 0.75, blue: 0.55)\",\n  \"new_string\": \"Color(red: 0.85, green: 0.87, blue: 0.91)\"\n}")
                        .font(.system(size: 10.5, design: .monospaced))
                        .lineSpacing(10.5 * 0.55)
                        .foregroundStyle(MockColors.inputColor)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(MockColors.detailBg)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Result")
                        .font(.system(size: 9, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(0.5)
                        .foregroundStyle(MockColors.detailLabel)

                    Text("The file MarkdownText.swift has been updated successfully.")
                        .font(.system(size: 10.5, design: .monospaced))
                        .lineSpacing(10.5 * 0.55)
                        .foregroundStyle(MockColors.resultColor)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(MockColors.detailBg)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
            .padding(.top, 4)
            .padding(.leading, 12)
            .padding(.trailing, 12)
            .padding(.bottom, 10)

            toolRow(name: "Bash", summary: "swift build")
        }
        .background(MockColors.panelBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // 7. Edge cases
    renderSnapshot("07-edge-cases", to: dir) {
        VStack(alignment: .leading, spacing: 12) {
            MarkdownText(content: "Just a single line, no markdown.")
                .foregroundStyle(.primary)

            MarkdownText(content: "Before divider\n\n---\n\nAfter divider")
                .foregroundStyle(.primary)

            MarkdownText(content: "Run `barry-hook-session-tracker assistant-message` to test the hook")
                .foregroundStyle(.primary)
        }
        .padding(12)
    }

    // 8. Code syntax highlighting
    renderSnapshot("08-code-syntax-highlight", to: dir) {
        MarkdownText(content: """
        Here's a Swift example with syntax highlighting:

        ```swift
        struct ContentView: View {
            @State private var count = 0

            var body: some View {
                VStack(spacing: 12) {
                    Text("Count: \\(count)")
                        .font(.title)
                    Button("Increment") {
                        count += 1
                    }
                }
                .padding()
            }
        }
        ```
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 9. Blockquote styling
    renderSnapshot("09-blockquote", to: dir) {
        MarkdownText(content: """
        Here is some context before the quote.

        > **Note:** The `markdownTheme` modifier accepts a custom `Theme` value. \
        Use it to override default styles for headings, code blocks, and inline elements.

        > This is a second blockquote to verify consistent styling across multiple blocks.

        And some text after.
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 10. Read renderer — file preview with line numbers
    renderSnapshot("10-read-detail", width: 420, to: dir) {
        VStack(spacing: 0) {
            toolRow(name: "Read", summary: "Package.swift", expanded: true)
            readDetailMock()
        }
        .background(MockColors.panelBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // 15. Bash renderer — terminal output with prompt and exit code
    renderSnapshot("15-bash-detail", width: 420, to: dir) {
        VStack(spacing: 0) {
            toolRow(name: "Bash", summary: "swift build --target BarrySessions", expanded: true)
            bashDetailMock(
                command: "swift build --target BarrySessions",
                output: "Building for debugging...\n[1/4] Compiling Components TurnSeparator.swift\n[2/4] Compiling Components MarkdownText.swift\n[3/4] Emitting module BarrySessions\n[4/4] Compiling BarrySessions MessagesPanel.swift\nBuild of target: 'BarrySessions' complete! (3.29s)",
                isError: false
            )

            toolRow(name: "Bash", summary: "swift test", expanded: true)
            bashDetailMock(
                command: "swift test",
                output: "error: no targets found at 'Tests'",
                isError: true
            )
        }
        .background(MockColors.panelBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // 16. Edit renderer — diff view
    renderSnapshot("16-edit-detail", width: 420, to: dir) {
        VStack(spacing: 0) {
            toolRow(name: "Edit", summary: "MarkdownText.swift", expanded: true)
            editDetailMock(
                file: "Components/MarkdownText.swift",
                oldLines: ["Color(red: 0.90, green: 0.75, blue: 0.55)"],
                newLines: ["Color(red: 0.85, green: 0.87, blue: 0.91)"]
            )

            toolRow(name: "Edit", summary: "MessagesPanel.swift", expanded: true)
            editDetailMock(
                file: "Sources/Views/MessagesPanel.swift",
                oldLines: [".padding(.top, 8)", ".padding(.bottom, 12)"],
                newLines: [".padding(.top, 18)", ".padding(.bottom, 20)"]
            )
        }
        .background(MockColors.panelBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // 17. Grep + Glob renderers
    renderSnapshot("17-search-details", width: 420, to: dir) {
        VStack(spacing: 0) {
            toolRow(name: "Grep", summary: "UserBubble", expanded: true)
            grepDetailMock()

            toolRow(name: "Glob", summary: "**/*.swift", expanded: true)
            globDetailMock()
        }
        .background(MockColors.panelBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // 11. TypeScript syntax highlighting
    renderSnapshot("11-typescript-highlight", to: dir) {
        MarkdownText(content: """
        TypeScript with proper keyword and type coloring:

        ```typescript
        interface User {
          id: string;
          name: string;
          role: "admin" | "member";
        }

        const getUser = async (id: string): Promise<User> => {
          const res = await fetch(`/api/users/${id}`);
          if (!res.ok) throw new Error("Not found");
          return res.json();
        };
        ```
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 12. Python syntax highlighting
    renderSnapshot("12-python-highlight", to: dir) {
        MarkdownText(content: """
        Python with decorators, f-strings, and type hints:

        ```python
        from dataclasses import dataclass
        from typing import Optional

        @dataclass
        class Config:
            host: str = "localhost"
            port: int = 8080
            debug: bool = False

        def create_app(config: Optional[Config] = None) -> "App":
            cfg = config or Config()
            print(f"Starting on {cfg.host}:{cfg.port}")
            return App(cfg)
        ```
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 13. Table rendering
    renderSnapshot("13-table", width: 420, to: dir) {
        MarkdownText(content: """
        Here are the endpoints:

        | Method | Path | Description |
        | --- | --- | --- |
        | GET | `/sessions` | List all sessions |
        | POST | `/sessions` | Create a new session |
        | GET | `/sessions/:id` | Get session detail |
        | DELETE | `/sessions/:id` | Delete a session |
        | POST | `/sessions/:id/messages` | Add a message |

        Use the `Authorization` header with a bearer token.
        """)
        .foregroundStyle(.primary)
        .padding(12)
    }

    // 14. Timestamp pill between turns
    renderSnapshot("14-timestamp-pill", width: 420, to: dir) {
        VStack(spacing: 0) {
            mockTurn(actor: "Barry") {
                MarkdownText(content: "Done! The session is set up and ready.")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }

            // Timestamp pill
            HStack {
                Spacer()
                Text("Today, 2:47 PM")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(MockColors.toolName)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 14)
                    .background(Color.primary.opacity(0.035))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                Spacer()
            }
            .padding(.vertical, 10)

            mockTurn(actor: "You") {
                MarkdownText(content: "Hey, can you check on the deploy status?")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
            }
        }
    }
}

// MARK: - Main

@MainActor
func main() throws {
    let outputDir: URL
    if let path = CommandLine.arguments.dropFirst().first(where: { !$0.hasPrefix("--") }) {
        outputDir = URL(fileURLWithPath: path)
    } else {
        outputDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(renderLight ? "barry-snapshots-light" : "barry-snapshots")
    }

    try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

    // Pin the app appearance to match the render mode (dark unless --light)
    NSApplication.shared.appearance = NSAppearance(named: renderLight ? .aqua : .darkAqua)

    registerFonts()
    renderAll(to: outputDir)

    print("\nDone! Opening \(outputDir.path)")
    NSWorkspace.shared.open(outputDir)
}

try await MainActor.run {
    try main()
}
