import Foundation
import BarryKit

/// Profile-specific API client. Config reading, auth, and HTTP primitives
/// live in BarryKit's `BarryCore`; this actor adds the endpoints
/// BarryProfiles needs.
actor BarryClient {
    private let core = BarryCore()

    // MARK: - Health

    func checkHealth() async -> Bool {
        await core.checkHealth()
    }

    // MARK: - Profiles

    func fetchProfiles() async throws -> [Profile] {
        let response = try await core.transport.listProfiles()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try JSONDecoder().decode([Profile].self, from: encoder.encode(response.profiles))
    }

    func createProfile(body: [String: Any]) async throws -> Profile {
        let data = try JSONSerialization.data(withJSONObject: body)
        let request = try JSONDecoder().decode(Components.Schemas.CreateProfileRequest.self, from: data)
        let response = try await core.transport.createProfile(request: request)
        return try JSONDecoder().decode(Profile.self, from: JSONEncoder().encode(response.profile))
    }

    func updateProfile(id: Int, body: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: body)
        let request = try JSONDecoder().decode(Components.Schemas.UpdateProfileRequest.self, from: data)
        try await core.transport.updateProfile(id: id, request: request)
    }

    func setDefaultProfile(id: Int) async throws {
        try await core.transport.setDefaultProfile(id: id)
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
