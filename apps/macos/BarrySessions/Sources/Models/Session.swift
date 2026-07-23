import Foundation

struct Session: Codable, Identifiable {
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
    // Resolved at session start; settable pre-start (applies on next start/resume)
    let provider: String?
    let model: String?
    let profileId: Int?
    let profileSource: String?

    var hasMessages: Bool { (messageCount ?? 0) > 0 }

    var isRunning: Bool { status == "running" }
    var isPending: Bool { status == "pending" }
    var isActive: Bool { isRunning || isPending }

    var displayPath: String {
        guard let path = repoPath else { return "" }
        return path.replacingOccurrences(
            of: FileManager.default.homeDirectoryForCurrentUser.path,
            with: "~"
        )
    }

    var isReadOnly: Bool {
        scope?.deniedAccess?.contains("write") == true
    }
}

struct SessionScope: Codable {
    let deniedAccess: [String]?
}

struct RecentSessionsResponse: Codable {
    let sessions: [Session]
    let nextCursor: String?
}
