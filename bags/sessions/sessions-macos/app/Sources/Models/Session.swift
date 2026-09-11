import Foundation

/// `Equatable` is load-bearing, not decoration: the bus refetches the whole
/// list on every session write from any process, and without it SwiftUI cannot
/// tell an identical payload from a changed one, so every row re-renders on
/// every frame. `SessionScope` and `StatusUpdate` conform for the same reason —
/// synthesis needs it all the way down.
struct Session: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let status: String
    let traits: [String]
    let repoPath: String?
    let createdAt: String?
    let startedAt: String?

    // Extended fields
    let source: String?
    let pinned: Bool?
    let scope: SessionScope?
    let linearTicket: String?
    let githubPr: Int?
    let messageCount: Int?
    let lastMessageAt: String?
    // Derived from the session's latest `progress` event (recorded via the
    // record_event tool). The field name is contract-stable.
    let statusUpdate: StatusUpdate?
    // Resolved at session start; settable pre-start (applies on next start/resume)
    let provider: String?
    let model: String?
    let identityId: Int?
    let identitySource: String?

    var hasMessages: Bool { (messageCount ?? 0) > 0 }

    var isRunning: Bool { status == "running" }
    var isPending: Bool { status == "pending" }
    var isActive: Bool { isRunning || isPending }

    /// The home directory cannot change while the app runs, but this is read
    /// once per row per frame — so resolve it once rather than asking
    /// `FileManager` on every list pass.
    static let homeDirectoryPath = FileManager.default.homeDirectoryForCurrentUser.path

    var displayPath: String {
        guard let path = repoPath else { return "" }
        return path.replacingOccurrences(of: Self.homeDirectoryPath, with: "~")
    }

    var isReadOnly: Bool {
        scope?.deniedAccess?.contains("write") == true
    }
}

struct SessionScope: Codable, Equatable {
    let deniedAccess: [String]?
}

struct StatusUpdate: Codable, Equatable {
    let summary: String?
    let phase: String?
    let updatedAt: String?
}

struct RecentSessionsResponse: Codable {
    let sessions: [Session]
    let nextCursor: String?
}
