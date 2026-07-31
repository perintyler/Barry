import Foundation
import BDiffCore
import BarryKit

/// Diff-specific API client. Config reading, auth, and HTTP primitives
/// live in BarryKit's `BarryCore`; this actor adds the endpoints BDiff needs.
actor BarryClient {
    private let core = BarryCore()

    // MARK: - Health

    func checkHealth() async -> Bool {
        await core.checkHealth()
    }

    // MARK: - Branches

    /// Everything the user might be working on: checkouts, worktrees, and
    /// recent refs per repo, joined against live sessions.
    func fetchRepoBranches() async throws -> RepoBranchesResponse {
        try decode(try await core.transport.listRepoBranches())
    }

    // MARK: - Diffs (repo-keyed)

    /// - Parameters:
    ///   - path: working directory (main checkout or worktree)
    ///   - branch: set for plain refs not checked out at `path`
    func fetchDiff(path: String, mode: String, branch: String? = nil) async throws -> DiffResponse {
        try decode(try await core.transport.repoDiff(path: path, mode: mode, branch: branch))
    }

    func fetchCommitDiff(path: String, commitHash: String) async throws -> DiffResponse {
        try decode(try await core.transport.repoDiff(path: path, mode: "commit", commit: commitHash))
    }

    // MARK: - Git Log

    func fetchGitLog(path: String, branch: String? = nil, limit: Int = 50) async throws -> GitLogResponse {
        try decode(try await core.transport.repoGitLog(path: path, branch: branch, limit: limit))
    }

    // MARK: - Sessions (session view)

    func fetchSessionPicker() async throws -> SessionPickerResponse {
        try await core.get("sessions/picker")
    }

    func fetchSessionView(sessionId: String) async throws -> SessionViewResponse {
        try await core.get("sessions/\(sessionId)/session-view")
    }

    // MARK: - File Contents (for Monaco DiffEditor)

    func fetchFileContents(
        path: String,
        file: String,
        mode: String,
        branch: String? = nil,
        commit: String? = nil
    ) async throws -> FileContentsResponse {
        var query = [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "file", value: file),
            URLQueryItem(name: "mode", value: mode),
        ]
        if let branch { query.append(URLQueryItem(name: "branch", value: branch)) }
        if let commit { query.append(URLQueryItem(name: "commit", value: commit)) }
        return try await core.get("repos/file-contents", query: query)
    }

    private func decode<T: Decodable, U: Encodable>(_ value: U) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }
}

// MARK: - Response Types

struct DiffResponse: Codable {
    let repoPath: String?
    let mode: String?
    let baseBranch: String?
    let currentBranch: String?
    let commit: String?
    let diff: String?
}

struct GitLogResponse: Codable {
    let baseBranch: String?
    let currentBranch: String?
    let commits: [GitCommit]?
}

struct FileContentsResponse: Codable {
    let ok: Bool?
    let filePath: String?
    let original: String?
    let modified: String?
    let language: String?
}

struct SessionViewRepo: Codable {
    let repoPath: String
    let repoName: String
    let diff: String?
    let baseBranch: String?
}

struct SessionViewResponse: Codable {
    let sessionId: String?
    let name: String?
    let status: String?
    let scope: String?
    let repos: [SessionViewRepo]?
}
