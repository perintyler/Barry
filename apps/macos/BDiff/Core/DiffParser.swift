import Foundation

/// Parses unified diff text into structured DiffFile models with word-level change detection.
public enum DiffParser {
    public static func parse(_ text: String) -> [DiffFile] {
        var lineId = 0
        return parse(text, repoPath: nil, repoName: nil, lineIdStart: &lineId)
    }

    /// Repo-scoped parse for session views spanning multiple repos.
    ///
    /// `lineIdStart` must be threaded across calls so `DiffLine.id` stays
    /// globally unique (syntax-highlight caching and row identity key off it),
    /// and file ids are repo-qualified so identical paths in different repos
    /// don't collide.
    public static func parse(
        _ text: String,
        repoPath: String?,
        repoName: String?,
        lineIdStart: inout Int
    ) -> [DiffFile] {
        guard !text.isEmpty else { return [] }

        let fileSections = splitIntoFileSections(text)
        var files: [DiffFile] = []

        for section in fileSections {
            if let file = parseFileSection(section, repoPath: repoPath, repoName: repoName, lineIdStart: &lineIdStart) {
                files.append(file)
            }
        }

        return files
    }

    // MARK: - File splitting

    private static func splitIntoFileSections(_ text: String) -> [String] {
        var sections: [String] = []
        var current = ""

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            if (s.hasPrefix("diff --git") || s.hasPrefix("diff --no-index")) && !current.isEmpty {
                sections.append(current)
                current = ""
            }
            current += s + "\n"
        }
        if !current.isEmpty { sections.append(current) }
        return sections
    }

    // MARK: - Per-file parsing

    private static let binaryExtensions: Set<String> = [".o", ".d", ".swiftdeps", ".plist", ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".gz", ".tar", ".jar", ".exe", ".dylib", ".so", ".a"]

    private static func parseFileSection(_ text: String, repoPath: String?, repoName: String?, lineIdStart: inout Int) -> DiffFile? {
        // Skip sections that contain binary patch data
        if text.contains("GIT binary patch") || text.contains("Binary files") { return nil }

        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard !lines.isEmpty else { return nil }

        // Skip binary files by extension (from the diff header)
        if let firstLine = lines.first {
            let pathPart = firstLine.components(separatedBy: " b/").last ?? firstLine
            if binaryExtensions.contains(where: { pathPart.hasSuffix($0) }) { return nil }
        }

        // Detect paths
        var oldPath = ""
        var newPath = ""
        var status: FileStatus = .modified
        var hunkStartIndex = 0

        for (i, line) in lines.enumerated() {
            if line.hasPrefix("--- a/") {
                oldPath = String(line.dropFirst(6))
            } else if line.hasPrefix("--- /dev/null") {
                oldPath = "/dev/null"
                status = .added
            } else if line.hasPrefix("+++ b/") {
                newPath = String(line.dropFirst(6))
            } else if line.hasPrefix("+++ /dev/null") {
                newPath = "/dev/null"
                status = .deleted
            } else if line.hasPrefix("new file") {
                status = .added
            } else if line.hasPrefix("deleted file") {
                status = .deleted
            } else if line.hasPrefix("rename from ") {
                oldPath = String(line.dropFirst(12))
                status = .renamed
            } else if line.hasPrefix("rename to ") {
                newPath = String(line.dropFirst(10))
            } else if line.hasPrefix("Binary files") || line.hasPrefix("GIT binary patch") {
                return nil
            } else if line.hasPrefix("@@") {
                hunkStartIndex = i
                break
            }
        }

        // Handle diff --no-index paths (used for untracked files)
        if oldPath.isEmpty && newPath.isEmpty {
            for line in lines {
                if line.hasPrefix("--- ") && !line.hasPrefix("--- a/") {
                    let path = String(line.dropFirst(4))
                    oldPath = path == "/dev/null" ? "/dev/null" : path
                } else if line.hasPrefix("+++ ") && !line.hasPrefix("+++ b/") {
                    newPath = String(line.dropFirst(4))
                }
            }
            if oldPath == "/dev/null" { status = .added }
        }

        guard !newPath.isEmpty || !oldPath.isEmpty else { return nil }

        // Parse hunks
        let hunks = parseHunks(Array(lines[hunkStartIndex...]), lineIdStart: &lineIdStart)

        let displayPath = newPath.isEmpty || newPath == "/dev/null" ? oldPath : newPath
        let id = repoPath.map { "\($0)::\(displayPath)" } ?? displayPath
        return DiffFile(
            id: id, oldPath: oldPath, newPath: newPath, status: status, hunks: hunks,
            repoPath: repoPath, repoName: repoName
        )
    }

    // MARK: - Hunk parsing

    private static func parseHunks(_ lines: [String], lineIdStart: inout Int) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var hunkId = 0
        var currentLines: [String] = []
        var currentHeader = ""
        var oldStart = 0, oldCount = 0, newStart = 0, newCount = 0

        func flushHunk() {
            guard !currentHeader.isEmpty else { return }
            let contextHeader = extractContextHeader(currentHeader)
            let parsed = parseHunkLines(currentLines, oldStart: oldStart, newStart: newStart, lineIdStart: &lineIdStart)
            hunks.append(DiffHunk(
                id: hunkId, header: currentHeader, contextHeader: contextHeader,
                oldStart: oldStart, oldCount: oldCount, newStart: newStart, newCount: newCount,
                lines: parsed
            ))
            hunkId += 1
        }

        for line in lines {
            if line.hasPrefix("@@") {
                flushHunk()
                currentHeader = line
                currentLines = []

                // Parse @@ -old,count +new,count @@
                let pattern = #/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/#
                if let match = try? pattern.firstMatch(in: line) {
                    oldStart = Int(match.output.1) ?? 0
                    oldCount = match.output.2.flatMap { Int($0) } ?? 1
                    newStart = Int(match.output.3) ?? 0
                    newCount = match.output.4.flatMap { Int($0) } ?? 1
                }
            } else if !currentHeader.isEmpty {
                // Skip "no newline" markers
                if line.hasPrefix("\\ No newline") { continue }
                currentLines.append(line)
            }
        }

        flushHunk()
        return hunks
    }

    private static func extractContextHeader(_ header: String) -> String? {
        // Extract function/class name after the second @@
        guard let range = header.range(of: "@@", options: [], range: header.index(header.startIndex, offsetBy: 2)..<header.endIndex) else {
            return nil
        }
        let context = String(header[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        return context.isEmpty ? nil : context
    }

    private static func parseHunkLines(_ lines: [String], oldStart: Int, newStart: Int, lineIdStart: inout Int) -> [DiffLine] {
        var result: [DiffLine] = []
        var oldLine = oldStart
        var newLine = newStart

        // Collect raw lines first, then do word-level diff on adjacent del/add pairs
        struct RawLine {
            let type: LineType
            let content: String
            let oldLineNumber: Int?
            let newLineNumber: Int?
        }

        var rawLines: [RawLine] = []
        for line in lines {
            if line.hasPrefix("+") {
                rawLines.append(RawLine(type: .addition, content: String(line.dropFirst()), oldLineNumber: nil, newLineNumber: newLine))
                newLine += 1
            } else if line.hasPrefix("-") {
                rawLines.append(RawLine(type: .deletion, content: String(line.dropFirst()), oldLineNumber: oldLine, newLineNumber: nil))
                oldLine += 1
            } else {
                let content = line.hasPrefix(" ") ? String(line.dropFirst()) : line
                rawLines.append(RawLine(type: .context, content: content, oldLineNumber: oldLine, newLineNumber: newLine))
                oldLine += 1
                newLine += 1
            }
        }

        // Word-level diff: find adjacent deletion+addition pairs
        var i = 0
        while i < rawLines.count {
            let raw = rawLines[i]

            if raw.type == .deletion {
                // Look for adjacent addition(s)
                var delLines: [RawLine] = [raw]
                var j = i + 1
                while j < rawLines.count && rawLines[j].type == .deletion {
                    delLines.append(rawLines[j])
                    j += 1
                }
                var addLines: [RawLine] = []
                var k = j
                while k < rawLines.count && rawLines[k].type == .addition {
                    addLines.append(rawLines[k])
                    k += 1
                }

                // Pair up deletions with additions for word-level diff
                let pairCount = min(delLines.count, addLines.count)
                for p in 0..<pairCount {
                    let (delChanges, addChanges) = computeWordChanges(old: delLines[p].content, new: addLines[p].content)
                    result.append(DiffLine(id: lineIdStart, type: .deletion, content: delLines[p].content,
                                           oldLineNumber: delLines[p].oldLineNumber, newLineNumber: nil,
                                           wordChanges: delChanges))
                    lineIdStart += 1
                    result.append(DiffLine(id: lineIdStart, type: .addition, content: addLines[p].content,
                                           oldLineNumber: nil, newLineNumber: addLines[p].newLineNumber,
                                           wordChanges: addChanges))
                    lineIdStart += 1
                }

                // Remaining unmatched deletions
                for p in pairCount..<delLines.count {
                    result.append(DiffLine(id: lineIdStart, type: .deletion, content: delLines[p].content,
                                           oldLineNumber: delLines[p].oldLineNumber, newLineNumber: nil,
                                           wordChanges: nil))
                    lineIdStart += 1
                }

                // Remaining unmatched additions
                for p in pairCount..<addLines.count {
                    result.append(DiffLine(id: lineIdStart, type: .addition, content: addLines[p].content,
                                           oldLineNumber: nil, newLineNumber: addLines[p].newLineNumber,
                                           wordChanges: nil))
                    lineIdStart += 1
                }

                i = k
            } else {
                result.append(DiffLine(id: lineIdStart, type: raw.type, content: raw.content,
                                       oldLineNumber: raw.oldLineNumber, newLineNumber: raw.newLineNumber,
                                       wordChanges: nil))
                lineIdStart += 1
                i += 1
            }
        }

        return result
    }

    // MARK: - Word-level diff (simple token-based LCS)

    private static func computeWordChanges(old: String, new: String) -> ([WordChange], [WordChange]) {
        let oldTokens = tokenize(old)
        let newTokens = tokenize(new)

        // Skip word-level diff for long lines (LCS is O(m*n) memory)
        guard !oldTokens.isEmpty && !newTokens.isEmpty,
              oldTokens.count <= 50 && newTokens.count <= 50 else {
            return ([], [])
        }

        // LCS table — use a flat array to avoid stack overflow from nested arrays
        let m = oldTokens.count
        let n = newTokens.count
        let stride = n + 1
        var dp = [Int](repeating: 0, count: (m + 1) * stride)
        for i in 1...m {
            for j in 1...n {
                if oldTokens[i - 1].text == newTokens[j - 1].text {
                    dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)] + 1
                } else {
                    dp[i * stride + j] = max(dp[(i - 1) * stride + j], dp[i * stride + (j - 1)])
                }
            }
        }

        // Backtrack to find which tokens are NOT in the LCS (= changed)
        var oldChanged = [Bool](repeating: true, count: m)
        var newChanged = [Bool](repeating: true, count: n)
        var ci = m, cj = n
        while ci > 0 && cj > 0 {
            if oldTokens[ci - 1].text == newTokens[cj - 1].text {
                oldChanged[ci - 1] = false
                newChanged[cj - 1] = false
                ci -= 1
                cj -= 1
            } else if dp[(ci - 1) * stride + cj] > dp[ci * stride + (cj - 1)] {
                ci -= 1
            } else {
                cj -= 1
            }
        }

        // Build WordChange arrays from changed tokens
        var delChanges: [WordChange] = []
        for (i, changed) in oldChanged.enumerated() where changed {
            delChanges.append(WordChange(range: oldTokens[i].range, type: .deletion))
        }

        var addChanges: [WordChange] = []
        for (i, changed) in newChanged.enumerated() where changed {
            addChanges.append(WordChange(range: newTokens[i].range, type: .addition))
        }

        return (delChanges, addChanges)
    }

    private struct Token {
        let text: String
        let range: Range<String.Index>
    }

    private static func tokenize(_ string: String) -> [Token] {
        var tokens: [Token] = []
        var i = string.startIndex

        while i < string.endIndex {
            let c = string[i]
            if c.isWhitespace {
                let start = i
                while i < string.endIndex && string[i].isWhitespace { i = string.index(after: i) }
                tokens.append(Token(text: String(string[start..<i]), range: start..<i))
            } else if c.isLetter || c.isNumber || c == "_" {
                let start = i
                while i < string.endIndex && (string[i].isLetter || string[i].isNumber || string[i] == "_") {
                    i = string.index(after: i)
                }
                tokens.append(Token(text: String(string[start..<i]), range: start..<i))
            } else {
                let start = i
                i = string.index(after: i)
                tokens.append(Token(text: String(string[start..<i]), range: start..<i))
            }
        }

        return tokens
    }
}
