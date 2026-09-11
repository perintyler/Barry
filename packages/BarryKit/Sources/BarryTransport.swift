import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// Errors raised by the transport itself, rather than by the generated client.
public enum BarryTransportError: Error, LocalizedError {
    /// A response the contract does not describe, and which does not look like
    /// a success. Carries the generator's description so the status is visible.
    case undescribedResponse(String)

    public var errorDescription: String? {
        switch self {
        case let .undescribedResponse(description):
            return "The API returned an unexpected response: \(description)"
        }
    }
}

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
public struct IdentityTransport: Sendable {
    private let client: Client

    public init(baseURL: URL, token: String?) {
        client = Client(
            serverURL: baseURL.appendingPathComponent("api/v1"),
            configuration: .init(dateTranscoder: .iso8601WithFractionalSeconds),
            transport: URLSessionTransport(),
            middlewares: [BarryAuthMiddleware(token: token)]
        )
    }

    /// - Parameter hasMessages: when true, the server omits sessions with no
    ///   messages. A caller that hides them should pass it rather than filter
    ///   client-side: otherwise a long run of message-less rows looks like a
    ///   page that gained nothing while the cursor still says "more".
    public func listSessions(
        cursor: String? = nil,
        limit: Int? = nil,
        query: String? = nil,
        active: Bool? = nil,
        hasMessages: Bool? = nil
    ) async throws -> Components.Schemas.SessionListResponse {
        let output = try await client.listSessions(
            .init(
                query: .init(
                    cursor: cursor,
                    limit: limit,
                    query: query,
                    active: active,
                    hasMessages: hasMessages
                )
            )
        )
        return try output.ok.body.json
    }

    public func listIdentities() async throws -> Components.Schemas.IdentityListResponse {
        let output = try await client.listIdentities()
        return try output.ok.body.json
    }

    /// Recorded action runs, newest first.
    ///
    /// Deliberately carries no deliverables: fifty wrap-up reports is megabytes
    /// of markdown nobody asked for, so the list reports `hasOutput` and a
    /// caller fetches the one run it wants with `getActionRun`.
    public func listActionRuns(
        action: String? = nil,
        status: Operations.ListActionRuns.Input.Query.StatusPayload? = nil,
        sessionId: String? = nil,
        limit: Int? = nil
    ) async throws -> Components.Schemas.ActionRunListResponse {
        let output = try await client.listActionRuns(
            .init(query: .init(sessionId: sessionId, action: action, status: status, limit: limit))
        )
        return try output.ok.body.json
    }

    /// One run in full — the deliverable AND the `metadata` carrying the input
    /// side (the inputs it was called with, and the composed prompt). This is
    /// the only endpoint that returns either, which is what makes a run
    /// readable end to end rather than output-only.
    public func getActionRun(id: String) async throws -> Components.Schemas.ActionRunDetail {
        let output = try await client.getActionRun(.init(path: .init(runId: id)))
        return try output.ok.body.json
    }

    /// Every action installed, with `executable` marking the ones that can run
    /// detached. Unlike `find_actions` this is not filtered by session traits —
    /// a GUI has no session, and the MCP layer is the real enforcement.
    public func listActionCatalog() async throws -> Components.Schemas.ActionCatalogResponse {
        try await client.listActionCatalog().ok.body.json
    }

    /// Create a session set up to run an action.
    ///
    /// This does NOT spawn the agent — it returns a draft session and the
    /// prompt to send it. Sending is a second call (`sendSessionMessage`) so a
    /// caller can subscribe to the session's socket in between and miss no
    /// early output, the same order the CLI's codex path uses.
    public func triggerAction(
        _ request: Components.Schemas.TriggerActionRequest
    ) async throws -> Components.Schemas.TriggerActionResponse {
        try await client.triggerAction(.init(body: .json(request))).created.body.json
    }

    /// Send a message to a session, spawning the agent when none is running.
    ///
    /// The body carries only `content` and `repoPath` — the schema is strict
    /// and rejects provider/model, which is why those belong on the draft.
    ///
    /// Returns nothing: the spawn is acknowledged rather than described.
    /// Progress is observed by watching the run appear, not by this call.
    ///
    /// The contract declares only 202, but the route replies with
    /// `res.json(...)` — a 200. Insisting on `.accepted` would therefore throw
    /// on every SUCCESSFUL send. Both are accepted here, and only a genuine
    /// error status becomes an error. (Correcting the contract is the real
    /// fix, but it is frozen and shared with barry.works.)
    public func sendSessionMessage(
        sessionId: String,
        content: String,
        repoPath: String? = nil
    ) async throws {
        let input = Operations.SendMessage.Input(
            path: .init(sessionId: sessionId),
            body: .json(.init(content: content, repoPath: repoPath))
        )
        let output = try await client.sendMessage(input)
        switch output {
        case .ok:
            return
        default:
            // Covers the contract's `default` problem response and any status
            // it does not describe. Both are failures — the send did not land.
            throw BarryTransportError.undescribedResponse(String(describing: output))
        }
    }

    public func updateSession(
        id: String,
        request: Components.Schemas.UpdateSessionRequest
    ) async throws -> Components.Schemas.Session {
        let input = Operations.UpdateSession.Input(path: .init(sessionId: id), body: .json(request))
        return try await client.updateSession(input).ok.body.json
    }

    public func createIdentity(
        request: Components.Schemas.CreateIdentityRequest
    ) async throws -> Components.Schemas.IdentityResponse {
        let output = try await client.createIdentity(.init(body: .json(request)))
        return try output.created.body.json
    }

    /// Returns any non-fatal warnings the server reported alongside the update.
    /// The API accepts values it can't vouch for — an off-catalog model id, a
    /// bag whose binary is missing — and reports them here rather than
    /// failing, so a caller that drops these leaves the user with no signal.
    @discardableResult
    public func updateIdentity(
        id: Int,
        request: Components.Schemas.UpdateIdentityRequest
    ) async throws -> [Components.Schemas.IdentityResponse.WarningsPayloadPayload] {
        let input = Operations.UpdateIdentity.Input(
            path: .init(identityId: id),
            body: .json(request)
        )
        return try await client.updateIdentity(input).ok.body.json.warnings ?? []
    }

    public func setActiveIdentity(id: Int) async throws {
        let input = Operations.SetActiveIdentity.Input(path: .init(identityId: id))
        _ = try await client.setActiveIdentity(input).ok.body.json
    }

    /// Create a hand-authored trait. Stays bag-less so a bag sync can't
    /// reconcile it away.
    public func createTrait(
        request: Components.Schemas.CreateTraitRequest
    ) async throws -> Components.Schemas.TraitResponse {
        try await client.createTrait(.init(body: .json(request))).created.body.json
    }

    /// Edit a scope's description and deny rules. The name is fixed — traits
    /// reference scopes by name, so renaming detaches them.
    public func updateScope(
        id: Int,
        request: Components.Schemas.UpdateScopeRequest
    ) async throws -> Components.Schemas.ScopeResponse {
        try await client.updateScope(.init(path: .init(scopeId: id), body: .json(request))).ok.body.json
    }

    /// Re-read a single identity, for refreshing a detail view after a write.
    public func getIdentity(id: Int) async throws -> Components.Schemas.IdentityResponse {
        let input = Operations.GetIdentity.Input(path: .init(identityId: id))
        return try await client.getIdentity(input).ok.body.json
    }

    /// Delete a DB-backed identity.
    ///
    /// The server refuses this for a file-based Barry — that one is a directory
    /// the user owns — and answers 400, which surfaces here as a thrown error
    /// carrying the server's explanation.
    public func deleteIdentity(id: Int) async throws {
        let input = Operations.DeleteIdentity.Input(path: .init(identityId: id))
        _ = try await client.deleteIdentity(input).ok.body.json
    }

    public func listAvailableBags() async throws -> Components.Schemas.AvailableBagsResponse {
        try await client.listAvailableBags().ok.body.json
    }

    /// `identityId` narrows the list to the bags that barry holds. Omit it
    /// before a barry is chosen and the server returns the registry-wide list.
    public func listTraits(identityId: Int? = nil) async throws -> Components.Schemas.TraitListResponse {
        try await client.listTraits(query: .init(identityId: identityId)).ok.body.json
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
