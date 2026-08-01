import Foundation
import HighlightSwift
import BDiffCore

/// Pre-highlights diff line content using HighlightSwift.
/// Caches results by content+language+theme so unchanged lines survive across
/// polls without re-running the heavyweight NSAttributedString HTML importer
/// (which leaks Mach ports via XPC connections to nsattributedstringagent).
///
/// Architecture note: HighlightSwift runs highlight.js in JavaScriptCore then
/// converts the HTML output via NSAttributedString(data:options:.html), which
/// spawns XPC connections per call. The content cache and per-pass import cap
/// mitigate this, but if highlighting needs to scale further, the right move
/// is to highlight inside the Monaco WebView's JS context (where highlight.js
/// already runs) and pass styled tokens back, eliminating the XPC path entirely.
actor SyntaxHighlighter {
    private let highlight = Highlight()

    /// Live results keyed by DiffLine.id — what the view reads.
    private var cache: [Int: AttributedString] = [:]

    /// Long-lived content cache keyed by (content, language, isDark).
    /// Survives across highlight passes so only genuinely new lines hit the
    /// HTML importer. Uses access-ordered eviction (LRU) so actively viewed
    /// content stays warm while stale entries from old diffs age out.
    private var contentCache: [ContentKey: ContentEntry] = [:]
    private var accessCounter: UInt64 = 0
    private static let maxContentCacheSize = 10_000
    /// Cap the number of new HTML imports per pass to bound Mach port creation.
    /// Lines beyond this limit fall back to plain text until the next pass
    /// (where they'll likely hit the content cache). With the 30s poll cycle
    /// and content caching, even large diffs converge within a few passes.
    private static let maxNewImportsPerPass = 2_000

    private struct ContentKey: Hashable {
        let content: String
        let language: String
        let isDark: Bool
    }

    private struct ContentEntry {
        let value: AttributedString
        var lastAccess: UInt64
    }

    /// Map file extensions to highlight.js language names
    private static let extensionToLanguage: [String: String] = [
        "swift": "swift", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "jsx": "javascript", "json": "json",
        "py": "python", "rb": "ruby", "rs": "rust", "go": "go",
        "java": "java", "kt": "kotlin", "c": "c", "cpp": "cpp",
        "h": "c", "hpp": "cpp", "m": "objectivec", "mm": "objectivec",
        "cs": "csharp", "css": "css", "scss": "scss", "less": "less",
        "html": "xml", "xml": "xml", "svg": "xml", "plist": "xml",
        "yaml": "yaml", "yml": "yaml", "toml": "ini",
        "sh": "bash", "bash": "bash", "zsh": "bash",
        "sql": "sql", "graphql": "graphql",
        "md": "markdown", "mdx": "markdown",
        "dockerfile": "dockerfile", "makefile": "makefile",
        "r": "r", "lua": "lua", "php": "php", "perl": "perl",
        "ex": "elixir", "exs": "elixir", "erl": "erlang",
        "hs": "haskell", "ml": "ocaml", "clj": "clojure",
        "vim": "vim", "tf": "hcl"
    ]

    /// Detect language from file path extension
    static func detectLanguage(_ filePath: String) -> String? {
        let ext = (filePath as NSString).pathExtension.lowercased()
        if ext.isEmpty {
            // Check filename-based languages
            let name = (filePath as NSString).lastPathComponent.lowercased()
            switch name {
            case "dockerfile": return "dockerfile"
            case "makefile", "gnumakefile": return "makefile"
            case "gemfile", "rakefile": return "ruby"
            case "podfile": return "ruby"
            default: return nil
            }
        }
        return extensionToLanguage[ext]
    }

    /// Highlight all lines in the given files. Call after DiffParser.parse().
    /// Checks Task.isCancelled between lines so a superseded pass exits early
    /// instead of queuing thousands of XPC-heavy HTML imports.
    func highlightFiles(_ files: [DiffFile], isDarkMode: Bool = true) async {
        cache.removeAll()

        let colors: HighlightColors = isDarkMode ? .dark(.xcode) : .light(.xcode)
        var newImports = 0

        for file in files {
            let filePath = file.displayPath
            guard let language = Self.detectLanguage(filePath) else { continue }

            for hunk in file.hunks {
                for line in hunk.lines {
                    // Bail early if a newer highlight pass has been kicked off
                    guard !Task.isCancelled else { return }

                    guard !line.content.isEmpty else { continue }

                    let key = ContentKey(content: line.content, language: language, isDark: isDarkMode)

                    // Serve from the content cache — no HTML import needed
                    if var entry = contentCache[key] {
                        cache[line.id] = entry.value
                        accessCounter += 1
                        entry.lastAccess = accessCounter
                        contentCache[key] = entry
                        continue
                    }

                    // Cap new HTML imports to bound Mach port creation per pass.
                    // Unhighlighted lines render as plain text; the next poll pass
                    // will pick them up from cache or continue where we left off.
                    guard newImports < Self.maxNewImportsPerPass else { continue }

                    do {
                        let highlighted = try await highlight.attributedText(
                            line.content,
                            language: language,
                            colors: colors
                        )
                        newImports += 1
                        // HighlightSwift trims the line and its HTML conversion can
                        // collapse whitespace, dropping indentation. Restore the
                        // original characters; skip caching on mismatch so the view
                        // falls back to plain text (word-diff ranges depend on
                        // exact characters).
                        if let restored = WhitespaceRestorer.restore(original: line.content, highlighted: highlighted) {
                            cache[line.id] = restored
                            accessCounter += 1
                            contentCache[key] = ContentEntry(value: restored, lastAccess: accessCounter)
                        }
                    } catch {
                        // Silently skip — fall back to plain text
                    }
                }
            }
        }

        // Evict least-recently-used entries when the content cache grows too large
        if contentCache.count > Self.maxContentCacheSize {
            let sorted = contentCache.sorted { $0.value.lastAccess < $1.value.lastAccess }
            let excess = contentCache.count - Self.maxContentCacheSize
            for (key, _) in sorted.prefix(excess) {
                contentCache.removeValue(forKey: key)
            }
        }
    }

    /// Get pre-highlighted content for a line. Returns nil if not highlighted.
    func highlighted(lineId: Int) -> AttributedString? {
        cache[lineId]
    }

    /// Bulk retrieve highlights for view consumption (avoids per-line actor hops)
    func allHighlights() -> [Int: AttributedString] {
        cache
    }

    func clearCache() {
        cache.removeAll()
    }
}
