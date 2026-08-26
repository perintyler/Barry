import Foundation

/// An identity: a named agent persona with its own bags, traits, and defaults.
///
/// Identities come from one of two places. A file-based identity is a
/// directory — discovered under `~/.barry/identities/` or registered in
/// `~/.barry/identities.yaml`, since `barry heir` can create one anywhere —
/// whose `identity.yaml` is the source of truth. A DB-backed one is a row in
/// the `identities` table. The API merges both into one list and labels each
/// with `source`, with the directory shadowing a row of the same name.
public struct Identity: Codable, Identifiable {
    public let id: Int
    public let name: String
    /// Human-readable label. `name` stays the identifier commands address, so
    /// the UI shows this and falls back to `name` when it is absent.
    public let displayName: String?
    public let token: String
    public let bags: [String]
    public let traits: [String]
    public let scopeId: Int?
    public let defaultCodingAgent: String?
    public let defaultModel: String?
    public let envKeys: [String]
    /// Per key, where its value resolves from — "file", "keychain" or "vault".
    /// Never the values: a file-based Barry keeps literal secrets in its
    /// `.env`, so the API deliberately reports only the provenance.
    public let envSources: [String: String]?
    public let vaultEmail: String?
    public let statusNotify: StatusNotify?
    public let githubInstallationId: Int?
    public let allowNativeTools: Bool?
    public let isDefault: Bool
    public let lastUsedAt: String?
    public let createdAt: String?
    /// "file" or "db". Absent on older API builds, which were DB-only.
    public let source: String?

    public struct StatusNotify: Codable, Equatable {
        public let tool: String
        public let target: String?
    }

    /// Where an env key's value lives, for display next to the key.
    ///
    /// `value` and `file` both mean the secret is sitting in plaintext — in
    /// the identity's metadata or its `.env` — rather than behind the keychain
    /// or the vault. Labelling them "inline" and "on disk" says that plainly;
    /// "VALUE" reads like a category rather than a warning.
    public func envSource(for key: String) -> String {
        switch envSources?[key] {
        case "keychain": return "keychain"
        case "vault": return "vault"
        case "value": return "inline"
        case "file": return "on disk"
        case let other?: return other
        case nil: return "unknown"
        }
    }

    /// Whether this key's value is stored literally rather than as a
    /// reference into the keychain or the vault.
    ///
    /// Deliberately *not* rendered as a warning. Inline values are how
    /// non-secret configuration is meant to be held — bux keeps `SENTRY_ORG`
    /// and `TEMPORAL_HOST` inline while `SENTRY_AUTH_TOKEN` and
    /// `TEMPORAL_API_KEY` sit in the keychain, which is exactly right. Colouring
    /// the inline ones amber implied a leak where there is only config, and
    /// trained the eye to ignore the badge that would matter.
    public func envIsLiteral(for key: String) -> Bool {
        let source = envSources?[key]
        return source == "value" || source == "file"
    }

    /// Whether this Identity is configured by a `identity.yaml` on disk.
    ///
    /// Drives the read-only affordances: file-based Identities can't hold a scope
    /// and their token is a synthetic placeholder rather than a real one.
    public var isFileBased: Bool { source == "file" }

    /// What to show the user. Most Identities have no display name, so this falls
    /// back to the identifier rather than leaving a row blank.
    public var label: String {
        guard let displayName, !displayName.isEmpty else { return name }
        return displayName
    }

    public var displayLastUsed: String {
        guard let raw = lastUsedAt else { return "never used" }
        return formatRelativeTime(raw) ?? raw
    }
}
