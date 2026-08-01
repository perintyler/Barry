import Components
import SwiftUI

/// Parsed tool input fields, extracted once from the JSON string.
struct ToolInput {
    let raw: String
    let fields: [String: Any]

    init(_ json: String?) {
        raw = json ?? ""
        if let data = json?.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            fields = obj
        } else {
            fields = [:]
        }
    }

    func string(_ key: String) -> String? { fields[key] as? String }
    func int(_ key: String) -> Int? { fields[key] as? Int }
    func bool(_ key: String) -> Bool? { fields[key] as? Bool }
}

// MARK: - Dispatch

/// Routes to the appropriate custom renderer, or falls back to generic input/result panels.
@ViewBuilder
func toolDetailView(name: String, input: ToolInput, result: String?) -> some View {
    switch name {
    case "Read", "mcp__barry__Read":
        ReadDetail(input: input, result: result)
    case "Bash", "mcp__barry__Bash":
        BashDetail(input: input, result: result)
    case "Edit", "mcp__barry__Edit":
        EditDetail(input: input, result: result)
    case "Write", "mcp__barry__Write":
        WriteDetail(input: input, result: result)
    case "Grep", "mcp__barry__Grep":
        GrepDetail(input: input, result: result)
    case "Glob", "mcp__barry__Glob":
        GlobDetail(input: input, result: result)
    default:
        GenericDetail(input: input, result: result)
    }
}

// MARK: - Shared Colors

/// Light/dark pairs — dark values are the original dark-only design;
/// light values mirror the same hierarchy on a light background
/// (accents use the darker 600-tier of the same hues).
private enum DetailColors {
    static let detailBg = Color.adaptive(
        light: Color.black.opacity(0.05),
        dark: Color.black.opacity(0.15)
    )
    static let label = Color.adaptive(
        light: Color(white: 0.60),
        dark: Color(white: 0.33)                                          // #555
    )
    static let inputText = Color.adaptive(
        light: Color(red: 0.40, green: 0.41, blue: 0.44),
        dark: Color(red: 0.60, green: 0.62, blue: 0.64)                   // #9a9da3
    )
    static let resultGreen = successGreen.opacity(0.7)
    static let lineNumber = Color.adaptive(
        light: Color(red: 0.78, green: 0.78, blue: 0.80),
        dark: Color(red: 0.23, green: 0.24, blue: 0.26)                   // #3a3d42
    )
    static let codeText = Color.adaptive(
        light: Color(red: 0.26, green: 0.27, blue: 0.30),
        dark: Color(red: 0.69, green: 0.71, blue: 0.73)                   // #b0b4ba
    )
    static let successGreen = Color.adaptive(
        light: Color(red: 0.09, green: 0.64, blue: 0.29),                 // #16a34a
        dark: Color(red: 0.29, green: 0.87, blue: 0.50)                   // #4ade80
    )
    static let errorRed = Color.adaptive(
        light: Color(red: 0.86, green: 0.15, blue: 0.15),                 // #dc2626
        dark: Color(red: 0.97, green: 0.44, blue: 0.44)                   // #f87171
    )
    static let blue = Color.adaptive(
        light: Color(red: 0.15, green: 0.39, blue: 0.92),                 // #2563eb
        dark: Color(red: 0.38, green: 0.65, blue: 0.98)                   // #60a5fa
    )
    static let purple = Color.adaptive(
        light: Color(red: 0.58, green: 0.20, blue: 0.92),                 // #9333ea
        dark: Color(red: 0.75, green: 0.52, blue: 0.99)                   // #c084fc
    )
    static let amber = Color.adaptive(
        light: Color(red: 0.71, green: 0.33, blue: 0.04),                 // #b45309
        dark: Color(red: 0.98, green: 0.75, blue: 0.14)                   // #fbbf24
    )
    static let dimText = Color.adaptive(
        light: Color(white: 0.72),
        dark: Color(white: 0.27)                                          // #444
    )
    static let filePath = Color.adaptive(
        light: Color(white: 0.52),
        dark: Color(white: 0.40)                                          // #666
    )
}

// MARK: - Read Detail

/// File preview with line numbers.
private struct ReadDetail: View {
    let input: ToolInput
    let result: String?

    var body: some View {
        let filePath = input.string("file_path") ?? "unknown"
        let fileName = (filePath as NSString).lastPathComponent
        let lines = resultLines

        VStack(alignment: .leading, spacing: 6) {
            // Header: icon + path + line range
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(DetailColors.label)
                Text(fileName)
                    .font(AppFont.mono(size: 10))
                    .foregroundStyle(DetailColors.filePath)
                if !lines.isEmpty {
                    Text("lines 1\u{2013}\(lines.count)")
                        .font(AppFont.sans(size: 9))
                        .foregroundStyle(DetailColors.dimText)
                }
            }

            // Content with line numbers
            if !lines.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { idx, line in
                            HStack(alignment: .top, spacing: 0) {
                                Text("\(idx + 1)")
                                    .font(AppFont.mono(size: 10.5))
                                    .foregroundStyle(DetailColors.lineNumber)
                                    .frame(width: 32, alignment: .trailing)
                                    .padding(.trailing, 12)

                                Text(line.isEmpty ? " " : line)
                                    .font(AppFont.mono(size: 10.5))
                                    .foregroundStyle(DetailColors.codeText)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 0.5)
                        }
                    }
                }
                .frame(maxHeight: 160)
                .background(DetailColors.detailBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }

    private var resultLines: [String] {
        guard let result, !result.isEmpty else { return [] }
        return result.components(separatedBy: "\n")
    }
}

// MARK: - Bash Detail

/// Terminal-style output with prompt, command, and exit code badge.
private struct BashDetail: View {
    let input: ToolInput
    let result: String?

    var body: some View {
        let command = input.string("command") ?? ""
        let isError = resultIsError

        VStack(alignment: .leading, spacing: 6) {
            // Command line: $ command [exit code]
            HStack(spacing: 6) {
                Text("$")
                    .font(AppFont.mono(size: 10, weight: .semibold))
                    .foregroundStyle(isError ? DetailColors.errorRed : DetailColors.successGreen)

                Text(command)
                    .font(AppFont.mono(size: 10.5))
                    .foregroundStyle(DetailColors.codeText)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 0)

                Text(isError ? "1" : "0")
                    .font(AppFont.mono(size: 9, weight: .semibold))
                    .foregroundStyle(isError ? DetailColors.errorRed : DetailColors.successGreen)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background((isError ? DetailColors.errorRed : DetailColors.successGreen).opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }

            // Output
            if let result, !result.isEmpty {
                ScrollView {
                    Text(result)
                        .font(AppFont.mono(size: 10.5))
                        .lineSpacing(10.5 * 0.55)
                        .foregroundStyle(isError ? DetailColors.errorRed.opacity(0.7) : DetailColors.codeText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 160)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(DetailColors.detailBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }

    /// Best-effort error detection — the API doesn't expose exit codes.
    /// Checks for common error patterns in the first 300 chars of output.
    private var resultIsError: Bool {
        guard let result else { return false }
        let prefix = String(result.prefix(300)).lowercased()
        return prefix.contains("error:") || prefix.contains("error[") ||
               prefix.contains("fatal:") || prefix.contains("fatal error") ||
               prefix.contains("command not found") ||
               prefix.contains("no such file") ||
               prefix.contains("permission denied") ||
               prefix.hasPrefix("exit code")
    }
}

// MARK: - Edit Detail

/// Diff view showing old_string → new_string.
private struct EditDetail: View {
    let input: ToolInput
    let result: String?

    private struct DiffLine: Identifiable {
        let id: Int
        let text: String
        let isOld: Bool
    }

    /// Cached diff lines — parsed once per view identity, not per frame.
    private var diffLines: [DiffLine] {
        let oldString = input.string("old_string") ?? ""
        let newString = input.string("new_string") ?? ""
        var lines: [DiffLine] = []
        for line in oldString.components(separatedBy: "\n") {
            lines.append(DiffLine(id: lines.count, text: "- \(line)", isOld: true))
        }
        for line in newString.components(separatedBy: "\n") {
            lines.append(DiffLine(id: lines.count, text: "+ \(line)", isOld: false))
        }
        return lines
    }

    var body: some View {
        let filePath = input.string("file_path") ?? "unknown"
        let fileName = (filePath as NSString).lastPathComponent
        let lines = diffLines

        VStack(alignment: .leading, spacing: 6) {
            // Header: file path + badge
            HStack(spacing: 6) {
                Text(fileName)
                    .font(AppFont.mono(size: 10))
                    .foregroundStyle(DetailColors.filePath)

                Text("replaced")
                    .font(AppFont.sans(size: 9, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.3)
                    .foregroundStyle(DetailColors.blue)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(DetailColors.blue.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }

            // Diff content
            if !lines.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { dl in
                            Text(dl.text)
                                .font(AppFont.mono(size: 10.5))
                                .foregroundStyle(dl.isOld ? DetailColors.errorRed : DetailColors.successGreen)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 1)
                                .background((dl.isOld ? DetailColors.errorRed : DetailColors.successGreen).opacity(0.06))
                        }
                    }
                    .padding(.vertical, 6)
                }
                .frame(maxHeight: 160)
                .background(DetailColors.detailBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }
}

// MARK: - Write Detail

/// File created confirmation with content preview.
private struct WriteDetail: View {
    let input: ToolInput
    let result: String?

    /// Cached preview — truncates to 8 lines, computed once per view identity.
    private var contentPreview: (fileName: String, lineCount: Int, preview: String) {
        let filePath = input.string("file_path") ?? "unknown"
        let content = input.string("content") ?? ""
        let lines = content.components(separatedBy: "\n")
        let preview: String
        if lines.count <= 8 {
            preview = content
        } else {
            preview = lines.prefix(8).joined(separator: "\n") + "\n..."
        }
        return ((filePath as NSString).lastPathComponent, lines.count, preview)
    }

    var body: some View {
        let info = contentPreview

        VStack(alignment: .leading, spacing: 6) {
            // Header: + icon + path + line count
            HStack(spacing: 6) {
                Text("+")
                    .font(AppFont.mono(size: 10, weight: .bold))
                    .foregroundStyle(DetailColors.successGreen)
                Text(info.fileName)
                    .font(AppFont.mono(size: 10))
                    .foregroundStyle(DetailColors.filePath)
                Text("\(info.lineCount) lines")
                    .font(AppFont.sans(size: 9))
                    .foregroundStyle(DetailColors.dimText)
            }

            // Content preview (truncated)
            if !info.preview.isEmpty {
                ScrollView {
                    Text(info.preview)
                        .font(AppFont.mono(size: 10.5))
                        .lineSpacing(10.5 * 0.55)
                        .foregroundStyle(DetailColors.successGreen.opacity(0.7))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 100)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(DetailColors.detailBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }
}

// MARK: - Grep Detail

/// Search results with highlighted pattern and grouped file matches.
private struct GrepDetail: View {
    let input: ToolInput
    let result: String?

    private struct ResultLine: Identifiable {
        let id: Int
        let text: String
        let isFile: Bool
        let isFirst: Bool
    }

    /// Parsed once and cached — avoids re-parsing on every render frame.
    private var parsedLines: [ResultLine] {
        Self.parseResultLines(result)
    }

    var body: some View {
        let pattern = input.string("pattern") ?? ""
        let lines = parsedLines

        VStack(alignment: .leading, spacing: 6) {
            // Header: pattern pill + match count
            HStack(spacing: 6) {
                Text(pattern)
                    .font(AppFont.mono(size: 10.5))
                    .foregroundStyle(DetailColors.blue)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(DetailColors.blue.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 3))

                if !lines.isEmpty {
                    let matchCount = lines.filter { !$0.isFile }.count
                    Text("\(matchCount) matches")
                        .font(AppFont.sans(size: 9))
                        .foregroundStyle(DetailColors.label)
                }
            }

            // Results
            if !lines.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in
                            if line.isFile {
                                Text(line.text)
                                    .font(AppFont.mono(size: 10))
                                    .foregroundStyle(DetailColors.blue)
                                    .padding(.horizontal, 10)
                                    .padding(.top, line.isFirst ? 0 : 4)
                                    .padding(.bottom, 1)
                            } else {
                                Text(line.text)
                                    .font(AppFont.mono(size: 10.5))
                                    .foregroundStyle(DetailColors.codeText)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 0.5)
                            }
                        }
                    }
                    .padding(.vertical, 6)
                }
                .frame(maxHeight: 160)
                .background(DetailColors.detailBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }

    /// Parse grep output. Handles two formats:
    /// - files_with_matches: one file path per line
    /// - content: lines like "file.swift:42:  matched text"
    /// Falls back to plain text lines if neither pattern matches.
    private static func parseResultLines(_ result: String?) -> [ResultLine] {
        guard let result, !result.isEmpty else { return [] }
        let rawLines = result.components(separatedBy: "\n").filter { !$0.isEmpty }
        guard !rawLines.isEmpty else { return [] }

        // Detect format: if most lines contain ":" with a number, it's content mode
        let colonCount = rawLines.filter { $0.range(of: #":\d+:"#, options: .regularExpression) != nil }.count
        let isContentMode = colonCount > rawLines.count / 2

        if isContentMode {
            var parsed: [ResultLine] = []
            var lastFile = ""
            for line in rawLines {
                let parts = line.split(separator: ":", maxSplits: 2)
                if parts.count >= 2, let _ = Int(parts[1]) {
                    let file = String(parts[0])
                    if file != lastFile {
                        parsed.append(ResultLine(id: parsed.count, text: file, isFile: true, isFirst: parsed.isEmpty))
                        lastFile = file
                    }
                    let content = parts.count > 2 ? String(parts[2]) : ""
                    parsed.append(ResultLine(id: parsed.count, text: "\(parts[1])  \(content)", isFile: false, isFirst: false))
                } else {
                    parsed.append(ResultLine(id: parsed.count, text: line, isFile: false, isFirst: false))
                }
            }
            return parsed
        } else {
            return rawLines.enumerated().map { idx, line in
                ResultLine(id: idx, text: line, isFile: true, isFirst: idx == 0)
            }
        }
    }
}

// MARK: - Glob Detail

/// File list with pattern pill.
private struct GlobDetail: View {
    let input: ToolInput
    let result: String?

    var body: some View {
        let pattern = input.string("pattern") ?? ""

        VStack(alignment: .leading, spacing: 6) {
            // Header: pattern pill + count
            HStack(spacing: 6) {
                Text(pattern)
                    .font(AppFont.mono(size: 10.5))
                    .foregroundStyle(DetailColors.purple)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(DetailColors.purple.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 3))

                if let result, !result.isEmpty {
                    let fileCount = result.components(separatedBy: "\n").filter({ !$0.isEmpty }).count
                    Text("\(fileCount) files")
                        .font(AppFont.sans(size: 9))
                        .foregroundStyle(DetailColors.label)
                }
            }

            // File list
            if let result, !result.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(
                            result.components(separatedBy: "\n").filter({ !$0.isEmpty }),
                            id: \.self
                        ) { file in
                            Text(file)
                                .font(AppFont.mono(size: 10.5))
                                .foregroundStyle(DetailColors.codeText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 1)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .frame(maxHeight: 130)
                .background(DetailColors.detailBg)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }
}

// MARK: - Generic Detail (Fallback)

/// Generic input/result JSON panels for tools without a custom renderer.
struct GenericDetail: View {
    let input: ToolInput
    let result: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !input.raw.isEmpty {
                detailSection(label: "Input", text: Message.formatJson(input.raw), isResult: false)
            }
            if let result, !result.isEmpty {
                detailSection(label: "Result", text: result, isResult: true)
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }

    private func detailSection(label: String, text: String, isResult: Bool) -> some View {
        let lineCount = text.components(separatedBy: "\n").count

        return VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label)
                    .font(AppFont.sans(size: 9, weight: .semibold))
                    .textCase(.uppercase)
                    .tracking(0.5)
                    .foregroundStyle(DetailColors.label)
                Spacer()
                if lineCount > 6 {
                    Text("\(lineCount) lines")
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundStyle(.quaternary)
                }
            }

            ScrollView {
                Text(text)
                    .font(AppFont.mono(size: 10.5))
                    .lineSpacing(10.5 * 0.55)
                    .foregroundStyle(isResult ? DetailColors.resultGreen : DetailColors.inputText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 130)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(DetailColors.detailBg)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }
}
