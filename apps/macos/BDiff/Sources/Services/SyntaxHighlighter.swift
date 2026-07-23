import Foundation
import HighlightSwift
import BDiffCore

/// Pre-highlights diff line content using HighlightSwift.
/// Caches results by line ID so views can read synchronously.
actor SyntaxHighlighter {
    private let highlight = Highlight()
    private var cache: [Int: AttributedString] = [:]

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
        "vim": "vim", "tf": "hcl",
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
    func highlightFiles(_ files: [DiffFile], isDarkMode: Bool = true) async {
        cache.removeAll()

        let colors: HighlightColors = isDarkMode ? .dark(.xcode) : .light(.xcode)

        for file in files {
            let filePath = file.displayPath
            guard let language = Self.detectLanguage(filePath) else { continue }

            for hunk in file.hunks {
                for line in hunk.lines {
                    guard !line.content.isEmpty else { continue }

                    do {
                        let highlighted = try await highlight.attributedText(
                            line.content,
                            language: language,
                            colors: colors
                        )
                        // HighlightSwift trims the line and its HTML conversion can
                        // collapse whitespace, dropping indentation. Restore the
                        // original characters; skip caching on mismatch so the view
                        // falls back to plain text (word-diff ranges depend on
                        // exact characters).
                        if let restored = WhitespaceRestorer.restore(original: line.content, highlighted: highlighted) {
                            cache[line.id] = restored
                        }
                    } catch {
                        // Silently skip — fall back to plain text
                    }
                }
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
