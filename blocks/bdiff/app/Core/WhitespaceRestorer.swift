import Foundation

/// Restores whitespace lost during syntax highlighting.
///
/// HighlightSwift trims the input and converts highlight.js HTML output via the
/// NSAttributedString HTML importer, both of which can drop or collapse
/// whitespace — losing code indentation. This walks the original line and the
/// highlighted string together: non-whitespace segments must match (keeping
/// their syntax attributes) and whitespace runs are re-emitted verbatim from
/// the original.
///
/// Exact character fidelity matters beyond looks: word-diff highlight ranges
/// are computed against the original line, so any character drift misplaces them.
public enum WhitespaceRestorer {
    /// Returns `highlighted` rebuilt with the exact character content of
    /// `original`, or nil if the non-whitespace characters don't line up
    /// (callers should fall back to plain text).
    public static func restore(original: String, highlighted: AttributedString) -> AttributedString? {
        if String(highlighted.characters) == original { return highlighted }

        var result = AttributedString()
        let hChars = highlighted.characters
        var hIdx = highlighted.startIndex
        var i = original.startIndex

        while i < original.endIndex {
            if original[i].isWhitespace {
                let runStart = i
                while i < original.endIndex, original[i].isWhitespace {
                    i = original.index(after: i)
                }
                // The highlighter collapsed this run to zero or more whitespace
                // characters (possibly different ones, e.g. tab → space); skip them.
                while hIdx < highlighted.endIndex, hChars[hIdx].isWhitespace {
                    hIdx = highlighted.index(afterCharacter: hIdx)
                }
                result += AttributedString(String(original[runStart..<i]))
            } else {
                var hSegEnd = hIdx
                while i < original.endIndex, !original[i].isWhitespace {
                    guard hSegEnd < highlighted.endIndex, hChars[hSegEnd] == original[i] else {
                        return nil
                    }
                    hSegEnd = highlighted.index(afterCharacter: hSegEnd)
                    i = original.index(after: i)
                }
                result += AttributedString(highlighted[hIdx..<hSegEnd])
                hIdx = hSegEnd
            }
        }

        // Anything left in the highlighted string besides whitespace means the
        // texts diverged in a way we can't reconcile.
        while hIdx < highlighted.endIndex, hChars[hIdx].isWhitespace {
            hIdx = highlighted.index(afterCharacter: hIdx)
        }
        guard hIdx == highlighted.endIndex else { return nil }

        return result
    }
}
