import Highlighter
import MarkdownUI
import SwiftUI
import AppKit

/// Bridges HighlighterSwift (highlight.js via JavaScriptCore) into MarkdownUI.
///
/// Two things worth knowing:
///
/// 1. The highlighter bakes a font into the `NSAttributedString` it returns,
///    which **overrides** whatever `FontFamily`/`FontSize` the MarkdownUI theme
///    set on the code block. So the font configured here is the one that
///    actually renders — it must match the theme, not the system default.
/// 2. Highlighting runs JavaScript through JavaScriptCore and is genuinely
///    expensive. Results are memoized by (code, language); SwiftUI re-evaluates
///    view bodies frequently and would otherwise re-highlight every block on
///    every pass.
struct HighlightrCodeSyntaxHighlighter: CodeSyntaxHighlighter {
    private let highlightr: Highlighter
    private let theme: String
    private let cache: HighlightCache

    /// Point size the highlighter stamps into its output. Matches the theme's
    /// relative code size (`body × codeEm`) so highlighted and unhighlighted
    /// blocks are optically identical.
    private static var codeFontSize: CGFloat {
        MarkdownTokens.Size.body * MarkdownTokens.Size.codeEm
    }

    private static func codeFont() -> NSFont {
        NSFont(name: MarkdownTokens.Family.mono, size: codeFontSize)
            ?? .monospacedSystemFont(ofSize: codeFontSize, weight: .regular)
    }

    init(theme: String = "onedark") {
        self.theme = theme
        let h = Highlighter()!
        h.setTheme(theme)
        h.theme.codeFont = Self.codeFont()
        self.highlightr = h
        self.cache = HighlightCache()
    }

    func highlightCode(_ content: String, language: String?) -> Text {
        let key = HighlightCache.Key(content: content, language: language, theme: theme)
        if let cached = cache.value(for: key) {
            return Text(cached)
        }
        guard let nsAttr = highlightr.highlight(content, as: language) else {
            return Text(content)
        }
        let attributed = AttributedString(nsAttr)
        cache.store(attributed, for: key)
        return Text(attributed)
    }
}

/// Small bounded LRU-ish cache. Highlighting is pure for a given
/// (code, language, theme), so results are safe to reuse indefinitely; the
/// bound just stops a very long transcript from growing without limit.
private final class HighlightCache: @unchecked Sendable {
    struct Key: Hashable {
        let content: String
        let language: String?
        let theme: String
    }

    private let limit = 256
    private var storage: [Key: AttributedString] = [:]
    private var order: [Key] = []
    private let lock = NSLock()

    func value(for key: Key) -> AttributedString? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    func store(_ value: AttributedString, for key: Key) {
        lock.lock()
        defer { lock.unlock() }
        if storage[key] == nil {
            order.append(key)
            if order.count > limit {
                let evicted = order.removeFirst()
                storage.removeValue(forKey: evicted)
            }
        }
        storage[key] = value
    }
}

extension CodeSyntaxHighlighter where Self == HighlightrCodeSyntaxHighlighter {
    static func highlightr(theme: String = "onedark") -> Self {
        HighlightrCodeSyntaxHighlighter(theme: theme)
    }
}
