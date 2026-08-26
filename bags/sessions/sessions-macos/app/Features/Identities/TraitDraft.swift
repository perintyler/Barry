import Foundation

/// The rules a new trait has to satisfy, separated from the form that collects
/// it so they can be tested without presenting a sheet.
///
/// These mirror the server's checks deliberately. The API is the authority —
/// it re-validates everything — but repeating the rules here turns a failed
/// round trip into a disabled button and an explanation, which is the
/// difference between "why didn't that work" and knowing before you press it.
public struct TraitDraft: Equatable {
    public var name: String = ""
    public var description: String = ""
    public var access: String = "read"
    public var namespaces: Set<String> = []
    public var scopeNames: Set<String> = []

    public init() {}

    /// Lowercase letters, digits and hyphens, starting with a letter or digit.
    ///
    /// The name is an identifier sessions address by, and it has to survive a
    /// round trip through yaml and argv — so the punctuation people reach for
    /// first (spaces, underscores, capitals) is exactly what breaks it.
    public static func isValidName(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil
    }

    public var nameIsValid: Bool { Self.isValidName(name) }

    /// Whether the draft can be submitted.
    ///
    /// Namespaces are required because a trait without them resolves to no
    /// tools: it would appear in every picker and do nothing when chosen,
    /// which reads as the trait system being broken rather than the trait
    /// being empty.
    public var isComplete: Bool {
        nameIsValid && !namespaces.isEmpty
    }

    /// Why the draft can't be submitted yet, or nil when it can.
    public var blockingReason: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Name is required." }
        if !nameIsValid { return "Lowercase letters, digits and hyphens only." }
        if namespaces.isEmpty { return "Pick at least one — a trait with no namespaces grants no tools." }
        return nil
    }
}
