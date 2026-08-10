import Foundation

/// A Identity: a named agent identity with its own blocks, traits, and defaults.
///
/// Identities come from one of two places. A file-based Identity is a directory under
/// `~/.identity/identities/` whose `identity.yaml` is the source of truth; a DB-backed
/// one is a row in the profiles table. The API merges both into one list and
/// labels each with `source`.
struct Identity: Codable, Identifiable {
    let id: Int
    let name: String
    /// Human-readable label. `name` stays the identifier commands address, so
    /// the UI shows this and falls back to `name` when it is absent.
    let displayName: String?
    let token: String
    let blocks: [String]
    let traits: [String]
    let scopeId: Int?
    let defaultCodingAgent: String?
    let defaultModel: String?
    let envKeys: [String]
    let vaultEmail: String?
    let isDefault: Bool
    let lastUsedAt: String?
    let createdAt: String?
    /// "file" or "db". Absent on older API builds, which were DB-only.
    let source: String?

    /// Whether this Identity is configured by a `identity.yaml` on disk.
    ///
    /// Drives the read-only affordances: file-based Identities can't hold a scope
    /// and their token is a synthetic placeholder rather than a real one.
    var isFileBased: Bool { source == "file" }

    /// What to show the user. Most Identities have no display name, so this falls
    /// back to the identifier rather than leaving a row blank.
    var label: String {
        guard let displayName, !displayName.isEmpty else { return name }
        return displayName
    }

    var displayLastUsed: String {
        guard let raw = lastUsedAt else { return "never used" }
        return formatRelativeTime(raw) ?? raw
    }
}
