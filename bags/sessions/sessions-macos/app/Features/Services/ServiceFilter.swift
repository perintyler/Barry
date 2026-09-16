import Foundation

/// Whether a service matches a typed query.
///
/// Matching is deliberately conservative. An unrestricted subsequence test —
/// "every query character appears somewhere in order" — reads well in the
/// abstract but is far too loose on this fleet: "coff" matches "bdiff.review"
/// and "mcp" matches seven unrelated agents, because short queries over long
/// dotted labels almost always find scattered characters. A filter that
/// returns noise is worse than no filter, so the rule is:
///
///   1. substring of the name, the owning bag, or the raw label; or
///   2. an initials match on a camel/hyphen-separated name ("bs" → BarrySessions).
///
/// Both are anchored to real word boundaries, so a hit is always explicable.
public func serviceMatches(query: String, name: String, owner: String?, label: String) -> Bool {
    let q = normalizeForSearch(query)
    guard !q.isEmpty else { return true }

    let haystacks = [name, owner ?? "", label]
    for h in haystacks where normalizeForSearch(h).contains(q) {
        return true
    }

    // "bag" is present in nearly every label and would match everything, so an
    // initials fallback is only useful on the distinguishing name.
    return initials(of: name).hasPrefix(q) && q.count >= 2
}

/// Case- and separator-insensitive: dots and dashes in labels should never
/// have to be typed to get a hit.
private func normalizeForSearch(_ s: String) -> String {
    s.lowercased().filter { $0.isLetter || $0.isNumber }
}

/// The leading letters of each word in a name, where words are split on
/// case changes and separators: "BarrySessions" → "bs", "disk-retention" → "dr".
private func initials(of s: String) -> String {
    var result = ""
    var previous: Character?
    for ch in s {
        if ch.isLetter || ch.isNumber {
            let isBoundary = previous == nil
                || !(previous!.isLetter || previous!.isNumber)
                || (ch.isUppercase && previous!.isLowercase)
            if isBoundary { result.append(Character(ch.lowercased())) }
        }
        previous = ch
    }
    return result
}
