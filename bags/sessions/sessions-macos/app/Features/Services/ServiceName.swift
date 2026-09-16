import Foundation

/// A launchd label split into the parts a person actually scans by.
///
/// Barry labels encode ownership in a prefix that is identical across most
/// rows (`com.barry.bag.`), so reading a list of them means skipping the same
/// characters on every line before reaching the distinguishing word. This
/// splits the label into the distinguishing part (`name`) and the owner
/// (`owner`), so the UI can lead with the former and dim the latter.
public struct ServiceName: Equatable, Sendable {
    /// The distinguishing part — what the row leads with. e.g. "review".
    public let name: String
    /// The owning bag, or nil for first-party agents and for apps whose bag
    /// name merely restates the app name.
    public let owner: String?

    public init(name: String, owner: String?) {
        self.name = name
        self.owner = owner
    }
}

/// Bag-owned labels come in three shapes, and the order they are tested in
/// matters: `bag.job.<bag>.<job>` and `bag.<bag>.<item>` share the `bag.`
/// prefix, so testing the service form first would parse every job's bag name
/// as the literal "job".
private let bagJobPrefix = "bag.job."
private let bagPrefix = "bag."

/// Split a launchd label (with or without the `com.barry.` prefix) into a
/// display name and its owning bag.
public func parseServiceName(_ label: String) -> ServiceName {
    let parsed = parseSegments(label)
    // A row with an empty name is invisible and unclickable, so a truncated or
    // malformed label falls back to the raw label rather than to nothing.
    guard parsed.name.isEmpty else { return parsed }
    let fallback = label.hasPrefix("com.barry.")
        ? String(label.dropFirst("com.barry.".count))
        : label
    return ServiceName(name: fallback.isEmpty ? label : fallback, owner: parsed.owner)
}

private func parseSegments(_ label: String) -> ServiceName {
    var rest = label
    if rest.hasPrefix("com.barry.") {
        rest = String(rest.dropFirst("com.barry.".count))
    }

    // `bag.job.<bag>.<job>` — a recurring job contributed by a bag.
    if rest.hasPrefix(bagJobPrefix) {
        let tail = String(rest.dropFirst(bagJobPrefix.count))
        if let (bag, item) = splitFirstSegment(tail) {
            return ServiceName(name: item, owner: bag)
        }
        return ServiceName(name: tail, owner: nil)
    }

    if rest.hasPrefix(bagPrefix) {
        let tail = String(rest.dropFirst(bagPrefix.count))

        // `bag.<bag>.app.<AppName>` — a menu-bar app. The app name is already
        // a proper noun ("BarrySessions"), and its bag is usually the same
        // word in another form ("sessions-macos"), so repeating it as an owner
        // is pure noise. Only keep the owner when it adds information.
        if let (bag, afterBag) = splitFirstSegment(tail),
           afterBag.hasPrefix("app.") {
            let appName = String(afterBag.dropFirst("app.".count))
            return ServiceName(
                name: appName,
                owner: ownerRestatesName(bag: bag, name: appName) ? nil : bag
            )
        }

        // `bag.<bag>.<service>` — an ordinary bag service.
        if let (bag, item) = splitFirstSegment(tail) {
            return ServiceName(name: item, owner: bag)
        }
        return ServiceName(name: tail, owner: nil)
    }

    // `mcp.barry` — read as "barry" inside the MCP section rather than
    // repeating the section name in every row.
    if rest.hasPrefix("mcp.") {
        return ServiceName(name: String(rest.dropFirst("mcp.".count)), owner: "mcp")
    }

    // `job.<name>` — a first-party recurring job.
    if rest.hasPrefix("job.") {
        return ServiceName(name: String(rest.dropFirst("job.".count)), owner: nil)
    }

    // First-party services: `api`, `web`, `caddy`, `cloudflared`.
    return ServiceName(name: rest, owner: nil)
}

/// Split "a.b.c" into ("a", "b.c"). Returns nil when there is no separator,
/// so callers can fall back to treating the whole string as the name.
private func splitFirstSegment(_ s: String) -> (String, String)? {
    guard let dot = s.firstIndex(of: ".") else { return nil }
    let head = String(s[s.startIndex..<dot])
    let tail = String(s[s.index(after: dot)...])
    guard !head.isEmpty, !tail.isEmpty else { return nil }
    return (head, tail)
}

/// Whether a bag name merely restates the app name and so carries no
/// information for a reader. Compares on letters only, lowercased, and
/// tolerates the "Barry" prefix apps carry but bags do not
/// ("sessions-macos" vs "BarrySessions").
private func ownerRestatesName(bag: String, name: String) -> Bool {
    let b = normalizeForCompare(bag)
    var n = normalizeForCompare(name)
    if n.hasPrefix("barry"), n.count > "barry".count {
        n = String(n.dropFirst("barry".count))
    }
    guard !b.isEmpty, !n.isEmpty else { return false }
    return b.hasPrefix(n) || n.hasPrefix(b)
}

private func normalizeForCompare(_ s: String) -> String {
    s.lowercased().filter { $0.isLetter }
}
