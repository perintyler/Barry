import Foundation

struct SearchResult: Codable, Identifiable {
    let sessionId: String
    let sequence: Int
    let role: String
    let contentSnippet: String
    let createdAt: String
    let sessionName: String
    let sessionRepoPath: String?
    let similarityScore: Double

    var id: String { "\(sessionId)-\(sequence)" }

    var displayPath: String {
        guard let path = sessionRepoPath else { return "" }
        return path.replacingOccurrences(
            of: FileManager.default.homeDirectoryForCurrentUser.path,
            with: "~"
        )
    }

    var displayName: String {
        sessionName.isEmpty ? String(sessionId.prefix(8)) : sessionName
    }
}

struct SearchResponse: Codable {
    let results: [SearchResult]
}
