import Foundation

public enum FileStatus: String {
    case added, deleted, modified, renamed
}

public enum LineType {
    case context, addition, deletion
}

public struct DiffFile: Identifiable {
    public let id: String
    public let oldPath: String
    public let newPath: String
    public let status: FileStatus
    public let hunks: [DiffHunk]
    /// Set in session scope, where one diff can span multiple repos.
    public let repoPath: String?
    public let repoName: String?

    public init(
        id: String, oldPath: String, newPath: String, status: FileStatus, hunks: [DiffHunk],
        repoPath: String? = nil, repoName: String? = nil
    ) {
        self.id = id
        self.oldPath = oldPath
        self.newPath = newPath
        self.status = status
        self.hunks = hunks
        self.repoPath = repoPath
        self.repoName = repoName
    }

    public var insertions: Int { hunks.flatMap(\.lines).filter { $0.type == .addition }.count }
    public var deletions: Int { hunks.flatMap(\.lines).filter { $0.type == .deletion }.count }

    /// The path to show users — deleted files have newPath "/dev/null",
    /// so fall back to the old path.
    public var displayPath: String {
        newPath.isEmpty || newPath == "/dev/null" ? oldPath : newPath
    }

    public var directory: String {
        let parts = displayPath.split(separator: "/")
        return parts.count > 1 ? parts.dropLast().joined(separator: "/") : ""
    }

    public var filename: String {
        String(displayPath.split(separator: "/").last ?? Substring(displayPath))
    }
}

public struct DiffHunk: Identifiable {
    public let id: Int
    public let header: String
    public let contextHeader: String?
    public let oldStart: Int
    public let oldCount: Int
    public let newStart: Int
    public let newCount: Int
    public let lines: [DiffLine]
}

public struct DiffLine: Identifiable {
    public let id: Int
    public let type: LineType
    public let content: String
    public let oldLineNumber: Int?
    public let newLineNumber: Int?
    public let wordChanges: [WordChange]?
}

public struct WordChange {
    public let range: Range<String.Index>
    public let type: LineType
}

public struct GitCommit: Identifiable, Codable {
    public let hash: String
    public let shortHash: String
    public let subject: String
    public let author: String
    public let date: String
    public let filesChanged: Int?
    public let insertions: Int?
    public let deletions: Int?

    public var id: String { hash }
}
