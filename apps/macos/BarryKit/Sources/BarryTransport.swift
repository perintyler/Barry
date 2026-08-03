import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

struct BarryAuthMiddleware: ClientMiddleware {
    let token: String?

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var authenticated = request
        if let token { authenticated.headerFields[.authorization] = "Bearer \(token)" }
        return try await next(authenticated, body, baseURL)
    }
}

/// Barry's generated transport, kept behind a small domain-oriented API so
/// app code does not depend on generator-specific operation types.
public struct BarryTransport: Sendable {
    private let client: Client

    public init(baseURL: URL, token: String?) {
        client = Client(
            serverURL: baseURL.appendingPathComponent("api/v1"),
            configuration: .init(dateTranscoder: .iso8601WithFractionalSeconds),
            transport: URLSessionTransport(),
            middlewares: [BarryAuthMiddleware(token: token)]
        )
    }

    public func listSessions(
        cursor: String? = nil,
        limit: Int? = nil,
        query: String? = nil,
        active: Bool? = nil
    ) async throws -> Components.Schemas.SessionListResponse {
        let output = try await client.listSessions(
            .init(query: .init(cursor: cursor, limit: limit, query: query, active: active))
        )
        return try output.ok.body.json
    }

    public func listProfiles() async throws -> Components.Schemas.ProfileListResponse {
        let output = try await client.listProfiles()
        return try output.ok.body.json
    }

    public func updateSession(
        id: String,
        request: Components.Schemas.UpdateSessionRequest
    ) async throws -> Components.Schemas.Session {
        let input = Operations.UpdateSession.Input(path: .init(sessionId: id), body: .json(request))
        return try await client.updateSession(input).ok.body.json
    }

    public func createProfile(
        request: Components.Schemas.CreateProfileRequest
    ) async throws -> Components.Schemas.ProfileResponse {
        let output = try await client.createProfile(.init(body: .json(request)))
        return try output.created.body.json
    }

    public func updateProfile(
        id: Int,
        request: Components.Schemas.UpdateProfileRequest
    ) async throws {
        let input = Operations.UpdateProfile.Input(
            path: .init(profileId: id),
            body: .json(request)
        )
        _ = try await client.updateProfile(input).ok.body.json
    }

    public func setDefaultProfile(id: Int) async throws {
        let input = Operations.SetDefaultProfile.Input(path: .init(profileId: id))
        _ = try await client.setDefaultProfile(input).ok.body.json
    }

    public func listAvailableBlocks() async throws -> Components.Schemas.AvailableBlocksResponse {
        try await client.listAvailableBlocks().ok.body.json
    }

    public func listTraits() async throws -> Components.Schemas.TraitListResponse {
        try await client.listTraits().ok.body.json
    }

    public func listModels() async throws -> Components.Schemas.ModelCatalogResponse {
        try await client.listModels().ok.body.json
    }

    public func listScopes() async throws -> Components.Schemas.ScopeListResponse {
        try await client.listScopes().ok.body.json
    }

    public func createScope(
        _ request: Components.Schemas.CreateScopeRequest
    ) async throws -> Components.Schemas.ScopeResponse {
        let output = try await client.createScope(.init(body: .json(request)))
        return try output.created.body.json
    }

    public func listMessages(
        sessionId: String,
        after: Int? = nil,
        before: Int? = nil,
        limit: Int? = nil,
        summary: Bool? = nil
    ) async throws -> Components.Schemas.MessageListResponse {
        let input = Operations.ListMessages.Input(
            path: .init(sessionId: sessionId),
            query: .init(after: after, before: before, limit: limit, summary: summary)
        )
        return try await client.listMessages(input).ok.body.json
    }

    public func messageDetail(
        sessionId: String,
        sequence: Int
    ) async throws -> Components.Schemas.MessageDetailResponse {
        let input = Operations.GetMessageDetail.Input(path: .init(sessionId: sessionId, sequence: sequence))
        return try await client.getMessageDetail(input).ok.body.json
    }

    public func resolvedTools(sessionId: String) async throws -> Components.Schemas.ResolvedToolsResponse {
        let input = Operations.GetResolvedSessionTools.Input(path: .init(sessionId: sessionId))
        return try await client.getResolvedSessionTools(input).ok.body.json
    }

    public func previewTools(
        sessionId: String,
        traits: String? = nil,
        namespaces: String? = nil,
        tools: String? = nil
    ) async throws -> Components.Schemas.ResolvedToolsResponse {
        let input = Operations.PreviewSessionTools.Input(
            path: .init(sessionId: sessionId),
            query: .init(traits: traits, namespaces: namespaces, tools: tools)
        )
        return try await client.previewSessionTools(input).ok.body.json
    }

    public func stopSession(sessionId: String) async throws {
        let input = Operations.StopSession.Input(path: .init(sessionId: sessionId))
        _ = try await client.stopSession(input).ok.body.json
    }

    public func searchSessions(
        query: String,
        limit: Int? = nil
    ) async throws -> Components.Schemas.SearchResponse {
        let input = Operations.SearchSessions.Input(query: .init(q: query, limit: limit))
        return try await client.searchSessions(input).ok.body.json
    }

    public func listRepoBranches() async throws -> Components.Schemas.RepoBranchesResponse {
        try await client.listRepoBranches().ok.body.json
    }

    public func repoDiff(
        path: String,
        mode: String? = nil,
        branch: String? = nil,
        commit: String? = nil
    ) async throws -> Components.Schemas.DiffResponse {
        let input = Operations.GetRepoDiff.Input(query: .init(path: path, mode: mode, branch: branch, commit: commit))
        return try await client.getRepoDiff(input).ok.body.json
    }

    public func repoGitLog(
        path: String,
        branch: String? = nil,
        limit: Int? = nil
    ) async throws -> Components.Schemas.GitLogResponse {
        let input = Operations.GetRepoGitLog.Input(query: .init(path: path, branch: branch, limit: limit))
        return try await client.getRepoGitLog(input).ok.body.json
    }
}
