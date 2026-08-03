import Foundation

/// Client for the bdiff review-comments service (`servers/bdiff`).
///
/// This is a separate localhost service with its own port — it does not go
/// through BarryKit's `BarryCore`, which is hardwired to the main API's
/// `com.barry.api` launchd config. Port discovery mirrors that pattern for
/// `com.barry.bdiff-review` (com.barry.bdiff is the BDiff app itself),
/// falling back to the dev port when no plist exists.
actor ReviewClient {
    private let baseURL: URL
    private let session: URLSession

    init() {
        let port = Self.readPort()
        self.baseURL = URL(string: "http://127.0.0.1:\(port)")!
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        self.session = URLSession(configuration: config)
    }

    private static let devPort = 3862

    private static func readPort() -> Int {
        let plistPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.barry.bdiff-review.plist")

        if let data = try? Data(contentsOf: plistPath),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let env = plist["EnvironmentVariables"] as? [String: String],
           let port = env["PORT"].flatMap(Int.init) {
            return port
        }

        // Fallback: parse `launchctl print` output
        let uid = getuid()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(uid)/com.barry.bdiff-review"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        guard (try? process.run()) != nil else { return devPort }
        process.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return devPort }

        for line in output.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("PORT => ") {
                return Int(trimmed.replacingOccurrences(of: "PORT => ", with: "")) ?? devPort
            }
        }
        return devPort
    }

    // MARK: - Health

    func checkHealth() async -> Bool {
        do {
            let (_, response) = try await session.data(from: baseURL.appendingPathComponent("health"))
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Comments

    func fetchComments(
        repoPath: String,
        mode: String,
        branch: String? = nil,
        commit: String? = nil
    ) async throws -> [ReviewComment] {
        var query = [
            URLQueryItem(name: "repoPath", value: repoPath),
            URLQueryItem(name: "mode", value: mode)
        ]
        if let branch { query.append(URLQueryItem(name: "branch", value: branch)) }
        if let commit { query.append(URLQueryItem(name: "commit", value: commit)) }

        let response: CommentsResponse = try await get("api/comments", query: query)
        return response.comments
    }

    /// Session-scoped comments, possibly spanning multiple repos.
    func fetchComments(sessionId: String) async throws -> [ReviewComment] {
        let query = [URLQueryItem(name: "sessionId", value: sessionId)]
        let response: CommentsResponse = try await get("api/comments", query: query)
        return response.comments
    }

    func createComment(
        repoPath: String,
        mode: String,
        branch: String?,
        commitHash: String?,
        sessionId: String? = nil,
        filePath: String,
        side: String,
        line: Int,
        lineStart: Int? = nil,
        lineContent: String,
        body: String
    ) async throws -> ReviewComment {
        let payload = CreateCommentRequest(
            repoPath: repoPath,
            mode: mode,
            branch: branch,
            commitHash: commitHash,
            sessionId: sessionId,
            filePath: filePath,
            side: side,
            line: line,
            lineStart: lineStart,
            lineContent: lineContent,
            body: body
        )
        var request = URLRequest(url: baseURL.appendingPathComponent("api/comments"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)

        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try JSONDecoder().decode(ReviewComment.self, from: data)
    }

    func deleteComment(id: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/comments/\(id)"))
        request.httpMethod = "DELETE"
        let (_, response) = try await session.data(for: request)
        try validate(response)
    }

    func reply(id: String, body: String) async throws -> ReviewReply {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/comments/\(id)/replies"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(ReplyRequest(author: "user", body: body))

        let (data, response) = try await session.data(for: request)
        try validate(response)
        return try JSONDecoder().decode(ReviewReply.self, from: data)
    }

    // MARK: - Private

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = query
        let (data, response) = try await session.data(from: components.url!)
        try validate(response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw ReviewClientError.serverError((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
    }
}

private struct CommentsResponse: Codable {
    let comments: [ReviewComment]
}

private struct CreateCommentRequest: Codable {
    let repoPath: String
    let mode: String
    let branch: String?
    let commitHash: String?
    let sessionId: String?
    let filePath: String
    let side: String
    let line: Int
    let lineStart: Int?
    let lineContent: String
    let body: String
}

private struct ReplyRequest: Codable {
    let author: String
    let body: String
}

enum ReviewClientError: LocalizedError {
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .serverError(let code): return "Review service error (\(code))"
        }
    }
}
