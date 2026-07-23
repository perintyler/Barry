import Foundation

/// A session row in the picker: barry session id, display name, lifecycle
/// status, and the repos its changes touch (cross-repo sessions list several).
public struct SessionSummary: Identifiable, Codable, Equatable {
    public let id: String
    public let name: String
    public let status: String
    public let startedAt: String?
    public let endedAt: String?
    public let repos: [String]
    public let hasChanges: Bool?

    public init(id: String, name: String, status: String, startedAt: String?, endedAt: String?, repos: [String], hasChanges: Bool? = nil) {
        self.id = id
        self.name = name
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.repos = repos
        self.hasChanges = hasChanges
    }

    public var isLive: Bool { status == "running" }

    public var endedDate: Date? {
        endedAt.flatMap { ISO8601DateFormatter().date(from: $0) }
    }

    /// Short relative label for ended sessions ("2h", "3d").
    public var endedAgo: String? {
        guard !isLive, let date = endedDate else { return nil }
        let seconds = Date().timeIntervalSince(date)
        if seconds < 3600 { return "\(max(1, Int(seconds / 60)))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
    }
}

public struct SessionPickerResponse: Codable {
    public let sessions: [SessionSummary]?
}

/// Ordering + filtering rules for the picker's Sessions tab.
public enum SessionVisibility {
    /// Live sessions first (most recently started first), then ended by recency.
    /// Excludes ended sessions with no file changes (nothing to diff).
    public static func sort(_ sessions: [SessionSummary]) -> [SessionSummary] {
        sessions
            .filter { $0.isLive || $0.hasChanges != false }
            .sorted { a, b in
                if a.isLive != b.isLive { return a.isLive }
                if a.isLive {
                    return (a.startedAt ?? "") > (b.startedAt ?? "")
                }
                return (a.endedAt ?? "") > (b.endedAt ?? "")
            }
    }

    /// Case-insensitive match on session name or any repo name.
    public static func matches(_ session: SessionSummary, filter: String) -> Bool {
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return true }
        if session.name.lowercased().contains(needle) { return true }
        return session.repos.contains { $0.lowercased().contains(needle) }
    }
}
