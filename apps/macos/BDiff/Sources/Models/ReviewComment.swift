import Foundation
import BDiffCore

/// A reply on a review comment, from either the reviewer ("user") or an agent.
struct ReviewReply: Codable, Identifiable, Equatable {
    let id: String
    let commentId: String
    let author: String
    let body: String
    let createdAt: String
}

/// A code-review comment persisted by the bdiff review service.
struct ReviewComment: Codable, Identifiable, Equatable {
    let id: String
    let repoPath: String
    let repoName: String
    let diffMode: String
    let branch: String?
    let commitHash: String?
    let filePath: String
    let side: String
    let line: Int
    /// Range start (inclusive); nil = single line. `line` is the anchor/end.
    let lineStart: Int?
    let lineContent: String
    let body: String
    let status: String
    let sessionId: String?
    let resolutionNote: String?
    let resolvedBy: String?
    let resolvedAt: String?
    let createdAt: String
    let updatedAt: String
    let replies: [ReviewReply]

    var isResolved: Bool { status == "resolved" }

    var rangeLabel: String? { lineStart.map { "Lines \($0)–\(line)" } }

    /// Copy with an extra reply appended (fields are immutable).
    func appending(reply: ReviewReply) -> ReviewComment {
        ReviewComment(
            id: id, repoPath: repoPath, repoName: repoName, diffMode: diffMode,
            branch: branch, commitHash: commitHash, filePath: filePath, side: side,
            line: line, lineStart: lineStart, lineContent: lineContent, body: body,
            status: status, sessionId: sessionId, resolutionNote: resolutionNote,
            resolvedBy: resolvedBy, resolvedAt: resolvedAt,
            createdAt: createdAt, updatedAt: updatedAt, replies: replies + [reply]
        )
    }
}

/// Where a comment attaches in a diff. Anchored by file + side + line number —
/// never DiffLine.id, which is a parse-order value regenerated on every load.
/// `repoPath` disambiguates identical paths across repos in session scope;
/// it stays nil in branch/commit scope so existing flows are unchanged.
struct CommentAnchor: Hashable {
    let filePath: String
    let side: String
    let line: Int
    var repoPath: String?
}

extension CommentAnchor {
    /// Deletions anchor to the old side; additions and context to the new side.
    init?(filePath: String, repoPath: String? = nil, diffLine: DiffLine) {
        if diffLine.type == .deletion {
            guard let number = diffLine.oldLineNumber else { return nil }
            self.init(filePath: filePath, side: "old", line: number, repoPath: repoPath)
        } else {
            guard let number = diffLine.newLineNumber else { return nil }
            self.init(filePath: filePath, side: "new", line: number, repoPath: repoPath)
        }
    }

    /// Session comments carry the repo dimension; others don't.
    init(comment: ReviewComment) {
        self.init(
            filePath: comment.filePath,
            side: comment.side,
            line: comment.line,
            repoPath: comment.sessionId != nil ? comment.repoPath : nil
        )
    }
}
