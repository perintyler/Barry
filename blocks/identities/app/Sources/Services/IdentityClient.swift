import Foundation
import BarryKit

/// Identity-specific API client. Config reading, auth, and HTTP primitives
/// live in BarryKit's `BarryCore`; this actor adds the endpoints
/// My Identities needs.
///
/// The transport methods keep their `…Profile` names because they're
/// generated from the OpenAPI spec, whose wire format still says `profiles`.
actor IdentityClient {
    private let core = BarryCore()

    // MARK: - Health

    func checkHealth() async -> Bool {
        await core.checkHealth()
    }

    // MARK: - Identities

    func fetchIdentities() async throws -> [Identity] {
        let response = try await core.transport.listIdentities()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try JSONDecoder().decode([Identity].self, from: encoder.encode(response.identities))
    }

    func createIdentity(body: [String: Any]) async throws -> Identity {
        let data = try JSONSerialization.data(withJSONObject: body)
        let request = try JSONDecoder().decode(Components.Schemas.CreateIdentityRequest.self, from: data)
        let response = try await core.transport.createIdentity(request: request)
        return try JSONDecoder().decode(Identity.self, from: JSONEncoder().encode(response.identity))
    }

    /// Returns the server's non-fatal warnings, already formatted for display.
    @discardableResult
    func updateIdentity(id: Int, body: [String: Any]) async throws -> [String] {
        let data = try JSONSerialization.data(withJSONObject: body)
        let request = try JSONDecoder().decode(Components.Schemas.UpdateIdentityRequest.self, from: data)
        let warnings = try await core.transport.updateIdentity(id: id, request: request)
        return warnings.map { warning in
            guard let hint = warning.hint, !hint.isEmpty else { return warning.message }
            return "\(warning.message) — \(hint)"
        }
    }

    func setActiveIdentity(id: Int) async throws {
        try await core.transport.setActiveIdentity(id: id)
    }

    // MARK: - Traits

    func fetchTraits() async throws -> [TraitInfo] {
        try await core.fetchTraits()
    }

    // MARK: - Scopes

    func fetchScopes() async throws -> [ScopeRecord] {
        let response = try await core.transport.listScopes()
        return try decode(response.scopes)
    }

    func createScope(name: String, description: String?, scope: ScopeRecord.AgentScope) async throws -> ScopeRecord {
        var bodyDict: [String: Any] = ["name": name]
        if let desc = description { bodyDict["description"] = desc }

        var scopeDict: [String: Any] = [:]
        if let tools = scope.deniedTools, !tools.isEmpty { scopeDict["deniedTools"] = tools }
        if let access = scope.deniedAccess, !access.isEmpty { scopeDict["deniedAccess"] = access }
        if let deny = scope.files?.deny, !deny.isEmpty { scopeDict["files"] = ["deny": deny] }
        if let deny = scope.bash?.deny, !deny.isEmpty { scopeDict["bash"] = ["deny": deny] }
        bodyDict["scope"] = scopeDict

        let data = try JSONSerialization.data(withJSONObject: bodyDict)
        let request = try JSONDecoder().decode(Components.Schemas.CreateScopeRequest.self, from: data)
        let response = try await core.transport.createScope(request)
        return try decode(response.scope)
    }

    // MARK: - Blocks

    func fetchAvailableBlocks() async throws -> [BlockInfo] {
        try decode(try await core.transport.listAvailableBlocks().blocks)
    }

    // MARK: - Models

    func fetchModels() async throws -> [String: ProviderModels] {
        try await core.fetchModels()
    }

    private func decode<T: Decodable, U: Encodable>(_ value: U) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
    }
}
