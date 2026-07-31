import Foundation
import BarryKit

/// Session-specific API client. Config reading, auth, and HTTP primitives
/// live in BarryKit's `BarryCore`; this actor adds the endpoints
/// BarrySessions needs.
actor BarryClient {
    private let core = BarryCore()

    // MARK: - Health

    func checkHealth() async -> Bool {
        await core.checkHealth()
    }

    // MARK: - Sessions

    /// Fetch active (running + pending) sessions with message counts.
    func fetchActiveSessions() async throws -> [Session] {
        let response = try await core.transport.listSessions(limit: 100, active: true)
        return try decodeSessions(response.sessions)
    }

    /// Fetch recent sessions (all statuses) with pagination and message counts.
    func fetchRecentSessions(limit: Int = 20, cursor: String? = nil) async throws -> RecentSessionsResponse {
        let response = try await core.transport.listSessions(cursor: cursor, limit: limit)
        let sessions = try decodeSessions(response.sessions)
        return RecentSessionsResponse(sessions: sessions, nextCursor: response.nextCursor)
    }

    func createSession(
        prompt: String,
        repoPath: String,
        name: String?,
        profileId: Int?,
        traits: [String],
        provider: String,
        model: String?,
        useWorktree: Bool
    ) async throws -> Session {
        var body: [String: Any] = [
            "systemPrompt": prompt,
            "repoPath": repoPath,
            "traits": traits,
            "provider": provider,
            "useWorktree": useWorktree,
        ]
        if let name, !name.isEmpty { body["name"] = name }
        if let profileId { body["profileId"] = profileId }
        if let model, !model.isEmpty { body["model"] = model }

        let draft: Session = try await core.postReturning("sessions/draft", body: body)
        try await core.post("sessions/\(draft.id)/message", body: ["content": prompt])
        return draft
    }

    private func decodeSessions<T: Encodable>(_ value: T) throws -> [Session] {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try JSONDecoder().decode([Session].self, from: encoder.encode(value))
    }

    // MARK: - Traits

    func fetchTraits() async throws -> [TraitInfo] {
        try await core.fetchTraits()
    }

    // MARK: - Resolved Tools

    func fetchResolvedTools(sessionId: String) async throws -> ResolvedToolsResponse {
        try decode(try await core.transport.resolvedTools(sessionId: sessionId))
    }

    func previewTools(sessionId: String, traits: [String]) async throws -> ResolvedToolsResponse {
        try decode(try await core.transport.previewTools(
            sessionId: sessionId,
            traits: traits.joined(separator: ",")
        ))
    }

    // MARK: - Messages

    /// Fetch messages for a session. Supports pagination via `after` and `before` sequence numbers.
    /// When `summary` is true, tool call messages have truncated input and null result.
    func fetchMessages(sessionId: String, after: Int? = nil, before: Int? = nil, limit: Int = 50, summary: Bool = false) async throws -> MessagesResponse {
        try decode(try await core.transport.listMessages(
            sessionId: sessionId,
            after: after,
            before: before,
            limit: limit,
            summary: summary
        ))
    }

    /// Fetch full input/result for a single tool call message (lazy detail loading).
    func fetchMessageDetail(sessionId: String, sequence: Int) async throws -> MessageDetailResponse {
        try decode(try await core.transport.messageDetail(sessionId: sessionId, sequence: sequence))
    }

    // MARK: - Update Session

    /// Update a session's traits and direct namespace/tool picks.
    func updateSession(
        sessionId: String,
        traits: [String],
        selectedNamespaces: [String],
        selectedTools: [String]
    ) async throws {
        try await patchSession(sessionId: sessionId, body: [
            "traits": traits,
            "selectedNamespaces": selectedNamespaces,
            "selectedTools": selectedTools,
        ])
    }

    /// Rename a session.
    func renameSession(sessionId: String, name: String) async throws {
        try await patchSession(sessionId: sessionId, body: ["name": name])
    }

    /// Update session scope (e.g. read-only mode).
    func updateScope(sessionId: String, scope: [String: Any]) async throws {
        try await patchSession(sessionId: sessionId, body: ["scope": scope])
    }

    /// Update pinned state.
    func updatePinned(sessionId: String, pinned: Bool) async throws {
        try await patchSession(sessionId: sessionId, body: ["pinned": pinned])
    }

    /// Set the session's model (applies on next start/resume). nil clears it.
    func setModel(sessionId: String, model: String?) async throws {
        try await patchSession(sessionId: sessionId, body: ["model": model ?? NSNull()])
    }

    /// Stop a running session.
    func stopSession(sessionId: String) async throws {
        try await core.transport.stopSession(sessionId: sessionId)
    }

    // MARK: - Search

    /// Fuzzy search messages across all sessions.
    func searchMessages(query: String, limit: Int = 20) async throws -> [SearchResult] {
        let response: SearchResponse = try decode(
            try await core.transport.searchSessions(query: query, limit: limit)
        )
        return response.results
    }

    // MARK: - Models

    func fetchModels() async throws -> [String: ProviderModels] {
        try await core.fetchModels()
    }

    // MARK: - Profiles

    func fetchProfileDefaults() async throws -> [ProfileDefaults] {
        try await core.fetchProfileDefaults()
    }

    private func decode<T: Decodable, U: Encodable>(_ value: U) throws -> T {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try JSONDecoder().decode(T.self, from: encoder.encode(value))
    }

    private func patchSession(sessionId: String, body: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: body)
        let request = try JSONDecoder().decode(Components.Schemas.UpdateSessionRequest.self, from: data)
        _ = try await core.transport.updateSession(id: sessionId, request: request)
    }
}
