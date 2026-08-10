import Foundation

/// One entry in the curated model catalog served by `GET /models`.
/// The catalog is advisory — unknown model IDs are still valid everywhere.
public struct ModelInfo: Decodable, Hashable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// Per-provider slice of the model catalog.
public struct ProviderModels: Decodable {
    /// Model used when neither the session nor the profile specifies one
    /// (nil = the provider's own CLI decides).
    public let `default`: String?
    /// Fast/cheap model for internal calls.
    public let small: String?
    public let models: [ModelInfo]
}

public extension BarryCore {
    /// Curated per-provider model catalog (`GET /models`).
    func fetchModels() async throws -> [String: ProviderModels] {
        let response = try await transport.listModels()
        return try JSONDecoder().decode(
            [String: ProviderModels].self,
            from: JSONEncoder().encode(response.providers)
        )
    }
}
