import Highlighter
import MarkdownUI
import SwiftUI

struct HighlightrCodeSyntaxHighlighter: CodeSyntaxHighlighter {
    private let highlightr: Highlighter
    private let theme: String

    init(theme: String = "onedark") {
        self.theme = theme
        let h = Highlighter()!
        h.setTheme(theme)
        h.theme.codeFont = .monospacedSystemFont(ofSize: 12, weight: .regular)
        self.highlightr = h
    }

    func highlightCode(_ content: String, language: String?) -> Text {
        guard let nsAttr = highlightr.highlight(content, as: language) else {
            return Text(content)
        }
        let attributed = AttributedString(nsAttr)
        return Text(attributed)
    }
}

extension CodeSyntaxHighlighter where Self == HighlightrCodeSyntaxHighlighter {
    static func highlightr(theme: String = "onedark") -> Self {
        HighlightrCodeSyntaxHighlighter(theme: theme)
    }
}
